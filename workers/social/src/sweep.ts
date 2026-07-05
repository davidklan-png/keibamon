// ADR-0007 Phase 4 + R3 — cron settle sweep.
//
// The 45s client poll in App.tsx is the fast path: when a signed-in user
// has an OPEN ticket and `/api/live` reports the race as `status === 'result'`,
// the client resolves + PATCHes immediately. This module is the BACKSTOP for
// users who were offline at post-time — every 5 min UTC (see wrangler.jsonc
// `triggers.crons`) the Worker fetches `/api/live` from the racing Worker and
// resolves any OPEN ticket whose race has a result block.
//
// **R3 — re-settlement on result change.** Settlement is now a PURE FUNCTION
// of (ticket, current result) rather than a one-way latch. Each ticket row
// carries `settle_result_hash` — SHA-256 of the resolver-relevant fields of
// the result block it was settled against. On every sweep we re-fetch the
// result, hash it, and if the hash differs from the stored one we re-resolve
// the ticket and UPDATE its state/returned/hash. R2's 確定 gate stays
// authoritative — only official results attach, so re-settlement reconciles
// partial→complete and any rare 確定 correction, never provisional flapping.
//
// The sweep is idempotent (same result hash → no UPDATE), bounded
// (SWEEP_CAP per run — one race day's worth), and never throws — a sweep
// failure is recoverable on the next tick. It doesn't fetch its own origin:
// it calls D1 directly + the resolver.
//
// LIVE_BASE: the racing Worker URL (no trailing slash). Set via
// `wrangler secret put LIVE_BASE`. Empty/missing → sweep logs a warning and
// no-ops (so a misconfigured deploy degrades gracefully rather than
// stranding the cron).

import {
  resolveTicket,
  topPlacings,
  hashResult,
  type BetType,
  type RaceResult,
  type ResolveTicket,
} from "./settle";

// hashResult moved to settle.ts (R5) so it's importable from a plain Node
// script without pulling in this module's D1Database / Cloudflare `fetch`
// types — see workers/social/scripts/backfill-stuck-tickets.ts. Re-exported
// here so existing imports (`from "./sweep"`, sweep.test.ts) don't need to change.
export { hashResult };

/** Cap per sweep — one race day's worth of tickets is well under this. */
const SWEEP_CAP = 200;

/**
 * Shape of `/api/live` we consume. Mirrors `frontend/src/api.ts:LiveSnapshot`
 * + `LiveRace` but minimal — we only need the fields used to key+settle.
 * Kept here (not imported from the frontend) so the worker package stays
 * self-contained.
 */
interface LiveSnapshot {
  meta?: { date?: string };
  races?: Array<{
    date?: string;
    race_no: number;
    name?: string | null;
    venue?: string | null;
    status?: string;
    result?: RaceResult | null;
  }>;
}

/**
 * Verbatim CommittedTicket payload fields the sweep reads. Mirrors the
 * columns `parseTicketBody` validates on POST. The rest of the payload is
 * opaque to the sweep (same contract as the rest of the Worker).
 */
interface TicketPayload {
  ticket?: {
    type?: BetType;
    lines?: { combo: string[] }[];
    avgPayout?: number;
  };
  unit?: number;
}

/** Row shape the sweep SELECTs from D1 (open + settled, for finished races). */
interface TicketRow {
  id: string;
  race_key: string;
  payload: string;
  state: string;
  returned: number | null;
  settle_result_hash: string | null;
}

/** Build the same race_key the frontend's `mtRaceKey` / `keyFor` produce. */
function raceKeyOf(
  race: LiveSnapshot["races"] extends (infer T)[] | undefined ? T : never,
  fallbackDate: string,
): string {
  const date = (race.date ?? fallbackDate ?? "") as string;
  return `${date}|${race.venue ?? ""}|${race.race_no}|${race.name ?? ""}`;
}

/** Short hash prefix for log lines (full hash is in D1 for audit). */
function shortHash(h: string | null | undefined): string {
  return h ? h.slice(0, 8) : "(none)";
}

/** Render an outcome for logs: "won(2160)" / "miss" / "refunded". */
function formatOutcome(state: string, returned: number | null): string {
  if (state === "won") return `won(${returned ?? 0})`;
  return state;
}

