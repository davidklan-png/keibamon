// ADR-0007 Phase 4 + R3 + #15 — cron settle sweep.
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
// **#15 — results archive for rotated-off races.** The snapshot pass alone
// can't settle tickets whose race has aged out of /api/live's rolling window
// (the publisher overwrites that single row when next weekend's card goes
// up). The sweep now ARCHIVEs every snapshot result race into `race_results`
// (hash-gated upsert — steady state is zero writes) before settling, then
// runs a FALLBACK pass: OPEN tickets whose race_key isn't in the snapshot
// but IS in race_results get settled against the archived result, with
// identical resolver/hash bookkeeping. Already-settled tickets stay
// snapshot-window-only — the "left alone unless open" rule. SWEEP_CAP bounds
// the combined work across both passes.
//
// The sweep is idempotent (same result hash → no UPDATE), bounded
// (SWEEP_CAP per run across both passes — one race day's worth), and never
// throws — a sweep failure is recoverable on the next tick. It doesn't fetch
// its own origin:
// it calls D1 directly + the resolver.
//
// LIVE_BASE: the racing Worker URL (no trailing slash). Set via
// `wrangler secret put LIVE_BASE`. Empty/missing → sweep logs a warning and
// no-ops (so a misconfigured deploy degrades gracefully rather than
// stranding the cron).

import { NOW, RATE_WINDOW } from "./core";
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
interface SnapshotRace {
  date?: string;
  race_no: number;
  name?: string | null;
  venue?: string | null;
  status?: string;
  result?: RaceResult | null;
}

