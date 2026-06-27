// ============================================================================
// Scheduled-handler integration test for the rolling live roundup edition.
//
// Spins up a better-sqlite3 in-memory DB with BOTH live_snapshot (the read)
// and weekly_report (the write). Drives the actual `scheduled` export of
// src/worker.js via the default export and verifies:
//   1. A graded snapshot upserts exactly one row at LIVE_VERSION (90).
//   2. Re-running with an updated snapshot UPSERTs in place (still one row).
//   3. A non-graded snapshot is a no-op (no row written, no row deleted).
//   4. A missing DB binding is a silent no-op (handler never throws).
//   5. Existing manual v1/v2 rows are untouched by the live upsert.
//
// Pattern mirrors src/reference/weekly.test.ts (makeFakeD1 over better-sqlite3).
// ============================================================================

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import { makeFakeD1 } from "./form/test/fakeD1";
import worker from "./worker.js";
import { LIVE_VERSION } from "./reference/buildLiveEdition";

// `scheduled` is part of the Workers default export. The signature is
// (event, env, ctx, now?) — the 4th arg is a test-injection knob for the
// staleness gate; production defaults to `new Date()`.
const scheduled = (worker as { scheduled: (e: unknown, env: unknown, ctx: unknown, now?: Date) => Promise<void> }).scheduled;

// Fixed tick time for deterministic freshness math. The default snapshot
// fixture below is published at 06:15:00Z — 15 min before NOW, comfortably
// inside the 20-min staleness threshold.
const NOW = new Date("2026-06-27T06:30:00Z");

function gradedSnapshot(opts: { publishedAt?: string; races?: unknown[] } = {}) {
  return {
    meta: {
      published_at: opts.publishedAt ?? "2026-06-27T06:15:00Z",
      status: "live",
    },
    races: opts.races ?? [
      {
        race_id: "202606050911",
        race_no: 11,
        name: "Takarazuka Kinen",
        grade_label: "G1",
        venue: "Hanshin",
        surface: "turf",
        distance_m: 2200,
        post_time: "15:40",
        date: "2026-06-28",
        runners: [
          { umaban: 1, name: "Starlight Vow", win_odds: 3.2 },
          { umaban: 4, name: "Deep Edge", win_odds: 7.8 },
        ],
      },
    ],
  };
}

function withMigrations(db: SqliteDb) {
  db.exec(`
    CREATE TABLE live_snapshot (
      key          TEXT    NOT NULL PRIMARY KEY,
      payload      TEXT    NOT NULL,
      published_at TEXT    NOT NULL
    );
    CREATE TABLE weekly_report (
      edition_key  TEXT    NOT NULL,
      version      INTEGER NOT NULL,
      payload      TEXT    NOT NULL,
      published_at TEXT    NOT NULL,
      PRIMARY KEY (edition_key, version)
    );
  `);
}

function seedSnapshot(db: SqliteDb, payload: unknown, publishedAt = "2026-06-27T06:15:00Z") {
  db.prepare(
    "INSERT INTO live_snapshot (key, payload, published_at) VALUES (?, ?, ?)",
  ).run("current", JSON.stringify(payload), publishedAt);
}

function seedManualEdition(db: SqliteDb, version: number, payload: unknown) {
  db.prepare(
    "INSERT INTO weekly_report (edition_key, version, payload, published_at) VALUES (?, ?, ?, ?)",
  ).run("2026-W26", version, JSON.stringify(payload), `2026-06-2${version + 5}T09:00:00Z`);
}

function weeklyRows(db: SqliteDb) {
  return db
    .prepare(
      "SELECT edition_key, version, payload, published_at FROM weekly_report ORDER BY edition_key DESC, version DESC",
    )
    .all() as Array<{ edition_key: string; version: number; payload: string; published_at: string }>;
}

