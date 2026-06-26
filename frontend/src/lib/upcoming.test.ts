import { describe, it, expect } from "vitest";
import { pickGradedUpcoming, gradeOf } from "./upcoming";
import type { LiveRace } from "../api";

// Fixed "now" so date filtering is deterministic. Local tz midnight 2026-06-26
// (a Friday). Races on 2026-06-26 are "today" and count as upcoming (>= today).
const NOW = new Date(2026, 5, 26);

function race(opts: Partial<LiveRace> & { race_no: number }): LiveRace {
  return { ...opts };
}

describe("gradeOf", () => {
  it("recognizes G1/G2/G3 case-insensitively", () => {
    expect(gradeOf(race({ race_no: 1, grade_label: "G1" }))).toBe("G1");
    expect(gradeOf(race({ race_no: 1, grade_label: "g2" }))).toBe("G2");
    expect(gradeOf(race({ race_no: 1, grade_label: "g3" }))).toBe("G3");
  });

  it("rejects non-graded / empty / missing labels", () => {
    expect(gradeOf(race({ race_no: 1, grade_label: "OP" }))).toBeNull();
    expect(gradeOf(race({ race_no: 1, grade_label: "Listed" }))).toBeNull();
    expect(gradeOf(race({ race_no: 1, grade_label: "" }))).toBeNull();
    expect(gradeOf(race({ race_no: 1 }))).toBeNull();
  });
});

describe("pickGradedUpcoming", () => {
  it("returns [] for empty / undefined input", () => {
    expect(pickGradedUpcoming([], NOW)).toEqual([]);
    expect(pickGradedUpcoming(undefined, NOW)).toEqual([]);
  });

  it("keeps only graded races, drops non-graded", () => {
    const races = [
      race({ race_no: 11, name: "Takarazuka Kinen", grade_label: "G1", date: "2026-06-28" }),
      race({ race_no: 9, name: "Allowance", grade_label: "OP", date: "2026-06-28" }),
      race({ race_no: 10, name: "Hanshin Himba", grade_label: "G2", date: "2026-06-28" }),
    ];
    const out = pickGradedUpcoming(races, NOW);
    expect(out.map((r) => r.name)).toEqual(["Takarazuka Kinen", "Hanshin Himba"]);
  });

  it("drops races whose date is in the past", () => {
    const races = [
      race({ race_no: 11, grade_label: "G1", date: "2026-06-20", name: "past" }),
      race({ race_no: 11, grade_label: "G1", date: "2026-06-28", name: "future" }),
    ];
    const out = pickGradedUpcoming(races, NOW);
    expect(out.map((r) => r.name)).toEqual(["future"]);
  });

  it("includes a race scheduled for today (>= today boundary)", () => {
    const races = [race({ race_no: 11, grade_label: "G1", date: "2026-06-26", name: "today" })];
    expect(pickGradedUpcoming(races, NOW).map((r) => r.name)).toEqual(["today"]);
  });

  it("normalizes YYYYMMDD dates before comparing", () => {
    const races = [
      race({ race_no: 11, grade_label: "G1", date: "20260620", name: "past" }),
      race({ race_no: 11, grade_label: "G1", date: "20260628", name: "future" }),
    ];
    const out = pickGradedUpcoming(races, NOW);
    expect(out.map((r) => r.name)).toEqual(["future"]);
  });

  it("sorts by grade (G1→G2→G3), then date, then race_no", () => {
    const races = [
      race({ race_no: 11, grade_label: "G3", date: "2026-06-28", name: "G3" }),
      race({ race_no: 9, grade_label: "G1", date: "2026-06-28", name: "G1-R9" }),
      race({ race_no: 11, grade_label: "G1", date: "2026-06-28", name: "G1-R11" }),
      race({ race_no: 10, grade_label: "G2", date: "2026-06-27", name: "G2-early" }),
      race({ race_no: 10, grade_label: "G2", date: "2026-06-28", name: "G2-late" }),
    ];
    const out = pickGradedUpcoming(races, NOW);
    expect(out.map((r) => r.name)).toEqual([
      "G1-R9",    // G1, earlier race_no
      "G1-R11",   // G1, later race_no
      "G2-early", // G2, earlier date first
      "G2-late",  // G2, later date
      "G3",       // G3 last
    ]);
  });

  it("does not mutate the input array", () => {
    const races = [
      race({ race_no: 2, grade_label: "G2", date: "2026-06-28" }),
      race({ race_no: 1, grade_label: "G1", date: "2026-06-28" }),
    ];
    const snapshot = [...races];
    pickGradedUpcoming(races, NOW);
    expect(races.map((r) => r.race_no)).toEqual(snapshot.map((r) => r.race_no));
  });
});

// ---------------------------------------------------------------------------
// The "today" boundary is pinned to the JST (Asia/Tokyo) calendar date, because
// JRA race dates are JST calendar dates. Without pinning, a viewer outside Japan
// could see a borderline race flip in/out of "upcoming" by a day. These tests
// use an instant whose JST date differs from its date in most other zones, so a
// regression to runtime-local-tz logic would change the result.
// ---------------------------------------------------------------------------

describe("pickGradedUpcoming — JST boundary", () => {
  // 2026-06-26T16:00:00Z = 2026-06-27 01:00 JST, but still 2026-06-26 in UTC
  // and earlier in the Americas. JST date (2026-06-27) must govern the filter.
  const NOW = new Date("2026-06-26T16:00:00Z");

  it("uses the JST calendar day, not the runtime-local day", () => {
    const races = [
      // 2026-06-26 is already past in JST at this instant → excluded.
      race({ race_no: 11, grade_label: "G1", date: "2026-06-26", name: "jst-yesterday" }),
      // 2026-06-27 is today in JST → kept (>= today).
      race({ race_no: 11, grade_label: "G1", date: "2026-06-27", name: "jst-today" }),
    ];
    const out = pickGradedUpcoming(races, NOW);
    expect(out.map((r) => r.name)).toEqual(["jst-today"]);
  });

  it("applies the JST boundary to the YYYYMMDD date form too", () => {
    const races = [
      race({ race_no: 11, grade_label: "G1", date: "20260626", name: "past" }),
      race({ race_no: 11, grade_label: "G1", date: "20260627", name: "today" }),
    ];
    expect(pickGradedUpcoming(races, NOW).map((r) => r.name)).toEqual(["today"]);
  });

  it("treats an instant just before JST midnight as the previous JST day", () => {
    // 2026-06-26T14:30:00Z = 2026-06-26 23:30 JST → JST date still 2026-06-26.
    const now = new Date("2026-06-26T14:30:00Z");
    const races = [
      race({ race_no: 11, grade_label: "G1", date: "2026-06-26", name: "jst-today" }),
      race({ race_no: 11, grade_label: "G1", date: "2026-06-25", name: "jst-yesterday" }),
    ];
    const out = pickGradedUpcoming(races, now);
    expect(out.map((r) => r.name)).toEqual(["jst-today"]);
  });
});