/** Render a transition: "won(2160) -> miss" / "miss -> won(2200)" / "(backfill)". */
function formatTransition(
  prevState: string,
  prevReturned: number | null,
  newState: string,
  newReturned: number | null,
): string {
  return `${formatOutcome(prevState, prevReturned)} -> ${formatOutcome(newState, newReturned)}`;
}

/**
 * Apply a sweep settlement (initial or re-settlement). Unlike
 * `patchTicketState` (the client-PATCH helper that guards `state='open'`),
 * this writes unconditionally on `id` so the sweep can correct a previously
 * settled row. Concurrency note: cron sweeps are unlikely to overlap (5-min
 * cadence, ms-scale work), and two overlapping sweeps would write identical
 * values (both compute the same hash + outcome), so the lack of CAS is safe.
 *
 * Returns true iff a row was actually updated.
 */
async function applySweepSettlement(
  db: D1Database,
  id: string,
  state: "won" | "miss" | "refunded",
  returned: number | null,
  resultHash: string,
  placings: string | null,
): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `UPDATE tickets
          SET state = ?, returned = ?, settle_result_hash = ?, placings = ?
        WHERE id = ?`,
    )
    .bind(state, returned, resultHash, placings, id)
    .run();
  const changes = (meta as { changes?: number } | null)?.changes ?? 0;
  return changes > 0;
}

/**
 * Fetch `/api/live`, walk tickets for finished races, and resolve each
 * against its race's result block. Idempotent (same result hash → no UPDATE);
 * bounded by SWEEP_CAP. Logs a summary line; never throws — a sweep failure
 * is recoverable on the next tick.
 *
 * Two paths:
 *   - OPEN ticket + result-available  → initial settle, write hash.
 *   - Settled ticket + hash changed   → re-settle, log transition, update hash.
 *   - Settled ticket + hash unchanged → idempotent skip.
 *
 * Returns counts (for observability / tests).
 */