describe("scheduled handler — rolling live edition upsert", () => {
  it("UPSERTs a single row at LIVE_VERSION when a graded snapshot is current", async () => {
    const db = new Database(":memory:");
    withMigrations(db);
    seedSnapshot(db, gradedSnapshot());
    const env = { DB: makeFakeD1(db) };

    await scheduled({}, env, {}, NOW);

    const rows = weeklyRows(db);
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe(LIVE_VERSION);
    expect(rows[0].edition_key).toBe("2026-W26");
    // Payload is well-formed WeekendInput.
    const payload = JSON.parse(rows[0].payload);
    expect(payload.version).toBe(LIVE_VERSION);
    expect(payload.races.length).toBe(1);
    expect(payload.races[0].name).toBe("Takarazuka Kinen"); // polish applied
    expect(payload.races[0].name_ja).toBe("宝塚記念");
    // Live label format.
    expect(payload.edition_label).toMatch(/^Live — auto-refreshed \d{2}:\d{2} JST$/);
  });

  it("re-running with a fresh snapshot updates the row in place (no second row)", async () => {
    const db = new Database(":memory:");
    withMigrations(db);
    seedSnapshot(db, gradedSnapshot({ publishedAt: "2026-06-27T06:15:00Z" }));
    const env = { DB: makeFakeD1(db) };

    await scheduled({}, env, {}, NOW);
    // Update the snapshot's published_at + a runner odds change.
    db.prepare("UPDATE live_snapshot SET payload = ?, published_at = ? WHERE key = ?").run(
      JSON.stringify(
        gradedSnapshot({
          publishedAt: "2026-06-27T06:25:00Z",
          races: [
            {
              race_id: "202606050911",
              race_no: 11,
              name: "Takarazuka Kinen",
              grade_label: "G1",
              venue: "Hanshin",
              surface: "turf",
              distance_m: 2200,
              post_time: "15:40",
              date: "2026-06-28",
              runners: [{ umaban: 1, name: "Starlight Vow", win_odds: 2.9 }],
            },
          ],
        }),
      ),
      "2026-06-27T06:25:00Z",
      "current",
    );

    await scheduled({}, env, {}, NOW);

    const rows = weeklyRows(db);
    expect(rows.length).toBe(1); // STILL one row — UPSERT in place.
    const payload = JSON.parse(rows[0].payload);
    // New odds propagated through.
    expect(payload.races[0].runners[0].win_odds).toBe(2.9);
    // Snapshot stamp updated.
    expect(payload.odds_snapshot_at).toBe("2026-06-27T06:25:00Z");
  });

  it("does NOT touch existing manual v1/v2 editions (only LIVE_VERSION row is written)", async () => {
    const db = new Database(":memory:");
    withMigrations(db);
    seedSnapshot(db, gradedSnapshot());
    // Pre-existing manual editions (the operator ran wrangler d1 execute on Friday/Saturday).
    seedManualEdition(db, 1, { edition_key: "2026-W26", version: 1, races: [], weekend_label: "manual-fri" });
    seedManualEdition(db, 2, { edition_key: "2026-W26", version: 2, races: [], weekend_label: "manual-sat" });
    const env = { DB: makeFakeD1(db) };

    await scheduled({}, env, {}, NOW);

    const rows = weeklyRows(db);
    // v90 (live) + v2 + v1 — three rows total, manual ones untouched.
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.version)).toEqual([90, 2, 1]);
    // Manual payloads preserved exactly.
    const manualV1 = JSON.parse(rows.find((r) => r.version === 1)!.payload);
    const manualV2 = JSON.parse(rows.find((r) => r.version === 2)!.payload);
    expect(manualV1.weekend_label).toBe("manual-fri");
    expect(manualV2.weekend_label).toBe("manual-sat");
  });

  it("no-op (no write, no throw) when the snapshot has no graded races", async () => {
    const db = new Database(":memory:");
    withMigrations(db);
    seedSnapshot(db, {
      meta: { published_at: "2026-06-27T06:15:00Z" },
      races: [{ race_id: "x", grade_label: "OP", runners: [] }],
    });
    const env = { DB: makeFakeD1(db) };

    await scheduled({}, env, {}, NOW);

    expect(weeklyRows(db).length).toBe(0);
  });

  it("no-op when there is no 'current' snapshot key", async () => {
    const db = new Database(":memory:");
    withMigrations(db);
    // No seed — live_snapshot is empty.
    const env = { DB: makeFakeD1(db) };

    await scheduled({}, env, {}, NOW);

    expect(weeklyRows(db).length).toBe(0);
  });

  it("no-op + no throw when DB binding is absent (handler is total)", async () => {
    // No env.DB at all — handler must swallow and return without throwing.
    await expect(scheduled({}, {}, {}, NOW)).resolves.toBeUndefined();
  });

  it("no-op + no throw on malformed snapshot JSON in D1", async () => {
    const db = new Database(":memory:");
    withMigrations(db);
    db.prepare(
      "INSERT INTO live_snapshot (key, payload, published_at) VALUES (?, ?, ?)",
    ).run("current", "{not valid json", "2026-06-27T06:15:00Z");
    const env = { DB: makeFakeD1(db) };

    await expect(scheduled({}, env, {}, NOW)).resolves.toBeUndefined();
    expect(weeklyRows(db).length).toBe(0);
  });

  it("no-op on stale snapshot; existing v90 row is left untouched (stalled producer)", async () => {
    // ADR-0010 staleness guard: when the producer heartbeat is older than
    // MAX_SNAPSHOT_STALENESS_MS, the builder refuses to republish and the
    // prior v90 row freezes in place.
    const db = new Database(":memory:");
    withMigrations(db);
    // First tick: fresh snapshot (15 min old) → v90 row written with these odds.
    seedSnapshot(db, gradedSnapshot({ publishedAt: "2026-06-27T06:15:00Z" }));
    const env = { DB: makeFakeD1(db) };
    await scheduled({}, env, {}, NOW);
    const rowsAfterFresh = weeklyRows(db);
    expect(rowsAfterFresh.length).toBe(1);
    const freshPayload = JSON.parse(rowsAfterFresh[0].payload);
    expect(freshPayload.races[0].runners[0].win_odds).toBe(3.2);
    expect(freshPayload.odds_snapshot_at).toBe("2026-06-27T06:15:00Z");

    // Now the producer stalls: update the snapshot payload (new odds) but
    // back-date the heartbeat beyond the 20-min threshold.
    db.prepare("UPDATE live_snapshot SET payload = ?, published_at = ? WHERE key = ?").run(
      JSON.stringify(
        gradedSnapshot({
          publishedAt: "2026-06-27T05:00:00Z", // 90 min before NOW → stale
          races: [
            {
              race_id: "202606050911",
              race_no: 11,
              name: "Takarazuka Kinen",
              grade_label: "G1",
              venue: "Hanshin",
              surface: "turf",
              distance_m: 2200,
              post_time: "15:40",
              date: "2026-06-28",
              runners: [{ umaban: 1, name: "Starlight Vow", win_odds: 9.9 }],
            },
          ],
        }),
      ),
      "2026-06-27T05:00:00Z",
      "current",
    );

    await scheduled({}, env, {}, NOW);

    // Still exactly one row; its payload is the FRESH capture, not the stale one.
    const rowsAfterStale = weeklyRows(db);
    expect(rowsAfterStale.length).toBe(1);
    const frozenPayload = JSON.parse(rowsAfterStale[0].payload);
    expect(frozenPayload.races[0].runners[0].win_odds).toBe(3.2); // NOT 9.9
    expect(frozenPayload.odds_snapshot_at).toBe("2026-06-27T06:15:00Z"); // NOT 05:00
    // published_at of the row itself is also frozen (no republish happened).
    expect(rowsAfterStale[0].published_at).toBe(rowsAfterFresh[0].published_at);
  });
});
