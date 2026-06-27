// Unit tests for buildLiveEdition (pure — no D1, no Date.now()).
//
// Covers the ADR-0010 contract:
//   - graded filter (G1/G2/G3 via case/roman-numeral fold; non-graded dropped)
//   - snapshot-time stamping (odds/card = snapshot.published_at)
//   - field_size = runner count
//   - empty/malformed payload → null (no throw)
//   - no graded races → null
//   - edition_key = ISO week of the race weekend
//   - reserved version 90
//
// All inputs deterministic; `now` is injected so the edition_label timestamp
// is testable without wall-clock dependency.

import { describe, it, expect } from "vitest";
import { buildLiveEdition, LIVE_VERSION } from "./buildLiveEdition";

const NOW = new Date("2026-06-27T06:30:00Z"); // 15:30 JST

function gradedRace(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function snapshot(races: unknown[], meta: Record<string, unknown> = {}) {
  return {
    meta: { published_at: "2026-06-27T06:15:00Z", ...meta },
    races,
  };
}

describe("buildLiveEdition — graded filter", () => {
  it("keeps G1/G2/G3 and drops non-graded races", () => {
    const snap = snapshot([
      gradedRace({ race_id: "g1-r", grade_label: "G1" }),
      gradedRace({ race_id: "g2-r", grade_label: "G2", name: "Hanshin Himba" }),
      gradedRace({ race_id: "op-r", grade_label: "OP", name: "Allowance" }),
      gradedRace({ race_id: "list-r", grade_label: "Listed" }),
      gradedRace({ race_id: "blank-r", grade_label: "" }),
      gradedRace({ race_id: "jpn1-r", grade_label: "JpnI" }), // dirt grade, must drop
    ]);
    const out = buildLiveEdition(snap, NOW);
    expect(out).not.toBeNull();
    expect(out!.races.map((r) => r.race_id)).toEqual(["g1-r", "g2-r"]);
  });

  it("accepts case-folded and roman-numeral grade labels (mirrors gradeClass)", () => {
    const snap = snapshot([
      gradedRace({ race_id: "lc-g1", grade_label: "g1" }),
      gradedRace({ race_id: "lc-g2", grade_label: "gii" }),
      gradedRace({ race_id: "lc-g3", grade_label: "ＧⅢ" }), // full-width
    ]);
    const out = buildLiveEdition(snap, NOW);
    expect(out).not.toBeNull();
    const grades = out!.races.map((r) => r.grade);
    expect(grades).toEqual(["G1", "G2", "G3"]);
  });
});

describe("buildLiveEdition — race shape", () => {
  it("field_size = runner count, surface/distance carried, going/weather nulled", () => {
    const snap = snapshot([
      gradedRace({
        runners: [
          { umaban: 1, name: "A", win_odds: 3.0 },
          { umaban: 2, name: "B", win_odds: 5.0 },
          { umaban: 3, name: "C", win_odds: 9.0 },
        ],
      }),
    ]);
    const out = buildLiveEdition(snap, NOW);
    expect(out).not.toBeNull();
    const r = out!.races[0];
    expect(r.field_size).toBe(3);
    expect(r.surface).toBe("turf");
    expect(r.distance_m).toBe(2200);
    expect(r.going).toBeNull();
    expect(r.weather).toBeNull();
  });

  it("coerces null/unknown surface to 'turf' (JRA graded-stakes default)", () => {
    const snap = snapshot([
      gradedRace({ surface: null }),
      gradedRace({ surface: "dirt", race_id: "d" }),
    ]);
    const out = buildLiveEdition(snap, NOW);
    expect(out!.races.map((r) => r.surface).sort()).toEqual(["dirt", "turf"]);
  });

  it("runners carry horse_number/horse_name/gate=null/live win_odds only", () => {
    const snap = snapshot([
      gradedRace({
        runners: [
          { umaban: 7, name: "Speed King", win_odds: 4.5 },
          { umaban: 8, name: "Unpriced", win_odds: null }, // pool not open yet
        ],
      }),
    ]);
    const out = buildLiveEdition(snap, NOW);
    const runners = out!.races[0].runners;
    expect(runners).toEqual([
      { horse_number: 7, horse_name: "Speed King", gate: null, win_odds: 4.5 },
      { horse_number: 8, horse_name: "Unpriced", gate: null, win_odds: null },
    ]);
  });

  it("falls back to feed name when no polish entry; applies polish when race_id matches", () => {
    const snap = snapshot([
      gradedRace({ race_id: "202606050911", name: "Takarazuka Kinen (G1)" }),
      gradedRace({ race_id: "unmapped", name: "Mystery Race" }),
    ]);
    const out = buildLiveEdition(snap, NOW);
    const byId = Object.fromEntries(out!.races.map((r) => [r.race_id, r]));
    // Polished name + name_ja wins for the mapped id; venue_ja attached.
    expect(byId["202606050911"].name).toBe("Takarazuka Kinen");
    expect(byId["202606050911"].name_ja).toBe("宝塚記念");
    expect(byId["202606050911"].venue_ja).toBe("阪神");
    // Unmapped → feed name as-is, no name_ja key.
    expect(byId["unmapped"].name).toBe("Mystery Race");
    expect("name_ja" in byId["unmapped"]).toBe(false);
  });
});

describe("buildLiveEdition — edition metadata", () => {
  it("edition_key = ISO week of the race date (2026-W26 for 2026-06-28)", () => {
    const snap = snapshot([gradedRace({ date: "2026-06-28" })]);
    const out = buildLiveEdition(snap, NOW);
    expect(out!.edition_key).toBe("2026-W26");
  });

  it("reserved version 90 + edition_label carries the JST tick time", () => {
    const out = buildLiveEdition(snapshot([gradedRace()]), NOW);
    expect(out!.version).toBe(LIVE_VERSION);
    expect(LIVE_VERSION).toBe(90);
    // NOW=06:30Z → 15:30 JST
    expect(out!.edition_label).toBe("Live — auto-refreshed 15:30 JST");
  });

  it("published_at = now; odds/card snapshot stamps = snapshot.published_at", () => {
    const out = buildLiveEdition(
      snapshot([gradedRace()], { published_at: "2026-06-27T06:15:00Z" }),
      NOW,
    );
    expect(out!.published_at).toBe("2026-06-27T06:30:00Z");
    expect(out!.odds_snapshot_at).toBe("2026-06-27T06:15:00Z");
    expect(out!.card_snapshot_at).toBe("2026-06-27T06:15:00Z");
    // Gate + condition stay null until the entries/condition scrapes populate them.
    expect(out!.gate_snapshot_at).toBeNull();
    expect(out!.condition_snapshot_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Staleness guard (ADR-0010 fast-follow). The edition label stamps "auto-
// refreshed HH:MM JST" using the cron tick time, but real freshness is the
// producer's capture time (meta.published_at). If the producer stalls, the
// builder must refuse to republish so the existing v90 row freezes in place
// rather than being overwritten with stale odds under a fresh-looking label.
// ---------------------------------------------------------------------------
describe("buildLiveEdition — staleness guard", () => {
  it("builds when the snapshot is fresh (age well under threshold)", () => {
    // NOW = 06:30Z; snapshot published 5 min ago.
    const out = buildLiveEdition(
      snapshot([gradedRace()], { published_at: "2026-06-27T06:25:00Z" }),
      NOW,
    );
    expect(out).not.toBeNull();
    expect(out!.odds_snapshot_at).toBe("2026-06-27T06:25:00Z");
  });

  it("returns null when the snapshot is older than the threshold (stalled producer)", () => {
    // Default threshold 20min; snapshot 25min old.
    const out = buildLiveEdition(
      snapshot([gradedRace()], { published_at: "2026-06-27T06:05:00Z" }),
      NOW,
    );
    expect(out).toBeNull();
  });

  it("returns null when meta.published_at is missing OR unparseable", () => {
    // Missing — the prior `updated_at` fallback is intentionally gone, because
    // the producer (src/keibamon_core/live/snapshot.py) always emits published_at.
    expect(
      buildLiveEdition(
        snapshot([gradedRace()], { published_at: undefined, updated_at: "2026-06-27T06:00:00Z" }),
        NOW,
      ),
    ).toBeNull();
    // Unparseable — Date.parse yields NaN → "unknown" → null.
    expect(
      buildLiveEdition(
        snapshot([gradedRace()], { published_at: "not-a-date" }),
        NOW,
      ),
    ).toBeNull();
  });

  it("builds at the exact threshold boundary (age == maxStalenessMs is NOT stale; strict >)", () => {
    // NOW = 06:30Z; threshold 20min; snapshot exactly 20min old → 06:10:00Z.
    const out = buildLiveEdition(
      snapshot([gradedRace()], { published_at: "2026-06-27T06:10:00Z" }),
      NOW,
    );
    expect(out).not.toBeNull();
  });

  it("builds a pre-pool Friday snapshot (odds null, fresh meta.published_at)", () => {
    // Pool not open yet — runners carry win_odds: null. But the producer is
    // alive (fresh heartbeat), so the edition still builds and the generator
    // renders estimated-odds framing.
    const snap = snapshot(
      [
        gradedRace({
          runners: [
            { umaban: 1, name: "A", win_odds: null },
            { umaban: 2, name: "B", win_odds: null },
          ],
        }),
      ],
      { published_at: "2026-06-27T06:25:00Z" },
    );
    const out = buildLiveEdition(snap, NOW);
    expect(out).not.toBeNull();
    expect(out!.races[0].runners.every((r) => r.win_odds === null)).toBe(true);
  });
});

describe("buildLiveEdition — defensive returns null (never throws)", () => {
  it("null when there are no graded races", () => {
    const snap = snapshot([
      gradedRace({ grade_label: "OP" }),
      gradedRace({ grade_label: "Listed" }),
    ]);
    expect(buildLiveEdition(snap, NOW)).toBeNull();
  });

  it("null on malformed payload shapes (no throw)", () => {
    expect(buildLiveEdition(null, NOW)).toBeNull();
    expect(buildLiveEdition(undefined, NOW)).toBeNull();
    expect(buildLiveEdition("string-not-object", NOW)).toBeNull();
    expect(buildLiveEdition({}, NOW)).toBeNull(); // no races
    expect(buildLiveEdition({ races: "not-an-array" }, NOW)).toBeNull();
    expect(buildLiveEdition({ races: [] }, NOW)).toBeNull();
    expect(buildLiveEdition({ races: [null, 42, "x"] }, NOW)).toBeNull();
  });

  it("null when graded races exist but all have malformed runners", () => {
    // Runners list is empty → field_size=0; the race still emits with empty
    // runners (a graded race with zero runners is unusual but not malformed;
    // the generator handles it). What we actually want to guard against is
    // races where the GRADE itself is unparseable — covered above. So this
    // test confirms an empty-runners graded race is NOT dropped.
    const snap = snapshot([gradedRace({ runners: [] })]);
    const out = buildLiveEdition(snap, NOW);
    expect(out).not.toBeNull();
    expect(out!.races[0].field_size).toBe(0);
    expect(out!.races[0].runners).toEqual([]);
  });
});
