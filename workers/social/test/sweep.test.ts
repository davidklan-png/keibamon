import { describe, it, expect, vi } from "vitest";

// ADR-0007 Phase 4 — tests for the cron settle sweep.
//
// The sweep is the offline backstop: every 5 min it fetches `/api/live` from
// the racing Worker, walks OPEN tickets, and resolves each against its race's
// result block. These tests stub `fetch` (via the `fetchImpl` injection point
// on `settleSweep`) and use a tiny in-memory D1 that only knows the two SQL
// statements the sweep issues:
//
//   1. SELECT id, race_key, payload FROM tickets WHERE state = 'open'
//      ORDER BY created_at DESC LIMIT ?
//   2. UPDATE tickets SET state = ?, returned = ? WHERE id = ? AND state = 'open'
//
// Cases (mirror the plan's acceptance criteria):
//   - Open ticket + result-available → ticket settles (won/miss/refunded).
//   - Open ticket + no result yet → ticket stays open.
//   - Already-settled ticket → no-op (idempotency: WHERE state='open' filters).
//   - Cap-overflow: 201 open tickets → 200 settled, 1 deferred.
//   - LIVE_BASE missing → sweep no-ops with a warning.

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

/** In-memory ticket row — slightly richer than the sweep reads so we can
 *  assert post-sweep state for idempotency / overflow cases. */
interface SweepTicketRow {
  id: string;
  race_key: string;
  payload: string;
  state: string;
  returned: number | null;
  created_at: number;
}

/** Build a fake D1 that handles exactly the two sweep statements. */
function makeFakeD1(initial: SweepTicketRow[]) {
  const store = new Map<string, SweepTicketRow>();
  for (const r of initial) store.set(r.id, { ...r });
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
        const m =
          /SELECT id, race_key, payload\s+FROM tickets\s+WHERE state = 'open'\s+ORDER BY created_at DESC\s+LIMIT \?/i.exec(
            s,
          );
        if (m) {
          const cap = entry.bindings[0] as number;
          const rows = [...store.values()]
            .filter((t) => t.state === "open")
            .sort((a, c) => c.created_at - a.created_at)
            .slice(0, cap)
            .map(({ id, race_key, payload }) => ({ id, race_key, payload })) as unknown as T[];
          return { results: rows };
        }
        return { results: [] };
      },
      async run(): Promise<{ meta: { changes: number } }> {
        const s = sql.trim();
        const m =
          /UPDATE tickets\s+SET state = \?, returned = \?\s+WHERE id = \? AND state = 'open'/i.exec(
            s,
          );
        if (m) {
          const [newState, newReturned, id] = entry.bindings as [
            string,
            number | null,
            string,
          ];
          const row = store.get(id);
          if (row && row.state === "open") {
            row.state = newState;
            row.returned = newReturned;
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
  finishers: [5, 16, 1, 7, 3],
  payouts: [{ pool: "quinella", combo: "5-16", yen: 1230 }],
};

describe("settleSweep", () => {
  it("resolves an OPEN ticket when its race has a result (quinella hit → won)", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-1",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
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
    expect(out.deferred).toBe(false);
    const row = store.get("t-1")!;
    expect(row.state).toBe("won");
    // Quinella payout ¥1230 per ¥100 → ¥100 stake returns ¥1230.
    expect(row.returned).toBe(1230);
  });

  it("resolves a missing OPEN ticket (quinella miss → miss, returned=null)", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-miss",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["7", "3"], { unit: 100 }),
        state: "open",
        returned: null,
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
  });

  it("resolves a scratched-line OPEN ticket → refunded", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-scr",
        race_key: RACE_KEY,
        // 99 is not in the result's finishers; we mark it scratched.
        payload: ticketPayload("quinella", ["5", "99"], { unit: 100 }),
        state: "open",
        returned: null,
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
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    // Race is still 'open' (pool live, no result block).
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

    expect(out.scanned).toBe(1);
    expect(out.settled).toBe(0);
    expect(store.get("t-open")!.state).toBe("open");
  });

  it("leaves an OPEN ticket alone when its race_key isn't in the snapshot", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-other",
        race_key: "20260621|Tokyo|9|",
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "open",
        returned: null,
        created_at: 1_700_000_000_000,
      },
    ];
    const { db, store } = makeFakeD1(rows);

    // Snapshot only has race 11 at Hanshin; the ticket is for race 9 at Tokyo.
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
    expect(store.get("t-other")!.state).toBe("open");
  });

  it("is idempotent: an already-settled ticket is never even returned by the SELECT", async () => {
    const rows: SweepTicketRow[] = [
      {
        id: "t-won",
        race_key: RACE_KEY,
        payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
        state: "won", // already settled
        returned: 1230,
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

    expect(out.scanned).toBe(0); // SELECT filtered to state='open'
    expect(out.settled).toBe(0);
    // No UPDATE issued — the row is unchanged.
    expect(calls.some((c) => /UPDATE tickets/i.test(c.sql))).toBe(false);
    expect(store.get("t-won")!.state).toBe("won");
  });

  it("defers overflow: 201 OPEN tickets → 200 scanned (deferred=true), all 200 settled", async () => {
    const rows: SweepTicketRow[] = Array.from({ length: 201 }, (_, i) => ({
      id: `t-${i}`,
      race_key: RACE_KEY,
      payload: ticketPayload("quinella", ["5", "16"], { unit: 100 }),
      state: "open",
      returned: null,
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