interface LiveSnapshot {
  meta?: { date?: string };
  races?: SnapshotRace[];
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

/**
 * #15 — Row shape the fallback pass SELECTs. Joins `tickets` to
 * `race_results` so a single query carries both the ticket state and the
 * archived result block + hash. Same TicketRow fields plus the archive cols.
 */
interface ArchiveTicketRow extends TicketRow {
  result_json: string;
  result_hash: string;
}

/** Build the same race_key the frontend's `mtRaceKey` / `keyFor` produce. */
function raceKeyOf(race: SnapshotRace, fallbackDate: string): string {
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
 * Resolve a single ticket against a result + apply the settlement UPDATE.
 * Shared by the snapshot pass and the #15 fallback pass — identical math,
 * identical hash bookkeeping. `source` only flows into the log line so an
 * operator reading the Worker tail can tell which pass fired.
 *
 *   - row.state === 'open'        → first settlement, log "open -> outcome".
 *   - row.state settled, hash ≠   → re-settlement (R3), log transition.
 *   - row.state settled, hash =   → idempotent skip (no UPDATE).
 *
 * Returns which kind of settlement happened (if any).
 */
async function trySettle(
  db: D1Database,
  row: TicketRow,
  result: RaceResult,
  currentHash: string,
  source: "snapshot" | "archive",
): Promise<{ settled: boolean; reSettled: boolean }> {
  let payload: TicketPayload;
  try {
    payload = JSON.parse(row.payload) as TicketPayload;
  } catch {
    return { settled: false, reSettled: false }; // malformed — leave for human triage
  }
  const ticket = payload.ticket;
  if (!ticket || !ticket.type || !Array.isArray(ticket.lines)) {
    return { settled: false, reSettled: false };
  }
  const unit = typeof payload.unit === "number" && payload.unit > 0 ? payload.unit : 100;
  const resolveInput: ResolveTicket = {
    type: ticket.type,
    lines: ticket.lines,
    avgPayout: typeof ticket.avgPayout === "number" ? ticket.avgPayout : 0,
  };
  const outcome = resolveTicket(resolveInput, unit, result);
  if (outcome.state === "open") return { settled: false, reSettled: false };

  const newState = outcome.state as "won" | "miss" | "refunded";
  const newReturned = outcome.state === "won" ? outcome.returned : null;
  const placings = topPlacings(result);
  const newPlacings = placings ? JSON.stringify(placings) : null;
  const sourceTag = `[${source}]`;

  if (row.state === "open") {
    const didUpdate = await applySweepSettlement(
      db, row.id, newState, newReturned, currentHash, newPlacings,
    );
    if (didUpdate) {
      console.log(
        `settleSweep: settled ${row.id} open -> ${formatOutcome(newState, newReturned)} ` +
        `${sourceTag} [hash ${shortHash(currentHash)}]`,
      );
      return { settled: true, reSettled: false };
    }
  } else if (row.settle_result_hash !== currentHash) {
    const didUpdate = await applySweepSettlement(
      db, row.id, newState, newReturned, currentHash, newPlacings,
    );
    if (didUpdate) {
      const stateChanged = row.state !== newState;
      const amountChanged = row.returned !== newReturned;
      const kind = stateChanged ? "state" : amountChanged ? "amount" : "hash-only";
      console.log(
        `settleSweep: re-settled ${row.id} ` +
        `${formatTransition(row.state, row.returned, newState, newReturned)} ` +
        `(${kind}) ${sourceTag} [hash ${shortHash(row.settle_result_hash)} -> ${shortHash(currentHash)}]`,
      );
      return { settled: false, reSettled: true };
    }
  }
  // else: settled against the same hash already — idempotent skip.
  return { settled: false, reSettled: false };
}

/**
 * #15 — Upsert every snapshot result race into the `race_results` archive.
 * Hash-gated via ON CONFLICT ... WHERE result_hash differs, so steady state
 * (re-sweeping the same result) is zero writes. Never throws — a write
 * failure is recoverable on the next tick.
 *
 * Returns the number of rows actually written (changed).
 */
async function archiveResults(
  db: D1Database,
  raceByKey: Map<string, SnapshotRace>,
  hashByKey: Map<string, string>,
): Promise<number> {
  let archived = 0;
  const now = Date.now();
  for (const [k, race] of raceByKey.entries()) {
    if (race.status !== "result" || !race.result) continue;
    const hash = hashByKey.get(k);
    if (!hash) continue;
    const resultJson = JSON.stringify(race.result);
    try {
      const { meta } = await db
        .prepare(
          `INSERT INTO race_results (race_key, result_json, result_hash, source, archived_at)
           VALUES (?, ?, ?, 'sweep', ?)
           ON CONFLICT(race_key) DO UPDATE
             SET result_json = excluded.result_json,
                 result_hash = excluded.result_hash,
                 source = excluded.source,
                 archived_at = excluded.archived_at
           WHERE race_results.result_hash != excluded.result_hash`,
        )
        .bind(k, resultJson, hash, now)
        .run();
      const changes = (meta as { changes?: number } | null)?.changes ?? 0;
      if (changes > 0) archived++;
    } catch (e) {
      console.warn(`archiveResults: failed to archive ${k}: ${(e as Error).message}`);
    }
  }
  return archived;
}

/**
 * Fetch `/api/live`, walk tickets for finished races, and resolve each
 * against its race's result block. Idempotent (same result hash → no UPDATE);
 * bounded by SWEEP_CAP across both passes. Logs a summary line; never throws
 * — a sweep failure is recoverable on the next tick.
 *
 * Two passes, sharing one SWEEP_CAP budget:
 *
 *   1. SNAPSHOT pass — settle/re-settle tickets whose race is in the current
 *      /api/live snapshot. OPEN tickets get their first settlement; already-
 *      settled tickets get re-settled if their stored hash differs (R3).
 *
 *   2. FALLBACK pass (#15) — settle OPEN tickets whose race has rotated off
 *      /api/live, joining against the `race_results` archive populated by
 *      earlier sweeps (and by the recovery importer after capture outages).
 *      Re-settlement of already-settled tickets stays snapshot-window-only
 *      — the "left alone unless open" rule.
 *
 * Before either pass, every snapshot result race is upserted into
 * `race_results` (hash-gated, zero writes at steady state) so a later sweep
 * can settle it from the archive once /api/live moves on.
 *
 * Returns counts (for observability / tests).
 */
export async function settleSweep(
  env: { DB: D1Database; LIVE_BASE?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{
  scanned: number;
  settled: number;
  reSettled: number;
  archived: number;
  deferred: boolean;
}> {
  if (!env.LIVE_BASE) {
    console.warn("settleSweep: LIVE_BASE not set; sweep is a no-op");
    return { scanned: 0, settled: 0, reSettled: 0, archived: 0, deferred: false };
  }

  // rate_limits TTL: rows are bucketed per RATE_WINDOW (60s). Prune every
  // bucket older than the current window so the table can't grow unbounded.
  // Rides this existing 5-min cron — no new timer / KV / DO. Best-effort: a
  // failure must never block settlement.
  try {
    const cutoff = Math.floor(NOW() / RATE_WINDOW);
    await env.DB.prepare("DELETE FROM rate_limits WHERE bucket < ?").bind(cutoff).run();
  } catch (e) {
    console.warn(`settleSweep: rate_limit TTL prune failed: ${(e as Error).message}`);
  }

  let snap: LiveSnapshot;
  try {
    const res = await fetchImpl(`${env.LIVE_BASE}/api/live`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0 } as Record<string, unknown>,
    });
    if (!res.ok) {
      console.warn(`settleSweep: /api/live returned HTTP ${res.status}`);
      return { scanned: 0, settled: 0, reSettled: 0, archived: 0, deferred: false };
    }
    snap = (await res.json()) as LiveSnapshot;
  } catch (e) {
    console.warn(`settleSweep: /api/live fetch failed: ${(e as Error).message}`);
    return { scanned: 0, settled: 0, reSettled: 0, archived: 0, deferred: false };
  }
  if (!snap.races || snap.races.length === 0) {
    return { scanned: 0, settled: 0, reSettled: 0, archived: 0, deferred: false };
  }

  // Index races by race_key + pre-compute the result hash for finished races.
  // The hash is the re-settlement trigger: if a ticket's stored hash differs,
  // the result has changed (partial → complete, or a 確定 correction) and we
  // re-resolve the ticket against the current result.
  const fallbackDate = snap.meta?.date ?? "";
  const raceByKey = new Map<string, SnapshotRace>();
  const hashByKey = new Map<string, string>();
  const resultRaceKeys: string[] = [];
  for (const r of snap.races) {
    const k = raceKeyOf(r, fallbackDate);
    raceByKey.set(k, r);
    if (r.status === "result" && r.result) {
      resultRaceKeys.push(k);
      hashByKey.set(k, await hashResult(r.result));
    }
  }

  // #15: ARCHIVE every snapshot result race before settling — even a sweep
  // that settles nothing (all tickets already settled, or no tickets at all)
  // must archive so a later sweep can settle these races from race_results
  // once /api/live rotates. Hash-gated upsert; steady state is zero writes.
  const archived = await archiveResults(env.DB, raceByKey, hashByKey);

  let scanned = 0;
  let settled = 0;
  let reSettled = 0;
  let deferred = false;
  let budget = SWEEP_CAP;

  // ---- SNAPSHOT PASS -------------------------------------------------------
  // SELECT all tickets (open + settled) for races the snapshot reports as
  // finished. OPEN tickets get their first settlement; settled tickets get
  // re-settled if their stored hash differs (R3). Settled tickets whose race
  // is NOT in the snapshot are left alone — we can't re-settle what we can't
  // see, and an old settled ticket isn't blocking anything.
  if (resultRaceKeys.length > 0 && budget > 0) {
    const placeholders = resultRaceKeys.map(() => "?").join(",");
    const { results } = await env.DB
      .prepare(
        `SELECT id, race_key, payload, state, returned, settle_result_hash
           FROM tickets
          WHERE race_key IN (${placeholders})
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(...resultRaceKeys, budget + 1)
      .all<TicketRow>();
    if (results.length > budget) {
      deferred = true;
      results.length = budget;
    }
    scanned += results.length;
    budget -= results.length;
    for (const row of results) {
      const race = raceByKey.get(row.race_key);
      if (!race || race.status !== "result") continue;
      const result = (race.result ?? null) as RaceResult | null;
      const currentHash = hashByKey.get(row.race_key);
      if (!currentHash || !result) continue;
      const r = await trySettle(env.DB, row, result, currentHash, "snapshot");
      if (r.settled) settled++;
      if (r.reSettled) reSettled++;
    }
  }

  // ---- FALLBACK PASS (#15) -------------------------------------------------
  // Settle OPEN tickets whose race has rotated off /api/live but is present
  // in the race_results archive. Re-settlement of already-settled tickets
  // stays snapshot-window-only — the "left alone unless open" rule. Same
  // trySettle() path as the snapshot pass; only the source tag differs so an
  // operator reading the Worker tail can tell the passes apart.
  if (budget > 0) {
    let sql: string;
    let binds: (string | number)[];
    if (resultRaceKeys.length > 0) {
      // Exclude races the snapshot covers — they were handled above, or the
      // snapshot pass attempted them and the resolver returned 'open' (result
      // block not populated yet). Letting the fallback re-scan them would
      // double-charge the budget without changing the outcome.
      const notInPlaceholders = resultRaceKeys.map(() => "?").join(",");
      sql =
        `SELECT t.id, t.race_key, t.payload, t.state, t.returned, t.settle_result_hash,
                r.result_json, r.result_hash
           FROM tickets t
           JOIN race_results r ON r.race_key = t.race_key
          WHERE t.state = 'open'
            AND t.race_key NOT IN (${notInPlaceholders})
          ORDER BY t.created_at DESC
          LIMIT ?`;
      binds = [...resultRaceKeys, budget + 1];
    } else {
      sql =
        `SELECT t.id, t.race_key, t.payload, t.state, t.returned, t.settle_result_hash,
                r.result_json, r.result_hash
           FROM tickets t
           JOIN race_results r ON r.race_key = t.race_key
          WHERE t.state = 'open'
          ORDER BY t.created_at DESC
          LIMIT ?`;
      binds = [budget + 1];
    }
    let archiveRows: ArchiveTicketRow[];
    try {
      const { results } = await env.DB.prepare(sql).bind(...binds).all<ArchiveTicketRow>();
      archiveRows = results;
    } catch (e) {
      // Most likely cause: race_results doesn't exist yet (the 0008 migration
      // hasn't been applied — e.g. a sweep firing between code deploy and
      // remote migration). Harmless given never-throws; next sweep retries.
      console.warn(`settleSweep: fallback pass query failed: ${(e as Error).message}`);
      archiveRows = [];
    }
    if (archiveRows.length > budget) {
      deferred = true;
      archiveRows.length = budget;
    }
    scanned += archiveRows.length;
    for (const row of archiveRows) {
      let result: RaceResult;
      try {
        result = JSON.parse(row.result_json) as RaceResult;
      } catch {
        continue; // corrupt archive row — leave for human triage
      }
      const r = await trySettle(env.DB, row, result, row.result_hash, "archive");
      if (r.settled) settled++;
      // Fallback only selects state='open' — reSettled stays 0 here.
    }
  }

  console.log(
    `settleSweep: archived ${archived} result race(s); settled ${settled} + re-settled ${reSettled} of ${scanned} tickets` +
      (deferred ? ` (${SWEEP_CAP} cap — remainder deferred to next tick)` : ""),
  );
  return { scanned, settled, reSettled, archived, deferred };
}
