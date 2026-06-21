// ADR-0007 Phase 4 — cron settle sweep.
//
// The 45s client poll in App.tsx is the fast path: when a signed-in user
// has an OPEN ticket and `/api/live` reports the race as `status === 'result'`,
// the client resolves + PATCHes immediately. This module is the BACKSTOP for
// users who were offline at post-time — every 5 min UTC (see wrangler.jsonc
// `triggers.crons`) the Worker fetches `/api/live` from the racing Worker and
// PATCHes any OPEN ticket whose race has a result block.
//
// The sweep is idempotent (UPDATE ... WHERE state='open'), bounded (200
// tickets per run — one race day's worth), and never re-resolves a ticket
// the client already settled. It also doesn't fetch its own origin: it calls
// D1 directly + the resolver.
//
// LIVE_BASE: the racing Worker URL (no trailing slash). Set via
// `wrangler secret put LIVE_BASE`. Empty/missing → sweep logs a warning and
// no-ops (so a misconfigured deploy degrades gracefully rather than
// stranding the cron).

import { resolveTicket, type BetType, type RaceResult, type ResolveTicket } from "./settle";
import { patchTicketState } from "./index";

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

/** Build the same race_key the frontend's `mtRaceKey` / `keyFor` produce. */
function raceKeyOf(
  race: LiveSnapshot["races"] extends (infer T)[] | undefined ? T : never,
  fallbackDate: string,
): string {
  const date = (race.date ?? fallbackDate ?? "") as string;
  return `${date}|${race.venue ?? ""}|${race.race_no}|${race.name ?? ""}`;
}

/**
 * Fetch `/api/live`, walk OPEN tickets, and resolve each against its race's
 * result block. Idempotent (UPDATE ... WHERE state='open'); bounded by
 * SWEEP_CAP. Logs a summary line; never throws — a sweep failure is
 * recoverable on the next tick.
 *
 * Returns the count of tickets settled (for observability / tests).
 */
export async function settleSweep(
  env: { DB: D1Database; LIVE_BASE?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ scanned: number; settled: number; deferred: boolean }> {
  if (!env.LIVE_BASE) {
    console.warn("settleSweep: LIVE_BASE not set; sweep is a no-op");
    return { scanned: 0, settled: 0, deferred: false };
  }

  let snap: LiveSnapshot;
  try {
    const res = await fetchImpl(`${env.LIVE_BASE}/api/live`, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 0 } as Record<string, unknown>,
    });
    if (!res.ok) {
      console.warn(`settleSweep: /api/live returned HTTP ${res.status}`);
      return { scanned: 0, settled: 0, deferred: false };
    }
    snap = (await res.json()) as LiveSnapshot;
  } catch (e) {
    console.warn(`settleSweep: /api/live fetch failed: ${(e as Error).message}`);
    return { scanned: 0, settled: 0, deferred: false };
  }
  if (!snap.races || snap.races.length === 0) {
    return { scanned: 0, settled: 0, deferred: false };
  }

  // Index races by race_key for O(1) ticket lookups.
  const fallbackDate = snap.meta?.date ?? "";
  const raceByKey = new Map<string, LiveSnapshot["races"] extends (infer T)[] | undefined ? T : never>();
  for (const r of snap.races) {
    raceByKey.set(raceKeyOf(r, fallbackDate), r);
  }

  // Pull OPEN tickets (newest first; cap at SWEEP_CAP). The cap is a safety
  // bound — one race day's worth is well under this — and `deferred` flags
  // when the cap was hit so we can extend the window if it ever trips.
  const { results } = await env.DB
    .prepare(
      `SELECT id, race_key, payload
         FROM tickets
        WHERE state = 'open'
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(SWEEP_CAP + 1)
    .all<{ id: string; race_key: string; payload: string }>();
  const deferred = results.length > SWEEP_CAP;
  const scanRows = deferred ? results.slice(0, SWEEP_CAP) : results;

  let settled = 0;
  for (const row of scanRows) {
    const race = raceByKey.get(row.race_key as never);
    if (!race || race.status !== "result") continue;
    const result = (race.result ?? null) as RaceResult | null;

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

    const returned = outcome.state === "won" ? outcome.returned : null;
    const didUpdate = await patchTicketState(env.DB, row.id, outcome.state, returned);
    if (didUpdate) settled++;
  }

  console.log(
    `settleSweep: settled ${settled} of ${scanRows.length} open tickets` +
      (deferred ? ` (${results.length - SWEEP_CAP} deferred to next tick)` : ""),
  );
  return { scanned: scanRows.length, settled, deferred };
}
