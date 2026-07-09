// Regression test for the atomic ownership/settlement upsert (Blocker 1).
//
// Runs insertTicket's REAL conditional-upsert SQL against better-sqlite3 (not
// the hand-rolled fake), and simulates the TOCTOU window — a row appearing
// between the preliminary SELECT and the upsert — by blinding the first
// tickets-by-id SELECT. Proves a second user CANNOT overwrite the first user's
// payload, and that legitimate same-owner edits / fresh creates still work.
//
// This is intentionally not a SQL-string assertion: the conditional WHERE is
// executed by SQLite and its effect on the row + RETURNING is observed.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { insertTicket } from "../src/tickets";

// better-sqlite3 is a root-level devDep used only by this real-SQL test; it is
// not declared in workers/social's package.json, so require it untyped (adding
// @types/better-sqlite3 here just for a test isn't warranted).
const require = createRequire(import.meta.url);
interface SqliteStmt {
  run(...b: unknown[]): { changes: number };
  get<T = unknown>(...b: unknown[]): T | undefined;
  all<T = unknown>(...b: unknown[]): T[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}
const Database = require("better-sqlite3") as new (path: string) => SqliteDb;

const SCHEMA = `CREATE TABLE tickets (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, serial TEXT, race_key TEXT,
  payload TEXT, state TEXT, payout_base INTEGER, returned INTEGER, created_at INTEGER,
  ticket_type TEXT, line_count INTEGER, cost INTEGER, unit INTEGER,
  structure TEXT, venue TEXT, race_no INTEGER
)`;

interface Parsed {
  id: string;
  serial: string;
  raceKey: string;
  payload: string;
  state: string;
  payoutBase: number;
  createdAt: number;
  ticketType: string | null;
  lineCount: number | null;
  cost: number | null;
  unit: number | null;
  structure: string | null;
  venue: string | null;
  raceNo: number | null;
}

function parsed(id: string, userId: string, marker: string): Parsed {
  return {
    id,
    serial: "KB-TEST",
    raceKey: "20260621|Hanshin|11|Takarazuka Kinen",
    payload: JSON.stringify({ owner: userId, marker }),
    state: "open",
    payoutBase: 5000,
    createdAt: 1_700_000_000_000,
    ticketType: "exacta",
    lineCount: 1,
    cost: 200,
    unit: 200,
    structure: null,
    venue: "Hanshin",
    raceNo: 11,
  };
}

function seedOpenTicket(db: SqliteDb, id: string, userId: string, marker: string): string {
  const payload = JSON.stringify({ owner: userId, marker });
  db.prepare(
    `INSERT INTO tickets (id, user_id, serial, race_key, payload, state, payout_base, returned, created_at, ticket_type, line_count, cost, unit, structure, venue, race_no)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`,
  ).run(id, userId, "KB-SEED", "rk", payload, "open", 5000, 1700000000, "exacta", 1, 200, 200, null, null, null);
  return payload;
}

/**
 * A D1Database shim over real SQLite. `blindFirstTicketsSelect` hides an
 * existing row from the FIRST `SELECT state,user_id ... WHERE id=?` — modelling
 * a concurrent commit landing between insertTicket's preliminary SELECT and its
 * upsert. The upsert (INSERT ... RETURNING) and any later SELECT see the true
 * row state, so the conditional WHERE is genuinely exercised.
 */
function makeD1(db: SqliteDb, opts: { blindFirstTicketsSelect?: boolean } = {}): D1Database {
  let blinded = opts.blindFirstTicketsSelect ?? false;
  const isTicketsById = (sql: string) =>
    /^SELECT state, user_id FROM tickets WHERE id = \?/i.test(sql.trim());
  const prepare = (sql: string) => {
    const stmt = db.prepare(sql);
    const make = (vals: unknown[]) => ({
      async first<T>(): Promise<T | null> {
        if (isTicketsById(sql) && blinded) {
          blinded = false;
          return null;
        }
        return (stmt.get(...vals) ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: (stmt.all(...vals) ?? []) as T[] };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run(...vals);
        return { success: true, meta: { changes: info.changes } };
      },
    });
    return {
      bind(...vals: unknown[]) {
        return make(vals);
      },
      async first<T>(): Promise<T | null> {
        return (stmt.get() ?? null) as T | null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: stmt.all() ?? [] };
      },
      async run(): Promise<{ success: true; meta: { changes: number } }> {
        const info = stmt.run();
        return { success: true, meta: { changes: info.changes } };
      },
    };
  };
  return { prepare } as unknown as D1Database;
}

