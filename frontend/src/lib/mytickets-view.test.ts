import { describe, it, expect } from "vitest";
import { mtRunnersForTicket, mtPickFeature } from "./mytickets-view";
import type { LiveSnapshot } from "../api";
import type { CommittedTicket } from "./types";

// ---- fixture builder -------------------------------------------------------
// Mirrors lib/punterStats.test.ts's mkTicket: minimal CommittedTicket, only
// the fields mtRunnersForTicket reads are meaningful.
function mkTicket(opts: {
  raceKey: string;
  frozenRunners: { num: number; en: string; ja: string; odds: number }[];
}): CommittedTicket {
  return {
    id: "kb-1",
    serial: "KB-1",
    ticket: {
      id: "rec-1",
      type: "trio",
      lines: [],
      hitProb: 0.1,
      cost: 1000,
      expectedReturn: 900,
      avgPayout: 5000,
      bestCaseReturn: 5000,
      core: [],
      tag: "blend",
      unit: 100,
      variance: "low",
      rationaleKeys: [],
    },
    unit: 100,
    mood: "balanced",
    state: "open",
    payoutBase: 5000,
    race: {
      raceKey: opts.raceKey,
      grade: "",
      nameEn: "Sample Race",
      nameJa: "サンプルレース",
      venueEn: "Hanshin",
      venueJa: "阪神",
      raceNo: 5,
      dateEn: "Jul 11, 2026",
      dateJa: "2026年7月11日",
      post: "11:00",
      runners: opts.frozenRunners,
    },
    owner: "you",
    claps: 0,
    createdAt: 1_000_000,
  };
}

// A 7-runner race (the ticket's own race — a trio box against the full
// field, e.g. C(7,3) = 35 combinations) alongside a 3-runner race that
// mtPickFeature prefers (last in the pool). Regression fixture for the bug
// where the edit/manual builder silently swapped in mtPickFeature's race.
const RACE7 = {
  date: "20260711",
  race_no: 5,
  name: "Sample Race",
  venue: "Hanshin",
  status: "open" as const,
  runners: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    umaban: n,
    name: `Horse ${n}`,
    win_odds: n,
    odds_is_live: true,
  })),
};
const RACE3 = {
  date: "20260711",
  race_no: 11,
  name: "Later Race",
  venue: "Hanshin",
  status: "open" as const,
  runners: [1, 2, 3].map((n) => ({
    umaban: n,
    name: `Horse ${n}`,
    win_odds: n,
    odds_is_live: true,
  })),
};
const SNAP: LiveSnapshot = {
  meta: { date: "20260711" },
  races: [RACE7, RACE3],
};

describe("mtRunnersForTicket", () => {
  it("resolves the ticket's OWN race, not mtPickFeature's race", () => {
    // Sanity: with both races live, mtPickFeature (no G1 match) picks the
    // LAST race in the pool — RACE3, the 3-runner one — same shape as the
    // reported bug (edit screen showed only 3 slots for a 7-horse ticket).
    const feature = mtPickFeature(SNAP);
    expect(feature?.race_no).toBe(11);

    const tk = mkTicket({
      raceKey: "20260711|Hanshin|5|Sample Race",
      frozenRunners: [1, 2, 3, 4, 5, 6, 7].map((n) => ({
        num: n,
        en: `Horse ${n}`,
        ja: `Horse ${n}`,
        odds: n,
      })),
    });

    const runners = mtRunnersForTicket(tk, SNAP, "20260711");
    expect(runners).toHaveLength(7);
    expect(runners.map((r) => r.uma)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("falls back to the frozen commit-time runners when the race has aged out of /api/live", () => {
    const tk = mkTicket({
      raceKey: "20260705|Hanshin|11|Old Race",
      frozenRunners: [1, 2, 3, 4].map((n) => ({
        num: n,
        en: `Horse ${n}`,
        ja: `Horse ${n}`,
        odds: n,
      })),
    });

    const runners = mtRunnersForTicket(tk, SNAP, "20260711");
    expect(runners).toHaveLength(4);
    expect(runners.map((r) => r.uma)).toEqual(["1", "2", "3", "4"]);
  });

  it("returns an empty field, not a crash, when snap is null", () => {
    const tk = mkTicket({ raceKey: "any", frozenRunners: [] });
    expect(mtRunnersForTicket(tk, null)).toEqual([]);
  });
});
