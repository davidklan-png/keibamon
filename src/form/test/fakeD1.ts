// Minimal D1Database shim over better-sqlite3, for route parity tests (4c).
//
// D1Database's surface is small: prepare(sql) → Statement; .bind(*vals) →
// BoundStatement; .all() → Promise<{results}>; .first() → Promise<row|null>.
// We implement just enough to drive src/form/index.ts's routes — SELECT, and
// the queries are all prepared with positional ? placeholders (D1 / sqlite
// both use the same syntax).

import type { Database as SqliteDb } from "better-sqlite3";

export interface D1Result {
  results: Record<string, unknown>[];
  success: true;
  meta: { changes: number };
}

export interface D1BoundStatement {
  all(): Promise<D1Result>;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<D1Result>;
}

export interface D1Statement {
  bind(...vals: unknown[]): D1BoundStatement;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
}

export function makeFakeD1(db: SqliteDb): D1Database {
  return {
    prepare(sql: string): D1Statement {
      return {
        bind(...vals: unknown[]): D1BoundStatement {
          const stmt = db.prepare(sql);
          return {
            async all(): Promise<D1Result> {
              const results = stmt.all(...vals) as Record<string, unknown>[];
              return { results, success: true, meta: { changes: 0 } };
            },
            async first(): Promise<Record<string, unknown> | null> {
              const row = stmt.get(...vals) as Record<string, unknown> | undefined;
              return row ?? null;
            },
            async run(): Promise<D1Result> {
              const info = stmt.run(...vals);
              return {
                results: [],
                success: true,
                meta: { changes: info.changes },
              };
            },
          };
        },
      };
    },
  };
}

// A canned D1DB backed by a Map<key, JSON-payload>. Used to stub env.DB (the
// live_snapshot table) without spinning up a second sqlite. The "table" is a
// single key→payload mapping that matches the production live_snapshot shape.
export function makeSnapshotD1(snapshot: { current?: unknown; hanshin?: unknown }): D1Database {
  const lookup = new Map<string, string>();
  if (snapshot.current !== undefined) {
    lookup.set("current", JSON.stringify(snapshot.current));
  }
  if (snapshot.hanshin !== undefined) {
    lookup.set("hanshin", JSON.stringify(snapshot.hanshin));
  }
  return {
    prepare(sql: string): D1Statement {
      // Recognize only the live_snapshot SELECT used by index.ts.
      if (!sql.includes("live_snapshot")) {
        throw new Error(`makeSnapshotD1: unexpected SQL: ${sql}`);
      }
      return {
        bind(...vals: unknown[]): D1BoundStatement {
          const key = vals[0] as string;
          return {
            async all(): Promise<D1Result> {
              const payload = lookup.get(key);
              return payload
                ? { results: [{ key, payload }], success: true, meta: { changes: 0 } }
                : { results: [], success: true, meta: { changes: 0 } };
            },
            async first(): Promise<Record<string, unknown> | null> {
              const payload = lookup.get(key);
              return payload ? { key, payload } : null;
            },
            async run(): Promise<D1Result> {
              return { results: [], success: true, meta: { changes: 0 } };
            },
          };
        },
      };
    },
  };
}
