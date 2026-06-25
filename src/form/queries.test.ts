// SQL parity tests (4b).
//
// Spin up better-sqlite3 in-process, CREATE TABLE form_starts (same DDL as
// migrations/form/0001_form_starts.sql), seed the synthetic 5-race fixture
// data from all_synthetic_starts.json. Then run the Worker's SQL strings
// (imported from queries.ts) and assert the returned rows match what DuckDB
// yields from the fixture lake (the input.json files are DuckDB's PIT-filtered
// output, so they ARE the expected rows for that (entity, as_of) pair).

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as SqliteDb } from "better-sqlite3";
import {
  HORSE_FORM_SQL,
  JOCKEY_FORM_SQL,
  RACE_RUNNERS_FROM_STARTS_SQL,
} from "./queries";
import type { FormStartRow } from "./cardBuilder";

const FIXTURE_DIR = join(__dirname, "test", "fixtures");
const G3_AS_OF = "2026-06-28T06:30:00Z"; // R3 post_time UTC

function loadJson(name: string): FormStartRow[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

let db: SqliteDb;

beforeAll(() => {
  db = new Database(":memory:");
  // Same DDL as migrations/form/0001_form_starts.sql.
  db.exec(`
    CREATE TABLE form_starts (
      horse_name_key       TEXT,
      horse_name           TEXT,
      jockey_id            TEXT,
      trainer_id           TEXT,
      race_id              TEXT,
      horse_number         INTEGER,
      available_at         TEXT,
      race_date            TEXT,
      racecourse           TEXT,
      surface              TEXT,
      distance_m           INTEGER,
      distance_band        TEXT,
      going                TEXT,
      going_wetness        INTEGER,
      is_wet               INTEGER,
      grade_label          TEXT,
      field_size           INTEGER,
      finish_position      INTEGER,
      finish_time_seconds  REAL,
      margin               TEXT,
      last_3f_seconds      REAL,
      last_3f_rank         INTEGER,
      win_odds             REAL,
      popularity           INTEGER,
      beat_market          INTEGER,
      style_signal         TEXT
    );
    CREATE INDEX ix_fs_horse  ON form_starts (horse_name_key, available_at);
    CREATE INDEX ix_fs_jockey ON form_starts (jockey_id, available_at);
    CREATE INDEX ix_fs_race   ON form_starts (race_id);
  `);

  const allRows = loadJson("all_synthetic_starts.json");
  const cols = [
    "horse_name_key", "horse_name", "jockey_id", "trainer_id", "race_id",
    "horse_number", "available_at", "race_date", "racecourse", "surface",
    "distance_m", "distance_band", "going", "going_wetness", "is_wet",
    "grade_label", "field_size", "finish_position", "finish_time_seconds",
    "margin", "last_3f_seconds", "last_3f_rank", "win_odds", "popularity",
    "beat_market", "style_signal",
  ];
  const placeholders = cols.map(() => "?").join(", ");
  const insert = db.prepare(
    `INSERT INTO form_starts (${cols.join(", ")}) VALUES (${placeholders})`,
  );
  const insertMany = db.transaction((rows: FormStartRow[]) => {
    for (const r of rows) {
      insert.run(...cols.map((c) => (r as unknown as Record<string, unknown>)[c] ?? null));
    }
  });
  insertMany(allRows);
});

describe("HORSE_FORM_SQL PIT filter + ordering", () => {
  it("returns Alpha's 2 starts before the G3 (R0 + R1; R4 future-excluded)", () => {
    const rows = db.prepare(HORSE_FORM_SQL).all("Alpha", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(2);
    // Newest-first ordering.
    expect(rows[0].race_id).toBe("jra-20260601-05-01"); // R1 (June 1)
    expect(rows[1].race_id).toBe("jra-20260520-05-01"); // R0 (May 20)
  });

  it("returns Alpha's 3 starts when as_of is past R4", () => {
    const rows = db.prepare(HORSE_FORM_SQL).all("Alpha", "2026-12-31T00:00:00Z") as FormStartRow[];
    expect(rows).toHaveLength(3);
    expect(rows[0].race_id).toBe("jra-20260710-05-01"); // R4 newest
  });

  it("excludes a start at the exact as_of (strict less-than)", () => {
    // R1's available_at is exactly 2026-06-01T06:00:00Z. AsOf = that instant.
    const rows = db.prepare(HORSE_FORM_SQL).all("Alpha", "2026-06-01T06:00:00Z") as FormStartRow[];
    expect(rows).toHaveLength(1); // only R0
    expect(rows[0].race_id).toBe("jra-20260520-05-01");
  });

  it("returns 0 rows for an unknown horse (no_history fallback path)", () => {
    const rows = db.prepare(HORSE_FORM_SQL).all("Nobody", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(0);
  });

  it("returns Gamma's 1 start", () => {
    const rows = db.prepare(HORSE_FORM_SQL).all("Gamma", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].race_id).toBe("jra-20260601-05-01");
  });

  it("returns Beta's 1 start", () => {
    const rows = db.prepare(HORSE_FORM_SQL).all("Beta", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].race_id).toBe("jra-20260608-05-01");
  });
});

describe("JOCKEY_FORM_SQL PIT filter", () => {
  it("returns j01's 3 starts before the G3 (Alpha R0+R1, Beta R2)", () => {
    const rows = db.prepare(JOCKEY_FORM_SQL).all("j01", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(3);
    const raceIds = rows.map((r) => r.race_id).sort();
    expect(raceIds).toEqual([
      "jra-20260520-05-01",
      "jra-20260601-05-01",
      "jra-20260608-05-01",
    ]);
  });

  it("returns j03's 1 start (Gamma at R1)", () => {
    const rows = db.prepare(JOCKEY_FORM_SQL).all("j03", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].horse_name).toBe("Gamma");
  });

  it("returns 0 rows for j02 (R3 is upcoming, no completed starts)", () => {
    const rows = db.prepare(JOCKEY_FORM_SQL).all("j02", G3_AS_OF) as FormStartRow[];
    expect(rows).toHaveLength(0);
  });
});

describe("RACE_RUNNERS_FROM_STARTS_SQL (historical-race fallback)", () => {
  it("returns the distinct runner set for a historical race", () => {
    const rows = db
      .prepare(RACE_RUNNERS_FROM_STARTS_SQL)
      .all("jra-20260601-05-01") as { horse_name_key: string; horse_name: string }[];
    expect(rows.map((r) => r.horse_name).sort()).toEqual(["Alpha", "Gamma"]);
  });

  it("returns 0 rows for an upcoming race (R3 has no completed starts)", () => {
    const rows = db
      .prepare(RACE_RUNNERS_FROM_STARTS_SQL)
      .all("jra-20260628-05-11") as unknown[];
    expect(rows).toHaveLength(0);
  });

  it("returns 0 rows for an unknown race", () => {
    const rows = db
      .prepare(RACE_RUNNERS_FROM_STARTS_SQL)
      .all("jra-99999999-99-99") as unknown[];
    expect(rows).toHaveLength(0);
  });
});

describe("dup invariant (one row per horse_name_key + race_id)", () => {
  it("has no duplicate (horse_name_key, race_id) pairs in the seeded data", () => {
    const dups = db
      .prepare(
        "SELECT horse_name_key, race_id, COUNT(*) c FROM form_starts "
          + "GROUP BY 1, 2 HAVING c > 1",
      )
      .all() as unknown[];
    expect(dups).toHaveLength(0);
  });
});