describe("insertTicket — atomic ownership (TOCTOU)", () => {
  it("a row appearing between SELECT and upsert CANNOT be hijacked by another user", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    // User A's ticket is already committed (simulating a concurrent write that
    // lands AFTER B's preliminary SELECT but BEFORE B's upsert).
    const aPayload = seedOpenTicket(db, "kb-race-1", "user_A", "A-OWNED");

    // B's request: the preliminary SELECT is blinded (the race), but the
    // upsert runs against the real DB where A's row already exists.
    const d1 = makeD1(db, { blindFirstTicketsSelect: true });
    const result = await insertTicket(d1, "user_B", parsed("kb-race-1", "user_B", "B-HIJACK"));

    // Anti-oracle 404 — NOT a successful overwrite, NOT a distinct "forbidden".
    expect(result).toEqual({ ok: false, code: "not_found" });

    // A's row is UNCHANGED: still user_A, still A's payload. B did not write.
    const after = db
      .prepare("SELECT user_id, payload FROM tickets WHERE id = ?")
      .get("kb-race-1") as { user_id: string; payload: string };
    expect(after.user_id).toBe("user_A");
    expect(after.payload).toBe(aPayload);
    expect(after.payload).not.toContain("B-HIJACK");
  });

  it("a settled row appearing mid-window is reported as cannot_edit_settled, not overwritten", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    // A's ticket settled (won) between B's SELECT and upsert.
    db.prepare(
      `INSERT INTO tickets (id, user_id, serial, race_key, payload, state, payout_base, returned, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("kb-race-2", "user_A", "KB", "rk", JSON.stringify({ owner: "user_A", marker: "A-WON" }), "won", 5000, 12300, 1700000000);

    const d1 = makeD1(db, { blindFirstTicketsSelect: true });
    const result = await insertTicket(d1, "user_A", parsed("kb-race-2", "user_A", "A-EDIT"));

    expect(result).toEqual({ ok: false, code: "cannot_edit_settled_ticket" });
    const after = db.prepare("SELECT state, payload FROM tickets WHERE id = ?").get("kb-race-2") as {
      state: string;
      payload: string;
    };
    expect(after.state).toBe("won"); // settlement preserved
    expect(after.payload).not.toContain("A-EDIT");
  });

  it("legitimate same-owner open-ticket edit still overwrites (regression guard)", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    seedOpenTicket(db, "kb-race-3", "user_A", "A-ORIGINAL");

    // No blinding — A's preliminary SELECT sees A's own open row, proceeds.
    const d1 = makeD1(db);
    const result = await insertTicket(d1, "user_A", parsed("kb-race-3", "user_A", "A-NEW"));

    expect(result.ok).toBe(true);
    const after = db.prepare("SELECT payload FROM tickets WHERE id = ?").get("kb-race-3") as {
      payload: string;
    };
    expect(after.payload).toContain("A-NEW");
  });

  it("fresh create (no prior row) still inserts", async () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);
    const d1 = makeD1(db);
    const result = await insertTicket(d1, "user_A", parsed("kb-race-4", "user_A", "FRESH"));
    expect(result.ok).toBe(true);
    const after = db.prepare("SELECT user_id, payload FROM tickets WHERE id = ?").get("kb-race-4") as {
      user_id: string;
      payload: string;
    } | undefined;
    expect(after?.user_id).toBe("user_A");
    expect(after?.payload).toContain("FRESH");
  });
});
