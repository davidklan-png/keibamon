// Route parity tests (4c).
//
// Drives src/form/index.ts `handleFormRoutes` end-to-end with a tiny in-process
// D1Database shim (fakeD1.ts). env.FORM wraps better-sqlite3 seeded with the
// synthetic 5-race fixture; env.DB returns a canned live snapshot for the
// race-batch route.
//
// Pins: horse (ok + no_history), jockey (ok + no_history), race batch (post_time
// default + explicit as_of + unknown→404), tolerant as_of parsing.

import { describe, it, expect, beforeAll, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as SqliteDb } from "better-sqlite3";
import { handleFormRoutes, type FormEnv } from "./index";
import type { FormStartRow } from "./cardBuilder";
import { makeFakeD1, makeSnapshotD1 } from "./test/fakeD1";

const FIXTURE_DIR = join(__dirname, "test", "fixtures");
const G3_RACE_ID = "jra-20260628-05-11"; // R3 (upcoming G3)

function loadJson(name: string): FormStartRow[] {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

let db: SqliteDb;
let env: FormEnv;

beforeAll(() => {
  db = new Database(":memory:");
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

  const liveSnap = {
    meta: { date: "20260628", status: "ok" },
    races: [
      {
        race_id: G3_RACE_ID,
        race_no: 11,
        name: "G3 Feature",
        post_time: "15:30", // JST
        venue: "Tokyo",
        date: "20260628",
        runners: [{ umaban: 1, name: "Alpha", win_odds: 3.0 }],
      },
    ],
  };
  // The fakes implement only the D1 subset handleFormRoutes touches (prepare/
  // bind/all/first); cast past the fuller global D1Database surface the typed
  // env demands (batch/exec/withSession/dump). Test-only — production uses real D1.
  env = {
    FORM: makeFakeD1(db) as unknown as D1Database,
    DB: makeSnapshotD1({ current: liveSnap }) as unknown as D1Database,
  };
});

async function callRoute(pathWithQuery: string): Promise<Response> {
  // handleFormRoutes returns Promise<Response | null> (null = non-form path
  // fell through). Every callRoute() test hits a form route, so the null branch
  // never fires here — assert it away after awaiting.
  return (await handleFormRoutes(
    new Request(`https://test${pathWithQuery}`),
    env,
  )) as Response;
}

describe("GET /api/horses/:name/form", () => {
  it("Alpha (as_of at G3 post) → ok + 2 starts (R4 PIT-excluded)", async () => {
    const r = await callRoute("/api/horses/Alpha/form?as_of=2026-06-28T06:30:00Z");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.career.starts).toBe(2);
    expect(body.career.wins).toBe(1);
    expect(body.context_note).toMatch(/not betting advice/i);
  });

  it("Alpha (no as_of) → ok + 2 starts (now = 2026-06-25 excludes R4)", async () => {
    // The route defaults as_of to real `now`. Pin the wall-clock so this is
    // deterministic — Alpha's R4 start is dated 2026-07-10, so once the real
    // calendar crosses that date R4 enters the PIT window and the start count
    // drifts from 2 to 3. Pin to 2026-06-25 (between R1 and R4) per the case.
    vi.useFakeTimers({ now: new Date("2026-06-25T00:00:00Z") });
    try {
      const r = await callRoute("/api/horses/Alpha/form");
      expect(r.status).toBe(200);
      const body = (await r.json()) as any;
      expect(body.status).toBe("ok");
      expect(body.career.starts).toBe(2);
      expect(body.as_of).toBeNull(); // raw param value reflected back
    } finally {
      vi.useRealTimers();
    }
  });

  it("Alpha (compact YYYYMMDD as_of) → tolerant parse", async () => {
    const r = await callRoute("/api/horses/Alpha/form?as_of=20260628");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.career.starts).toBe(2); // R0+R1; R4 still in the future
  });

  it("Nobody (unknown) → no_history", async () => {
    const r = await callRoute("/api/horses/Nobody/form");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("no_history");
    expect(body.horse_name).toBe("Nobody");
    expect(body.as_of).toBeNull();
  });

  it("Japanese name round-trips unencoded-then-decoded", async () => {
    // ガンバレ is a normalized-key candidate (NFKC-stable).
    const r = await callRoute("/api/horses/%E3%82%AC%E3%83%B3%E3%83%90%E3%83%AC/form");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("no_history");
    expect(body.horse_name).toBe("ガンバレ");
  });
});

describe("GET /api/jockeys/:id/form", () => {
  it("j01 (as_of at G3) → 3 starts + Alpha/Beta combos", async () => {
    const r = await callRoute("/api/jockeys/j01/form?as_of=2026-06-28T06:30:00Z");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("ok");
    expect(body.career.starts).toBe(3);
    const byHorse = Object.fromEntries(
      body.combos.by_horse.map((c: { horse_name_key: string }) => [c.horse_name_key, c]),
    );
    expect(byHorse.Alpha.starts).toBe(2);
  });

  it("j02 (no completed starts; R3 is upcoming) → no_history", async () => {
    const r = await callRoute("/api/jockeys/j02/form");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.status).toBe("no_history");
    expect(body.jockey_id).toBe("j02");
  });
});

describe("GET /api/races/:race_id/form", () => {
  it("upcoming G3 (no as_of) → defaults to race post_time; Alpha card has 2 starts", async () => {
    const r = await callRoute(`/api/races/${G3_RACE_ID}/form`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.race_id).toBe(G3_RACE_ID);
    expect(body.as_of).toBeNull();
    expect(body.runners).toHaveLength(1);
    expect(body.runners[0].horse_name).toBe("Alpha");
    expect(body.runners[0].horse_number).toBe(1);
    expect(body.runners[0].form.status).toBe("ok");
    expect(body.runners[0].form.career.starts).toBe(2); // R0+R1; R4 PIT-excluded
  });

  it("explicit as_of overrides the post_time default", async () => {
    // as_of past R4 → Alpha's card should have 3 starts.
    const r = await callRoute(
      `/api/races/${G3_RACE_ID}/form?as_of=2026-12-31T00:00:00Z`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.as_of).toBe("2026-12-31T00:00:00Z");
    expect(body.runners[0].form.career.starts).toBe(3);
  });

  it("historical race (no live-snapshot entry) → falls back to form_starts runners", async () => {
    // R1 (jra-20260601-05-01) is in the past — not in the live snapshot.
    const r = await callRoute("/api/races/jra-20260601-05-01/form");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.race_id).toBe("jra-20260601-05-01");
    const names = body.runners.map((r: { horse_name: string }) => r.horse_name).sort();
    expect(names).toEqual(["Alpha", "Gamma"]);
  });

  it("unknown race (no live entry, no form_starts rows) → 404", async () => {
    const r = await callRoute("/api/races/jra-99999999-99-99/form");
    expect(r.status).toBe(404);
  });
});

describe("non-form path falls through (returns null)", () => {
  it("/api/live is NOT claimed by handleFormRoutes", async () => {
    const r = await handleFormRoutes(
      new Request("https://test/api/live"),
      env,
    );
    expect(r).toBeNull();
  });

  it("/api/horses/Alpha (no /form suffix) → null", async () => {
    const r = await handleFormRoutes(
      new Request("https://test/api/horses/Alpha"),
      env,
    );
    expect(r).toBeNull();
  });
});
