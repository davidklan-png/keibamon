// Tests for the /api/weekly-report read path (src/reference/weekly.ts).
//
// Mirrors the form routes.test.ts pattern: drive handleWeeklyReportRoutes with
// a tiny D1 shim (makeFakeD1 over better-sqlite3). Covers:
//   - empty table → { status: "empty" }
//   - seeded editions → { status: "published", inputs: [...] } (latest first)
//   - table-missing (prepare throws) → graceful empty
//   - no DB binding → empty
//   - non-GET → 405
//   - non-matching path → null fall-through
//   - malformed payload row is skipped, not fatal

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import { handleWeeklyReportRoutes, type WeeklyReportEnv } from "./weekly";
import { makeFakeD1 } from "../form/test/fakeD1";

// Parsed body shape of GET /api/weekly-report (typed so the assertions below
// don't fall back to `unknown`). A discriminated union models the two response
// shapes: empty (no inputs) vs published (inputs required).
type WeeklyPublishedInputs = Array<{
  version: number;
  edition_key: string;
  gate_snapshot_at: string | null;
}>;

type WeeklyBody =
  | { status: "empty" }
  | { status: "published"; inputs: WeeklyPublishedInputs };

async function bodyOf(res: Response): Promise<WeeklyBody> {
  return (await res.json()) as WeeklyBody;
}

// Narrows to the published branch so test assertions can reach `.inputs`
// without a non-null assertion. Throws if the response wasn't published —
// which is the test's intent, so the failure message stays clear.
async function publishedInputs(res: Response): Promise<WeeklyPublishedInputs> {
  const body = await bodyOf(res);
  if (body.status !== "published") {
    throw new Error(`expected published, got ${body.status}`);
  }
  return body.inputs;
}

// The local fake D1 (from fakeD1.ts) is structurally smaller than the global
// D1Database type (@cloudflare/workers-types adds batch/exec/withSession/dump).
// Cast through unknown — runtime behavior is unchanged; this only satisfies tsc.
function withFakeDb(db: ReturnType<typeof makeFakeD1>): WeeklyReportEnv {
  return { DB: db } as unknown as WeeklyReportEnv;
}

function weekendInput(version: number) {
  return {
    edition_key: "2026-W26",
    edition_label: version === 1 ? "Friday edition" : "Saturday refresh",
    weekend_label: "June 27–28, 2026",
    version,
    published_at: `2026-06-2${version + 5}T09:00:00Z`,
    odds_snapshot_at: version === 1 ? null : "2026-06-27T00:15:00Z",
    gate_snapshot_at: "2026-06-26T08:00:00Z",
    card_snapshot_at: "2026-06-26T07:30:00Z",
    condition_snapshot_at: null,
    races: [
      {
        race_id: `jra-2026-0628-09-11`,
        name: "Takarazuka Kinen",
        grade: "G1",
        venue: "Hanshin",
        surface: "turf",
        distance_m: 2200,
        post_time: "15:40",
        date: "2026-06-28",
        runners: [
          { horse_number: 1, horse_name: "Starlight Vow", gate: 1, win_odds: 3.2 },
        ],
      },
    ],
  };
}

function withTable(db: SqliteDb) {
  db.exec(`
    CREATE TABLE weekly_report (
      edition_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      published_at TEXT NOT NULL,
      PRIMARY KEY (edition_key, version)
    );
  `);
}

function seed(db: SqliteDb, version: number, payload: string) {
  db.prepare(
    "INSERT INTO weekly_report (edition_key, version, payload, published_at) VALUES (?, ?, ?, ?)",
  ).run("2026-W26", version, payload, `2026-06-2${version + 5}T09:00:00Z`);
}

describe("GET /api/weekly-report", () => {
  it("returns {status:'empty'} when the table is empty", async () => {
    const db = new Database(":memory:");
    withTable(db);
    const env = withFakeDb(makeFakeD1(db));
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report"),
      env,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await bodyOf(res!);
    expect(body).toEqual({ status: "empty" });
  });

  it("returns published editions, latest version first", async () => {
    const db = new Database(":memory:");
    withTable(db);
    seed(db, 1, JSON.stringify(weekendInput(1)));
    seed(db, 2, JSON.stringify(weekendInput(2)));
    const env = withFakeDb(makeFakeD1(db));
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report"),
      env,
    );
    const inputs = await publishedInputs(res!);
    expect(inputs.length).toBe(2);
    // ORDER BY version DESC → Saturday (v2) first.
    expect(inputs[0].version).toBe(2);
    expect(inputs[1].version).toBe(1);
    // Payload integrity: edition_key + snapshot timestamps carried through.
    expect(inputs[0].edition_key).toBe("2026-W26");
    expect(inputs[0].gate_snapshot_at).toBe("2026-06-26T08:00:00Z");
  });

  it("limits to the latest edition — older editions are not returned", async () => {
    const db = new Database(":memory:");
    withTable(db);
    // An older edition (W25 < W26 lexicographically).
    db.prepare(
      "INSERT INTO weekly_report (edition_key, version, payload, published_at) VALUES (?, ?, ?, ?)",
    ).run("2026-W25", 1, JSON.stringify(weekendInput(1)), "2026-06-19T09:00:00Z");
    // The current edition.
    seed(db, 1, JSON.stringify(weekendInput(2)));
    const env = withFakeDb(makeFakeD1(db));
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report"),
      env,
    );
    const inputs = await publishedInputs(res!);
    // Only the latest edition (W26) — its history of past editions is not streamed.
    expect(inputs.length).toBe(1);
    expect(inputs[0].edition_key).toBe("2026-W26");
  });

  it("degrades to empty when the table is missing (prepare throws)", async () => {
    // A DB whose .prepare throws on any SQL — emulates an unmigrated D1.
    // Cast to the global D1Database type (no import of the local shim type).
    const throwingDb = {
      prepare() {
        throw new Error("no such table: weekly_report");
      },
    } as unknown as import("@cloudflare/workers-types").D1Database;
    const env: WeeklyReportEnv = { DB: throwingDb };
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report"),
      env,
    );
    const body = await bodyOf(res!);
    expect(body).toEqual({ status: "empty" });
  });

  it("degrades to empty when no DB binding is present", async () => {
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report"),
      {} as WeeklyReportEnv,
    );
    const body = await bodyOf(res!);
    expect(body).toEqual({ status: "empty" });
  });

  it("skips a malformed payload row but still serves the good ones", async () => {
    const db = new Database(":memory:");
    withTable(db);
    seed(db, 1, "{not valid json"); // corrupted
    seed(db, 2, JSON.stringify(weekendInput(2)));
    const env = withFakeDb(makeFakeD1(db));
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report"),
      env,
    );
    const inputs = await publishedInputs(res!);
    expect(inputs.length).toBe(1); // only v2 survived
    expect(inputs[0].version).toBe(2);
  });
});

describe("/api/weekly-report routing", () => {
  it("non-matching path → null (falls through)", async () => {
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/live"),
      withFakeDb(makeFakeD1(new Database(":memory:"))),
    );
    expect(res).toBeNull();
  });

  it("non-GET → 405", async () => {
    const res = await handleWeeklyReportRoutes(
      new Request("https://test/api/weekly-report", { method: "POST" }),
      withFakeDb(makeFakeD1(new Database(":memory:"))),
    );
    expect(res!.status).toBe(405);
  });
});
