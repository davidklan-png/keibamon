// ============================================================================
// Item 4 (gated production publish) — validate the REAL 2026-W26 Saturday-
// refresh WeekendInput through generateReport BEFORE the D1 INSERT.
//
// This test is the confirmation gate: if generateReport produces clean output
// (no banned phrases, structural invariants hold, both graded races surface),
// the WeekendInput is fit to publish. The INSERT statement is generated
// alongside (printed to stdout when run with --reporter=verbose); David runs
// it on the Mac after sign-off.
//
// Fixture: src/data/weekend_2026_w26.json — built from keibamon.com /api/live
// (rosters + odds) + netkeiba day-index (surface + distance_m via Item 3
// producer path). Edition covers the two real graded races on 2026-06-28:
// Hakodate Kinen G3 (函館記念) and Radio NIKKEI Sho G3 (ラジオNIKKEI賞).
// ============================================================================
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateReport,
  GENERATOR_VERSION,
  type WeekendInput,
  type WeeklyReport,
} from "./weeklyReport";
import { BANNED_PHRASES as BANNED } from "./guardrails";

const fixturePath = resolve(__dirname, "../data/weekend_2026_w26.json");
const input: WeekendInput = JSON.parse(readFileSync(fixturePath, "utf8"));

// Walk every string in the generated report — mirrors the helper in
// weeklyReport.test.ts. Kept inline (not exported from guardrails.ts) so this
// validation stays self-contained.
function reportStrings(report: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(report);
  return out;
}

describe("weeklyReport — 2026-W26 Saturday edition (real publish)", () => {
  const rep: WeeklyReport = generateReport(input);

  it("WeekendInput fixture covers exactly the 2 real graded G3 races on 2026-06-28", () => {
    expect(input.edition_key).toBe("2026-W26");
    expect(input.version).toBe(2);
    expect(input.races).toHaveLength(2);
    expect(input.races.map((r) => r.grade)).toEqual(["G3", "G3"]);
    expect(input.races.map((r) => r.date)).toEqual(["2026-06-28", "2026-06-28"]);
    // Real race_ids pulled from /api/live.
    expect(input.races.map((r) => r.race_id).sort()).toEqual([
      "jra-20260628-02-11", // Hakodate Kinen
      "jra-20260628-03-11", // Radio NIKKEI Sho
    ]);
    // Surface + distance_m came from the netkeiba day-index (Item 3 path).
    const hakodate = input.races.find((r) => r.race_id.endsWith("-02-11"))!;
    expect(hakodate.surface).toBe("turf");
    expect(hakodate.distance_m).toBe(2000);
    const radio = input.races.find((r) => r.race_id.endsWith("-03-11"))!;
    expect(radio.surface).toBe("turf");
    expect(radio.distance_m).toBe(1800);
    // Roster sanity: each race carries real runner umabans + live odds.
    for (const r of input.races) {
      expect(r.runners.length).toBeGreaterThan(0);
      expect(r.runners.every((rn) => typeof rn.horse_number === "number")).toBe(true);
      expect(r.runners.every((rn) => typeof rn.win_odds === "number")).toBe(true);
    }
  });

  it("generateReport produces a structurally valid WeekendReport", () => {
    expect(rep.generator_version).toBe(GENERATOR_VERSION);
    expect(rep.edition_key).toBe("2026-W26");
    // One deep-dive per graded race, one glance-card per graded race.
    expect(rep.deep_dives).toHaveLength(2);
    expect(rep.glance).toHaveLength(2);
    // Live odds present → freshness reflects that (Saturday refresh, not Friday).
    expect(rep.freshness.has_live_odds).toBe(true);
    expect(rep.freshness.odds_snapshot_at).not.toBeNull();
  });

  it("surfaces NO banned phrases anywhere in the generated report", () => {
    const offenders: string[] = [];
    for (const s of reportStrings(rep)) {
      for (const re of BANNED) {
        if (re.test(s)) offenders.push(`${re}  ⇐  ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("weekend headline + each deep-dive produce non-empty narrative", () => {
    expect(rep.weekend_headline.length).toBeGreaterThan(20);
    for (const d of rep.deep_dives) {
      expect(d.why_this_race_matters.length).toBeGreaterThan(0);
      expect(d.market_shape.length).toBeGreaterThan(0);
      expect(d.contender_groups.core_contenders.length).toBeGreaterThan(0);
    }
  });
});