export async function settleSweep(
  env: { DB: D1Database; LIVE_BASE?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ scanned: number; settled: number; reSettled: number; deferred: boolean }> {
  if (!env.LIVE_BASE) {
    console.warn("settleSweep: LIVE_BASE not set; sweep is a no-op");
    return { scanned: 0, settled: 0, reSettled: 0, deferred: false };
  }

  let snap: LiveSnapshot;
  try {
    const res = await fetchImpl(`${env.LIVE_BASE}/api/live`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0 } as Record<string, unknown>,
    });
    if (!res.ok) {
      console.warn(`settleSweep: /api/live returned HTTP ${res.status}`);
      return { scanned: 0, settled: 0, reSettled: 0, deferred: false };
    }
    snap = (await res.json()) as LiveSnapshot;
  } catch (e) {
    console.warn(`settleSweep: /api/live fetch failed: ${(e as Error).message}`);
    return { scanned: 0, settled: 0, reSettled: 0, deferred: false };
  }
  if (!snap.races || snap.races.length === 0) {
    return { scanned: 0, settled: 0, reSettled: 0, deferred: false };
  }

  // Index races by race_key + pre-compute the result hash for finished races.
  // The hash is the re-settlement trigger: if a ticket's stored hash differs,
  // the result has changed (partial → complete, or a 確定 correction) and we
  // re-resolve the ticket against the current result.
  const fallbackDate = snap.meta?.date ?? "";
  const raceByKey = new Map<
    LiveSnapshot["races"] extends (infer T)[] | undefined ? T : never,
    unknown
  >() as unknown as Map<string, LiveSnapshot["races"] extends (infer T)[] | undefined ? T : never>;
  const hashByKey = new Map<string, string>();
  const resultRaceKeys: string[] = [];
  for (const r of snap.races) {
    const k = raceKeyOf(r, fallbackDate) as unknown as string;
    (raceByKey as unknown as Map<string, unknown>).set(k, r);
    if (r.status === "result" && r.result) {
      resultRaceKeys.push(k);
      hashByKey.set(k, await hashResult(r.result));
    }
  }

  if (resultRaceKeys.length === 0) {
    return { scanned: 0, settled: 0, reSettled: 0, deferred: false };
  }

  // SELECT all tickets (open + settled) for races the snapshot reports as
  // finished. Settled tickets for races NOT in the snapshot are left alone —
  // we can't re-settle what we can't see, and an old settled ticket isn't
  // blocking anything.
  const placeholders = resultRaceKeys.map(() => "?").join(",");
  const { results } = await env.DB
    .prepare(
      `SELECT id, race_key, payload, state, returned, settle_result_hash
         FROM tickets
        WHERE race_key IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(...resultRaceKeys, SWEEP_CAP + 1)
    .all<TicketRow>();
  const deferred = results.length > SWEEP_CAP;
  const scanRows = deferred ? results.slice(0, SWEEP_CAP) : results;

  let settled = 0;
  let reSettled = 0;
  for (const row of scanRows) {
    const race = (raceByKey as unknown as Map<string, unknown>).get(row.race_key) as
      | (LiveSnapshot["races"] extends (infer T)[] | undefined ? T : never)
      | undefined;
    if (!race || race.status !== "result") continue;
    const result = (race.result ?? null) as RaceResult | null;
    const currentHash = hashByKey.get(row.race_key);
    if (!currentHash || !result) continue;

    let payload: TicketPayload;
    try {
      payload = JSON.parse(row.payload) as TicketPayload;
    } catch {
      continue; // malformed payload — leave for human triage
    }
    const ticket = payload.ticket;
    if (!ticket || !ticket.type || !Array.isArray(ticket.lines)) continue;
    const unit = typeof payload.unit === "number" && payload.unit > 0 ? payload.unit : 100;

    const resolveInput: ResolveTicket = {
      type: ticket.type,
      lines: ticket.lines,
      // avgPayout is the commit-time fair-value estimate; if absent, fall
      // back to a sane default so the resolver doesn't crash.
      avgPayout: typeof ticket.avgPayout === "number" ? ticket.avgPayout : 0,
    };
    const outcome = resolveTicket(resolveInput, unit, result);
    if (outcome.state === "open") continue; // result block not populated yet

    const newState = outcome.state as "won" | "miss" | "refunded";
    const newReturned = outcome.state === "won" ? outcome.returned : null;
    // R5: capture the finish order alongside the settlement so the ticket
    // detail view can show it later even after this race ages out of
    // /api/live's rolling window (the only other place it'd come from).
    const placings = topPlacings(result);
    const newPlacings = placings ? JSON.stringify(placings) : null;

    if (row.state === "open") {
      // First settlement (the original Phase 4 path).
      const didUpdate = await applySweepSettlement(
        env.DB, row.id, newState, newReturned, currentHash, newPlacings,
      );
      if (didUpdate) {
        settled++;
        console.log(
          `settleSweep: settled ${row.id} open -> ${formatOutcome(newState, newReturned)} ` +
          `[hash ${shortHash(currentHash)}]`,
        );
      }
    } else if (row.settle_result_hash !== currentHash) {
      // Re-settlement: the result has changed since we last settled this ticket.
      // Common case: partial publish → complete publish. Rare case: a 確定
      // correction. Either way, re-resolve against the CURRENT result and
      // update state/returned/hash in one row.
      const didUpdate = await applySweepSettlement(
        env.DB, row.id, newState, newReturned, currentHash, newPlacings,
      );
      if (didUpdate) {
        reSettled++;
        const stateChanged = row.state !== newState;
        const amountChanged = row.returned !== newReturned;
        const kind = stateChanged ? "state" : amountChanged ? "amount" : "hash-only";
        console.log(
          `settleSweep: re-settled ${row.id} ` +
          `${formatTransition(row.state, row.returned, newState, newReturned)} ` +
          `(${kind}) [hash ${shortHash(row.settle_result_hash)} -> ${shortHash(currentHash)}]`,
        );
      }
    }
    // else: settled against the same result hash already — idempotent skip.
  }

  console.log(
    `settleSweep: settled ${settled} + re-settled ${reSettled} of ${scanRows.length} tickets` +
      (deferred ? ` (${results.length - SWEEP_CAP} deferred to next tick)` : ""),
  );
  return { scanned: scanRows.length, settled, reSettled, deferred };
}
