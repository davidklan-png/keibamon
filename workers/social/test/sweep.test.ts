import { describe, it, expect, vi } from "vitest";

// ADR-0007 Phase 4 + R3 + #15 — tests for the cron settle sweep.
//
// The sweep is the offline backstop: every 5 min it fetches `/api/live` from
// the racing Worker, walks OPEN tickets for finished races, and resolves each
// against its race's result block. R3 added re-settlement: settled tickets
// whose result block has changed (hash differs) are re-resolved and updated.
// #15 added a `race_results` archive + a fallback pass so tickets whose race
// has rotated off /api/live settle from the archive instead of stranding.
//
// These tests stub `fetch` (via the `fetchImpl` injection point on
// `settleSweep`) and use a tiny in-memory D1 that only knows the SQL
// statements the sweep issues:
//
//   1. SELECT ... FROM tickets WHERE race_key IN (?, ...) ORDER BY ... LIMIT ?
//        (snapshot pass — fetches tickets for races in the current snapshot)
//   2. SELECT t.*, r.result_json, r.result_hash FROM tickets t JOIN
//        race_results r ... WHERE t.state = 'open' [AND NOT IN (...)] LIMIT ?
//        (#15 fallback pass — fetches open tickets whose race has rotated off)
//   3. INSERT INTO race_results (...) VALUES (...) ON CONFLICT(race_key) DO
//        UPDATE SET ... WHERE result_hash != excluded.result_hash
//        (#15 archive upsert — hash-gated, zero writes at steady state)
//   4. UPDATE tickets SET state = ?, returned = ?, settle_result_hash = ?,
//        placings = ? WHERE id = ?
//
// Cases (mirror the plan's acceptance criteria + R3 transitions + #15):
//   - Open ticket + result-available → ticket settles (won/miss/refunded).
//   - Open ticket + no result yet → ticket stays open.
//   - Already-settled ticket + same result hash → idempotent skip (no UPDATE).
//   - Already-settled + result hash changed → re-settle with transition log.
//   - Cap-overflow: 201 open tickets → 200 scanned, 1 deferred.
//   - LIVE_BASE missing → sweep no-ops with a warning.
//   - #15: snapshot result races get archived (hash-gated upsert).
//   - #15 regression: OPEN ticket whose race rotated off /api/live settles
//     from the archive on the next sweep.
//   - #15: source='backfill' archive rows settle identically to 'sweep'.

import { settleSweep } from "../src/sweep";

/** Race snapshot shape consumed by the sweep (minimal slice of /api/live). */
interface SnapshotRace {
  date?: string;
  race_no: number;
  name?: string | null;
  venue?: string | null;
  status?: string;
  result?: Record<string, unknown> | null;
}
function makeSnapshot(races: SnapshotRace[], meta?: { date?: string }) {
  return { meta: meta ?? {}, races };
}

/** In-memory ticket row — richer than the sweep reads so we can assert
 *  post-sweep state for idempotency / re-settlement / overflow cases. */
interface SweepTicketRow {
  id: string;
  race_key: string;
  payload: string;
  state: string;
  returned: number | null;
  settle_result_hash: string | null;
  created_at: number;
  placings?: string | null;
}

/** #15 — Row in the race_results archive. Tests seed this to simulate a
 *  previous sweep having archived a result (or a backfill importer run). */
interface ArchiveRow {
  race_key: string;
  result_json: string;
  result_hash: string;
  source: "sweep" | "backfill";
  archived_at: number;
}

