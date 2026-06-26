// ============================================================================
// Sample weekend fixture for the "Weekend Roundup" Reference tab.
//
// This is the FALLBACK data path (requirement: "If live data is unavailable,
// support a manual or fixture/sample-data path consistent with the app's
// existing approach"). The worker route /api/weekly-report returns
// { status: "sample" } when no D1-published report exists, and the frontend
// renders these two editions deterministically.
//
// Two editions of the SAME weekend demonstrate the Friday-publish → Saturday-
// refresh versioning arc:
//   - SAMPLE_FRIDAY: gates drawn, estimated odds only, no going/weather yet.
//   - SAMPLE_SATURDAY: live odds + trend signals + conditions, version 2.
//
// Realistic shape: one G1 (Takarazuka Kinen, Hanshin turf 2200, 16 runners),
// one G2 (Hanshin Himba Stakes, turf 1400), one G3 (dirt 1200).
// ============================================================================

import type { WeekendInput, RunnerInput } from "../lib/weeklyReport";

function g1Runners(friday: boolean): RunnerInput[] {
  const base: Array<[number, string, number, RunnerInput["style_signal"]]> = [
    [1, "Starlight Vow", 3.2, "stalker"],
    [2, "Deep Current", 4.6, "closer"],
    [3, "Rail Logic", 5.8, "presser"],
    [4, "Gold Tempo", 9.4, "front"],
    [5, "Quiet Form", 12.0, "stalker"],
    [6, "Wide Draw", 18.5, "closer"],
    [7, "Storm Line", 26.0, "presser"],
    [8, "Long Fuse", 41.0, "closer"],
  ];
  return base.map(([num, name, odds, style], i) => ({
    horse_number: num,
    horse_name: name,
    gate: num + (i % 2), // gates drawn (with slight offset to vary posts)
    win_odds: friday ? null : odds,
    win_odds_est: friday ? odds : null,
    style_signal: style,
    fragile: name === "Deep Current" ? true : undefined,
    trend_tags: name === "Starlight Vow" ? ["course-and-distance winner"] : undefined,
    trend_signal: friday
      ? undefined
      : name === "Starlight Vow"
        ? ("firming" as const)
        : name === "Wide Draw"
          ? ("drifting" as const)
          : ("steady" as const),
  }));
}

function g2Runners(friday: boolean): RunnerInput[] {
  const base: Array<[number, string, number, RunnerInput["style_signal"]]> = [
    [1, "Sharp Bend", 2.8, "front"],
    [2, "Pocket Trip", 5.1, "presser"],
    [3, "Green Signal", 7.7, "stalker"],
    [4, "Night Odds", 14.0, "closer"],
  ];
  return base.map(([num, name, odds, style]) => ({
    horse_number: num,
    horse_name: name,
    gate: num,
    win_odds: friday ? null : odds,
    win_odds_est: friday ? odds : null,
    style_signal: style,
    trend_signal: friday ? undefined : ("steady" as const),
  }));
}

function g3Runners(friday: boolean): RunnerInput[] {
  const base: Array<[number, string, number, RunnerInput["style_signal"]]> = [
    [1, "Fast Return", 3.5, "presser"],
    [2, "Blue Turn", 6.2, "closer"],
    [3, "Lucky Gate", 8.9, "front"],
    [4, "Final Call", 15.5, "stalker"],
    [5, "Market Star", 22.0, "closer"],
    [6, "Late Kick", 31.0, "closer"],
  ];
  return base.map(([num, name, odds, style]) => ({
    horse_number: num,
    horse_name: name,
    gate: num,
    win_odds: friday ? null : odds,
    win_odds_est: friday ? odds : null,
    style_signal: style,
    fragile: name === "Fast Return" ? true : undefined,
  }));
}

function sampleWeekend(friday: boolean): WeekendInput {
  const races: WeekendInput["races"] = [
    {
      race_id: "jra-2026-0628-09-11",
      name: "Takarazuka Kinen",
      name_ja: "宝塚記念",
      grade: "G1",
      venue: "Hanshin",
      venue_ja: "阪神",
      surface: "turf",
      distance_m: 2200,
      post_time: "15:40",
      date: "2026-06-28",
      field_size: 16,
      going: friday ? null : "good",
      weather: friday ? null : "cloudy",
      runners: g1Runners(friday),
      notes: ["Inside course used for the G1"],
    },
    {
      race_id: "jra-2026-0627-05-11",
      name: "Hanshin Himba Stakes",
      name_ja: "阪神牝馬ステークス",
      grade: "G2",
      venue: "Hanshin",
      venue_ja: "阪神",
      surface: "turf",
      distance_m: 1400,
      post_time: "15:15",
      date: "2026-06-27",
      field_size: 4,
      runners: g2Runners(friday),
    },
    {
      race_id: "jra-2026-0628-08-09",
      name: "Lunar Prologue Stakes",
      name_ja: "ルナプロローグステークス",
      grade: "G3",
      venue: "Nakayama",
      venue_ja: "中山",
      surface: "dirt",
      distance_m: 1200,
      post_time: "14:35",
      date: "2026-06-28",
      field_size: 6,
      going: friday ? null : "standard",
      weather: friday ? null : "fine",
      runners: g3Runners(friday),
    },
  ];
  return {
    edition_key: "2026-W26",
    edition_label: friday ? "Friday edition" : "Saturday refresh",
    weekend_label: "June 27–28, 2026",
    version: friday ? 1 : 2,
    published_at: friday ? "2026-06-26T09:00:00Z" : "2026-06-27T00:30:00Z",
    odds_snapshot_at: friday ? null : "2026-06-27T00:15:00Z",
    gate_snapshot_at: "2026-06-26T08:00:00Z",
    card_snapshot_at: "2026-06-26T07:30:00Z",
    condition_snapshot_at: friday ? null : "2026-06-27T00:10:00Z",
    races,
  };
}

export const SAMPLE_FRIDAY: WeekendInput = sampleWeekend(true);
export const SAMPLE_SATURDAY: WeekendInput = sampleWeekend(false);

/** The bundled archive: both editions of the current sample weekend. */
export const SAMPLE_ARCHIVE: WeekendInput[] = [SAMPLE_FRIDAY, SAMPLE_SATURDAY];