/** Build a fake D1 that handles the sweep's SQL statements. */
function makeFakeD1(initial: SweepTicketRow[], archiveInitial: ArchiveRow[] = []) {
  const store = new Map<string, SweepTicketRow>();
  for (const r of initial) store.set(r.id, { ...r });
  const archive = new Map<string, ArchiveRow>();
  for (const r of archiveInitial) archive.set(r.race_key, { ...r });
  const calls: { sql: string; bindings: unknown[] }[] = [];

  function prepare(sql: string) {
    const entry = { sql, bindings: [] as unknown[] };
    calls.push(entry);
    const self = {
      bind(...args: unknown[]) {
        entry.bindings = args;
        return self;
      },
      async all<T>(): Promise<{ results: T[] }> {
        const s = sql.trim();
        // --- SNAPSHOT pass SELECT ---
        // SELECT id, race_key, payload, state, returned, settle_result_hash
        //   FROM tickets WHERE race_key IN (?, ...) ORDER BY created_at DESC LIMIT ?
        const selectRe =
          /SELECT id, race_key, payload, state, returned, settle_result_hash\s+FROM tickets\s+WHERE race_key IN \(([\?, ]+)\)\s+ORDER BY created_at DESC\s+LIMIT \?/i;
        const m = selectRe.exec(s);
        if (m) {
          // Bindings: [...race_keys, cap]
          const last = entry.bindings[entry.bindings.length - 1] as number;
          const keys = entry.bindings.slice(0, -1) as string[];
          const keySet = new Set(keys);
          const rows = [...store.values()]
            .filter((t) => keySet.has(t.race_key))
            .sort((a, c) => c.created_at - a.created_at)
            .slice(0, last)
            .map(({ id, race_key, payload, state, returned, settle_result_hash }) => ({
              id, race_key, payload, state, returned, settle_result_hash,
            })) as unknown as T[];
          return { results: rows };
        }
        // --- #15 fallback pass SELECT (tickets JOIN race_results) ---
        if (/FROM tickets\s+t\s+JOIN race_results\s+r\s+ON r\.race_key\s*=\s*t\.race_key/i.test(s)) {
          const last = entry.bindings[entry.bindings.length - 1] as number;
          // Bindings are either [limit] or [...notInKeys, limit]. If the SQL
          // has a NOT IN clause, all bindings except the last are the keys.
          const hasNotIn = /NOT IN \(/i.test(s);
          const notInKeys = hasNotIn
            ? new Set(entry.bindings.slice(0, -1) as string[])
            : new Set<string>();
          const rows = [...store.values()]
            .filter((t) => t.state === "open")
            .filter((t) => !notInKeys.has(t.race_key))
            .filter((t) => archive.has(t.race_key))
            .sort((a, c) => c.created_at - a.created_at)
            .slice(0, last)
            .map((t) => {
              const a = archive.get(t.race_key)!;
              return {
                id: t.id,
                race_key: t.race_key,
                payload: t.payload,
                state: t.state,
                returned: t.returned,
                settle_result_hash: t.settle_result_hash,
                result_json: a.result_json,
                result_hash: a.result_hash,
              };
            }) as unknown as T[];
          return { results: rows };
        }
        return { results: [] };
      },
      async run(): Promise<{ meta: { changes: number } }> {
        const s = sql.trim();
        // --- Ticket settlement UPDATE ---
        const m =
          /UPDATE tickets\s+SET state = \?, returned = \?, settle_result_hash = \?, placings = \?\s+WHERE id = \?/i.exec(
            s,
          );
        if (m) {
          const [newState, newReturned, newHash, newPlacings, id] = entry.bindings as [
            string,
            number | null,
            string,
            string | null,
            string,
          ];
          const row = store.get(id);
          if (row) {
            row.state = newState;
            row.returned = newReturned;
            row.settle_result_hash = newHash;
            row.placings = newPlacings;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        // --- #15 race_results archive upsert (hash-gated) ---
        if (/INSERT INTO race_results/i.test(s)) {
          // Bindings: [race_key, result_json, result_hash, archived_at]
          const [raceKey, resultJson, resultHash, archivedAt] = entry.bindings as [
            string, string, string, number,
          ];
          const existing = archive.get(raceKey);
          if (!existing) {
            archive.set(raceKey, {
              race_key: raceKey,
              result_json: resultJson,
              result_hash: resultHash,
              source: "sweep",
              archived_at: archivedAt,
            });
            return { meta: { changes: 1 } };
          }
          if (existing.result_hash !== resultHash) {
            existing.result_json = resultJson;
            existing.result_hash = resultHash;
            existing.source = "sweep";
            existing.archived_at = archivedAt;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        return { meta: { changes: 0 } };
      },
      async first<T>(): Promise<T | null> {
        return null;
      },
    };
    return self;
  }

  const db = { prepare };
  return {
    db: db as unknown as D1Database,
    store,
    archive,
    calls,
  };
}

/** fetch stub: always returns the snapshot as JSON (or HTTP error if !ok). */
function fetchStub(
  snapshot: unknown,
  opts: { ok?: boolean; status?: number } = {},
): typeof fetch {
  const { ok = true, status = 200 } = opts;
  return vi.fn(async () => {
    return {
      ok,
      status,
      json: async () => snapshot,
      headers: new Map(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Build a single-line quinella ticket payload matching `parseTicketBody`. */
function ticketPayload(
  type: "quinella" | "wide" | "exacta" | "trio" | "trifecta",
  combo: string[],
  opts: { unit?: number; avgPayout?: number } = {},
): string {
  const { unit = 100, avgPayout = 5000 } = opts;
  return JSON.stringify({
    ticket: { type, lines: [{ combo }], avgPayout },
    unit,
  });
}

const RACE_KEY = "20260621|Hanshin|11|Takarazuka Kinen";

/** Result block matching a quinella 5-16 payout of ¥1230 (per ¥100 stake). */
const RESULT_QUINELLA_5_16 = {
  placings: [
    { pos: 1, umabans: [5] },
    { pos: 2, umabans: [16] },
    { pos: 3, umabans: [1] },
  ],
  payouts: [{ pool: "quinella", combo: "5-16", yen: 1230 }],
};

/** Stable hash of RESULT_QUINELLA_5_16 — captured at test time so the
 *  idempotency assertion is independent of the hash function. Computed
 *  via the sweep's exported hashResult below. */
const HASH_QUINELLA_5_16 =
  "8f1d97b334d3f0e68d5a8c0b05b7c8d9c0e3a8b4d2e6f0a1c5e7d9b3a4f6e8c2";

// Real hash computed dynamically inside tests (re-exported helper).
async function realHashOf(result: Record<string, unknown>): Promise<string> {
  const { hashResult } = await import("../src/sweep");
  return hashResult(result as never);
}

describe("settleSweep — initial settlement (OPEN → settled)", () => {
  it("resolves an OPEN ticket when its race has a result (quinella hit → won)", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-1",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(1);
    expect(out.settled).toBe(1);
    expect(out.reSettled).toBe(0);
    expect(out.deferred).toBe(false);
    const row = store.get("t-1")!;
    expect(row.state).toBe("won");
    // Quinella payout ¥1230 per ¥100 → ¥100 stake returns ¥1230.
    expect(row.returned).toBe(1230);
    // Hash written so the next sweep can skip idempotently.
    expect(row.settle_result_hash).toBeTruthy();
    expect(row.settle_result_hash).toHaveLength(64); // SHA-256 hex
  });

  it("prunes expired rate_limit buckets on every sweep (TTL)", async () => {
    // Stage 5: the sweep deletes rate_limits rows from prior windows so the
    // table can't grow unbounded — rides the existing cron, no new infra.
    // Runs even when the card is empty (the TTL precedes the /api/live fetch).
    const { db, calls } = makeFakeD1([]);
    await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(makeSnapshot([])),
    );
    const del = calls.find((c) => /DELETE FROM rate_limits WHERE bucket < \?/i.test(c.sql));
    expect(del, "expected a DELETE FROM rate_limits ... WHERE bucket < ?").toBeDefined();
    // The cutoff is a non-negative integer (the current 60s bucket — keep the
    // active window, delete older ones). Exact value not asserted to avoid
    // flakiness across a minute boundary.
    expect(typeof del!.bindings[0]).toBe("number");
    expect(del!.bindings[0]).toBeGreaterThanOrEqual(0);
  });

  it("resolves a missing OPEN ticket (quinella miss → miss, returned=null)", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-miss",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["7", "3"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.settled).toBe(1);
    const row = store.get("t-miss")!;
    expect(row.state).toBe("miss");
    expect(row.returned).toBeNull();
    // Hash written even on miss — so a later correction (e.g. dead-heat
    // surfaces) still re-evaluates correctly.
    expect(row.settle_result_hash).toBeTruthy();
  });

  it("resolves a scratched-line OPEN ticket → refunded", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-scr",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "99"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: { ...RESULT_QUINELLA_5_16, scratched: [99] },
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.settled).toBe(1);
    const row = store.get("t-scr")!;
    expect(row.state).toBe("refunded");
    expect(row.returned).toBeNull();
  });

  it("leaves an OPEN ticket alone when the race hasn't reached 'result' yet", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-open",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    // Race is still 'open' (pool live, no result block). The race_key isn't
    // in the finished-races set, so the SELECT returns nothing.
    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "open",
        result: null,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(0);
    expect(out.settled).toBe(0);
    expect(store.get("t-open")!.state).toBe("open");
  });

  it("leaves a ticket alone when its race is not in the snapshot", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-other",
        race_key: "20260621|Tokyo|9|",
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    // Snapshot only has race 11 at Hanshin; the ticket is for race 9 at Tokyo.
    // Ticket's race_key isn't in the IN (?, ...) list → no rows returned.
    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(0);
    expect(out.settled).toBe(0);
    expect(store.get("t-other")!.state).toBe("open");
  });

  it("defers overflow: 201 OPEN tickets → 200 scanned (deferred=true), all 200 settled", async () => {
    const rows: SweepTicketRow[] = Array.from({ length: 201 }, (_, i) => ({
      id: `t-${i}`,
      race_key: RACE_KEY,
      payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
      state: "open",
      returned: null,
      settle_result_hash: null,
      // Distinct created_at so the ORDER BY is deterministic.
      created_at: 1_700_000_000_000 + i,
    }));
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(200);
    expect(out.settled).toBe(200);
    expect(out.deferred).toBe(true);
    // 200 settled + 1 still open (the deferred one).
    const openCount = [...store.values()].filter((t) => t.state === "open").length;
    expect(openCount).toBe(1);
    const wonCount = [...store.values()].filter((t) => t.state === "won").length;
    expect(wonCount).toBe(200);
  });

  it("no-ops with a warning when LIVE_BASE is missing", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-x",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"]),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const out = await settleSweep({ DB: db, LIVE_BASE: undefined }, fetchImpl);

    expect(out.scanned).toBe(0);
    expect(out.settled).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.get("t-x")!.state).toBe("open");
  });

  it("no-ops gracefully when /api/live returns HTTP error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows: SweepTicketRow[] = [
      {
        id: "t-x",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"]),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub({}, { ok: false, status: 503 }),
    );

    expect(out.scanned).toBe(0);
    expect(out.settled).toBe(0);
    expect(store.get("t-x")!.state).toBe("open");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips a ticket whose payload is malformed JSON (leaves it for human triage)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows: SweepTicketRow[] = [
      {
        id: "t-bad",
        race_key: RACE_KEY,
        payload: "{not json",
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(1);
    expect(out.settled).toBe(0);
    expect(store.get("t-bad")!.state).toBe("open");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// R3 — re-settlement on result change. The cases the verification layer asked
// for: partial→complete, won→miss, miss→won, amount change, idempotent skip,
// NULL-hash backfill. All transitions are logged so an operator reading the
// Worker tail can audit them.
// ---------------------------------------------------------------------------

describe("settleSweep — R3 re-settlement (result hash changed)", () => {
  it("is idempotent: a settled ticket whose result hash matches is NOT updated", async () => {
    const storedHash = await realHashOf(RESULT_QUINELLA_5_16);
    const rows: SweepTicketRow[] = [
      {
        id: "t-won",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won",
        returned: 1230,
        settle_result_hash: storedHash,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store, calls } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(1);
    expect(out.settled).toBe(0);
    expect(out.reSettled).toBe(0);
    // No UPDATE issued — row unchanged.
    expect(calls.some((c) => /UPDATE tickets/i.test(c.sql))).toBe(false);
    expect(store.get("t-won")!.state).toBe("won");
    expect(store.get("t-won")!.returned).toBe(1230);
  });

  it("re-settles won → miss when the corrected result no longer hits", async () => {
    // Ticket was settled 'won' against an OLD result that had 5 + 16 in top 2.
    // The corrected/complete result has them outside top 2 — line now misses.
    const oldResult = {
      placings: [
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
      ],
      payouts: [{ pool: "quinella", combo: "5-16", yen: 1230 }],
    };
    const newResult = {
      placings: [
        { pos: 1, umabans: [7] },
        { pos: 2, umabans: [3] },
        { pos: 3, umabans: [5] },
        { pos: 4, umabans: [16] },
      ],
      payouts: [{ pool: "quinella", combo: "3-7", yen: 880 }],
    };
    const oldHash = await realHashOf(oldResult);

    const rows: SweepTicketRow[] = [
      {
        id: "t-won-then-miss",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won",
        returned: 1230,
        settle_result_hash: oldHash,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store, calls } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: newResult,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.reSettled).toBe(1);
    const row = store.get("t-won-then-miss")!;
    expect(row.state).toBe("miss");
    expect(row.returned).toBeNull();
    // Hash advanced — next sweep over the same result is idempotent.
    const newHash = await realHashOf(newResult);
    expect(row.settle_result_hash).toBe(newHash);

    // Transition logged for operator audit.
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/re-settled t-won-then-miss won\(1230\) -> miss \(state\)/),
    );
    // UPDATE was issued with the hash CAS.
    expect(calls.some((c) => /UPDATE tickets[\s\S]*settle_result_hash/i.test(c.sql))).toBe(true);
    log.mockRestore();
  });

  it("re-settles miss → won when the corrected result hits", async () => {
    // Ticket was settled 'miss' against an OLD result that didn't have 7 + 3
    // in top 2. The corrected result has them at 1-2 — now hits.
    const oldResult = {
      placings: [
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
      ],
      payouts: [{ pool: "quinella", combo: "5-16", yen: 1230 }],
    };
    const newResult = {
      placings: [
        { pos: 1, umabans: [7] },
        { pos: 2, umabans: [3] },
        { pos: 3, umabans: [5] },
      ],
      payouts: [{ pool: "quinella", combo: "3-7", yen: 880 }],
    };
    const oldHash = await realHashOf(oldResult);

    const rows: SweepTicketRow[] = [
      {
        id: "t-miss-then-won",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["7", "3"], { unit: 200 }),
        state: "miss",
        returned: null,
        settle_result_hash: oldHash,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: newResult,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.reSettled).toBe(1);
    const row = store.get("t-miss-then-won")!;
    expect(row.state).toBe("won");
    // Quinella payout ¥880 per ¥100, unit ¥200 → ¥1760.
    expect(row.returned).toBe(1760);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/re-settled t-miss-then-won miss -> won\(1760\) \(state\)/),
    );
    log.mockRestore();
  });

  it("re-settles won(X) → won(Y) when the payout amount changes (dead heat surfaced)", async () => {
    // First result paid quinella 5-16 = ¥1230. Later, the producer attaches
    // a SECOND quinella payout row (5-7 dead-heated with 5-16 for the win
    // pair); the resolver correctly sums BOTH rows for combo 5-16.
    const oldResult = {
      placings: [
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
        { pos: 3, umabans: [1] },
      ],
      payouts: [{ pool: "quinella", combo: "5-16", yen: 1230 }],
    };
    const newResult = {
      placings: [
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
        { pos: 3, umabans: [1] },
      ],
      // Same placings but a second payout row (e.g. dead-heat correction).
      payouts: [
        { pool: "quinella", combo: "5-16", yen: 1230 },
        { pool: "quinella", combo: "5-16", yen: 470 },
      ],
    };
    const oldHash = await realHashOf(oldResult);

    const rows: SweepTicketRow[] = [
      {
        id: "t-amount",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won",
        returned: 1230,
        settle_result_hash: oldHash,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: newResult,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.reSettled).toBe(1);
    const row = store.get("t-amount")!;
    expect(row.state).toBe("won");
    // Two payout rows for the same combo → summed: 1230 + 470 = 1700.
    expect(row.returned).toBe(1700);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/re-settled t-amount won\(1230\) -> won\(1700\) \(amount\)/),
    );
    log.mockRestore();
  });

  it("backfills a NULL hash (legacy ticket) against the current result", async () => {
    // Pre-R3 settled ticket has settle_result_hash = NULL. The first sweep
    // after deploy should re-evaluate against the current result and store
    // the hash, WITHOUT logging a misleading "transition" if nothing changed.
    const currentHash = await realHashOf(RESULT_QUINELLA_5_16);
    const rows: SweepTicketRow[] = [
      {
        id: "t-legacy",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won",
        returned: 1230,
        settle_result_hash: null, // pre-R3 — backfill needed
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.reSettled).toBe(1);
    const row = store.get("t-legacy")!;
    expect(row.state).toBe("won"); // unchanged
    expect(row.returned).toBe(1230); // unchanged
    expect(row.settle_result_hash).toBe(currentHash); // backfilled
    expect(log).toHaveBeenCalledWith(
      // "hash-only" because state + amount didn't change — just the hash.
      expect.stringMatching(/re-settled t-legacy won\(1230\) -> won\(1230\) \(hash-only\)/),
    );
    log.mockRestore();
  });

  it("refuses to invent a transition when the race is no longer in the snapshot", async () => {
    // A settled ticket whose race has aged out of /api/live (e.g. last week's
    // race) MUST NOT be touched — we can't re-settle what we can't see. The
    // new SELECT filters by race_key IN (...), so old tickets aren't returned.
    const rows: SweepTicketRow[] = [
      {
        id: "t-old",
        race_key: "20260614|Tokyo|12|Legacy",
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won",
        returned: 999,
        settle_result_hash: "deadbeef",
        created_at: 1_600_000_000_000,
      },
    ];
    const { db, store, calls } = makeFakeD1(rows);

    // Snapshot only has THIS weekend's race — the old race isn't in it.
    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.scanned).toBe(0); // old ticket not in IN list
    expect(calls.some((c) => /UPDATE tickets/i.test(c.sql))).toBe(false);
    expect(store.get("t-old")!.state).toBe("won");
    expect(store.get("t-old")!.returned).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// #15 — results archive for rotated-off races. The structural bug: the sweep
// used to settle ONLY against /api/live, which the publisher overwrites when
// next weekend's card goes up — so any OPEN ticket whose race aged out before
// the sweep ran was stranded open forever. The fix: archive every result race
// into `race_results` (hash-gated upsert) + a fallback pass that joins OPEN
// tickets to the archive. See docs/prompts/sweep-results-archive.md.
// ---------------------------------------------------------------------------

/** A race key that's NOT in any snapshot these tests build — simulates a
 *  race that has already rotated off /api/live (e.g. last weekend's card). */
const ROTATED_RACE_KEY = "20260614|Tokyo|12|Grade One";

/** Build an ArchiveRow seed for the rotated race. */
async function archiveSeedFor(
  result: Record<string, unknown>,
  source: "sweep" | "backfill" = "sweep",
): Promise<ArchiveRow> {
  return {
    race_key: ROTATED_RACE_KEY,
    result_json: JSON.stringify(result),
    result_hash: await realHashOf(result),
    source,
    archived_at: 1_700_000_000_000,
  };
}

describe("settleSweep — #15 results archive (rotated-off races)", () => {
  it("archives every snapshot result race (hash-gated: same hash → no write, changed hash → update)", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-arc-1",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, archive } = makeFakeD1(rows);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    // First sweep: archive empty → INSERT fires, archived=1.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out1 = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );
    expect(out1.archived).toBe(1);
    expect(archive.has(RACE_KEY)).toBe(true);
    const storedHash = archive.get(RACE_KEY)!.result_hash;
    expect(storedHash).toHaveLength(64); // SHA-256 hex
    warn.mockRestore();

    // Second sweep over the SAME snapshot: hash matches → zero writes.
    const warn2 = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out2 = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );
    expect(out2.archived).toBe(0); // hash-gated no-op
    expect(archive.get(RACE_KEY)!.result_hash).toBe(storedHash);
    warn2.mockRestore();

    // Third sweep with a CHANGED result (dead-heat payout added): hash differs
    // → archive row updated, archived=1.
    const corrected = {
      ...RESULT_QUINELLA_5_16,
      payouts: [
        { pool: "quinella", combo: "5-16", yen: 1230 },
        { pool: "quinella", combo: "5-16", yen: 470 },
      ],
    };
    const snap2 = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: corrected,
      },
    ]);
    const warn3 = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out3 = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap2),
    );
    expect(out3.archived).toBe(1);
    const newHash = archive.get(RACE_KEY)!.result_hash;
    expect(newHash).not.toBe(storedHash);
    warn3.mockRestore();
  });

  it("THE BUG: OPEN ticket whose race rotated off /api/live settles from the archive", async () => {
    // Reproduction of the June-28 stranding: an OPEN ticket for a race that
    // is no longer in /api/live. Before #15, this ticket stayed open forever.
    // After #15, the fallback pass joins it to the archive and settles it.
    const seed = await archiveSeedFor(RESULT_QUINELLA_5_16);
    const rows: SweepTicketRow[] = [
      {
        id: "t-stranded",
        race_key: ROTATED_RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows, [seed]);

    // Snapshot has a DIFFERENT race (this weekend's card) — the rotated race
    // is genuinely absent from /api/live.
    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    // The fallback pass scanned + settled the stranded ticket.
    expect(out.scanned).toBeGreaterThanOrEqual(1);
    expect(out.settled).toBe(1);
    const row = store.get("t-stranded")!;
    expect(row.state).toBe("won");
    expect(row.returned).toBe(1230);
    expect(row.settle_result_hash).toBe(seed.result_hash);
    // The log line carries the [archive] source tag so an operator can tell
    // the fallback pass fired (vs. the snapshot pass).
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/\[archive\]/),
    );
    log.mockRestore();
  });

  it("leaves an OPEN ticket open when its race is in neither snapshot nor archive (no crash)", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-nowhere",
        race_key: "20260607|Nakayama|6|Unknown",
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    // Snapshot has a different race; archive is empty.
    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.settled).toBe(0);
    expect(out.deferred).toBe(false);
    expect(store.get("t-nowhere")!.state).toBe("open");
  });

  it("SWEEP_CAP bounds the combined passes (snapshot fills budget → fallback skipped)", async () => {
    // Snapshot pass alone overflows the cap. The fallback pass must NOT run
    // (budget=0 after snapshot truncation) so the archive-backed ticket is
    // deferred to the next sweep rather than double-counting.
    const seed = await archiveSeedFor(RESULT_QUINELLA_5_16);
    const snapshotTickets: SweepTicketRow[] = Array.from({ length: 201 }, (_, i) => ({
      id: `t-snap-${i}`,
      race_key: RACE_KEY,
      payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
      state: "open",
      returned: null,
      settle_result_hash: null,
      created_at: 1_700_000_000_000 + i,
    }));
    const archiveTicket: SweepTicketRow = {
      id: "t-archive-deferred",
      race_key: ROTATED_RACE_KEY,
      payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
      state: "open",
      returned: null,
      settle_result_hash: null,
      created_at: 1_600_000_000_000, // older than snapshot tickets
    };
    const { db, store } = makeFakeD1([...snapshotTickets, archiveTicket], [seed]);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );
    warn.mockRestore();

    expect(out.scanned).toBe(200); // snapshot consumed the whole budget
    expect(out.settled).toBe(200);
    expect(out.deferred).toBe(true);
    // The archive-backed ticket did NOT get settled — fallback was skipped.
    expect(store.get("t-archive-deferred")!.state).toBe("open");
  });

  it("source='backfill' archive row settles identically to source='sweep'", async () => {
    // The recovery importer (workers/social/scripts/backfill-stuck-tickets.ts)
    // inserts rows with source='backfill' after a capture outage. The fallback
    // pass must settle these the same way as sweep-sourced rows — same
    // resolver, same hash bookkeeping. This is the #15 recovery contract.
    const seed = await archiveSeedFor(RESULT_QUINELLA_5_16, "backfill");
    const rows: SweepTicketRow[] = [
      {
        id: "t-backfill",
        race_key: ROTATED_RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        settle_result_hash: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows, [seed]);

    // Snapshot has a different race — the rotated race is only in the archive.
    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );

    expect(out.settled).toBe(1);
    const row = store.get("t-backfill")!;
    expect(row.state).toBe("won");
    expect(row.returned).toBe(1230);
    expect(row.settle_result_hash).toBe(seed.result_hash);
    log.mockRestore();
  });

  it("does NOT re-settle an already-settled archive ticket (snapshot-window-only rule)", async () => {
    // The spec: "re-settlement of already-settled tickets stays snapshot-
    // window-only." A settled ticket whose race has rotated off must NOT be
    // touched by the fallback pass even if its hash differs — the fallback
    // only settles OPEN tickets.
    const staleResult = {
      placings: [
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
      ],
      payouts: [{ pool: "quinella", combo: "5-16", yen: 1230 }],
    };
    const correctedResult = {
      placings: [
        { pos: 1, umabans: [7] },
        { pos: 2, umabans: [3] },
      ],
      payouts: [{ pool: "quinella", combo: "3-7", yen: 880 }],
    };
    // Archive carries the corrected result, but the ticket was settled
    // against the OLD hash — a would-be re-settle case if it were open.
    const seed = await archiveSeedFor(correctedResult);
    const oldHash = await realHashOf(staleResult);
    const rows: SweepTicketRow[] = [
      {
        id: "t-settled-rotated",
        race_key: ROTATED_RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won",
        returned: 1230,
        settle_result_hash: oldHash,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store, calls } = makeFakeD1(rows, [seed]);

    const snap = makeSnapshot([
      {
        date: "20260621",
        venue: "Hanshin",
        race_no: 11,
        name: "Takarazuka Kinen",
        status: "result",
        result: RESULT_QUINELLA_5_16,
      },
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await settleSweep(
      { DB: db, LIVE_BASE: "https://racing.example" },
      fetchStub(snap),
    );
    warn.mockRestore();

    // No UPDATE against the settled-rotated ticket — it's left alone.
    expect(out.settled).toBe(0);
    expect(out.reSettled).toBe(0);
    expect(store.get("t-settled-rotated")!.state).toBe("won");
    expect(store.get("t-settled-rotated")!.returned).toBe(1230);
    expect(store.get("t-settled-rotated")!.settle_result_hash).toBe(oldHash);
    // No UPDATE SQL touched this ticket.
    const updateCalls = calls.filter(
      (c) => /UPDATE tickets/i.test(c.sql) && c.bindings.includes("t-settled-rotated"),
    );
    expect(updateCalls).toHaveLength(0);
  });
});
