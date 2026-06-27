import { describe, it, expect } from "vitest";
import {
  winProbs,
  comboProb,
  kCombos,
  kPerms,
  wideTicketStats,
  type Runner,
} from "./fairvalue";

// A six-horse field with realistic JRA-style odds (1.5 favorite → 50 longshot).
const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4 },
  { uma: "2", odds: 3.5 },
  { uma: "3", odds: 6.2 },
  { uma: "4", odds: 9.0 },
  { uma: "5", odds: 18.5 },
  { uma: "6", odds: 51.0 },
];

const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);

describe("fairvalue: de-vig + Henery distributions", () => {
  it("de-vigged win probabilities sum to 1", () => {
    const sum = allUmas.reduce((s, u) => s + (p[u] || 0), 0);
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("exacta distribution sums to 1 (one 1st-2nd pair per race)", () => {
    const orderedPairs = kPerms(allUmas, 2);
    const sum = orderedPairs.reduce(
      (s, c) => s + comboProb("exacta", c, p, allUmas),
      0,
    );
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("quinella distribution sums to 1 (collapses the exacta pairs)", () => {
    const pairs = kCombos(allUmas, 2);
    const sum = pairs.reduce(
      (s, c) => s + comboProb("quinella", c, p, allUmas),
      0,
    );
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("trifecta distribution sums to 1 (one 1st-2nd-3rd triple per race)", () => {
    const orderedTriples = kPerms(allUmas, 3);
    const sum = orderedTriples.reduce(
      (s, c) => s + comboProb("trifecta", c, p, allUmas),
      0,
    );
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("trio distribution sums to 1 (collapses the trifecta triples)", () => {
    const triples = kCombos(allUmas, 3);
    const sum = triples.reduce(
      (s, c) => s + comboProb("trio", c, p, allUmas),
      0,
    );
    expect(sum).toBeCloseTo(1.0, 9);
  });

  it("wide distribution sums to 3 — C(top3, 2) winning pairs per race", () => {
    // Wide is structurally different from the other bet types: a single
    // race produces THREE winning wide pairs (the three ways to pick two
    // horses from the top-3 finishers), so the per-pair probability mass
    // adds up to 3, not 1. This is correct, not a bug.
    const pairs = kCombos(allUmas, 2);
    const sum = pairs.reduce(
      (s, c) => s + comboProb("wide", c, p, allUmas),
      0,
    );
    expect(sum).toBeCloseTo(3.0, 9);
  });

  it("scratched runners (odds <= 0) carry no probability mass", () => {
    const mixed: Runner[] = [
      { uma: "1", odds: 2.0 },
      { uma: "2", odds: 0 }, // scratched
      { uma: "3", odds: 4.0 },
      { uma: "4", odds: -1 }, // scratched
    ];
    const { p, overround } = winProbs(mixed);
    expect(p["2"]).toBeUndefined();
    expect(p["4"]).toBeUndefined();
    const sum = ["1", "3"].reduce((s, u) => s + (p[u] || 0), 0);
    expect(sum).toBeCloseTo(1.0, 9);
    // Overround counts only the non-scratched runners.
    expect(overround).toBeCloseTo(0.75, 9);
  });
});

// ============================================================================
// wideTicketStats — true P(≥1) for wide (multi-win) tickets.
//
// The naive Σ line.prob overcounts because wide pair-events OVERLAP — the
// events "{1,2} ⊆ top3" and "{1,3} ⊆ top3" both happen when {1,2,3} ⊆ top3.
// wideTicketStats enumerates C(n,3) top-3 sets against the trio kernel to
// compute the true hit probability and the multi-pay best-case return.
// ============================================================================
describe("wideTicketStats — true hit probability + multi-pay best case", () => {
  it("returns zeros for empty input or a field too small to fill top-3", () => {
    expect(wideTicketStats([], p, allUmas)).toEqual({
      hitProb: 0,
      expWinningLines: 0,
      bestCaseReturn: 0,
    });
    // 2-horse field can't have a top-3 set.
    const small: Runner[] = [
      { uma: "1", odds: 2.0 },
      { uma: "2", odds: 3.0 },
    ];
    const sp = winProbs(small);
    expect(
      wideTicketStats(
        [{ combo: ["1", "2"], payout: 1000 }],
        sp.p,
        ["1", "2"],
      ),
    ).toEqual({ hitProb: 0, expWinningLines: 0, bestCaseReturn: 0 });
  });

  it("hitProb ≤ naive Σ line.prob (overcount correction)", () => {
    // Three pairs from the chalk end: {1,2}, {1,3}, {2,3}. Naive Σ overcounts
    // because all three hit together when {1,2,3} finishes top-3.
    const lines = [
      { combo: ["1", "2"], payout: 600 },
      { combo: ["1", "3"], payout: 900 },
      { combo: ["2", "3"], payout: 1200 },
    ];
    const naive = lines.reduce(
      (s, l) => s + comboProb("wide", l.combo, p, allUmas),
      0,
    );
    const stats = wideTicketStats(lines, p, allUmas);
    expect(stats.hitProb).toBeLessThanOrEqual(naive + 1e-9);
    // And strictly less when there's real overlap.
    expect(stats.hitProb).toBeLessThan(naive);
  });

  it("hitProb equals true P(at least one selected pair finishes top-3)", () => {
    // Brute-force truth: enumerate every top-3 set, sum probabilities of
    // sets where ≥1 line is a subset. Compare to wideTicketStats.hitProb.
    const lines = [
      { combo: ["1", "3"], payout: 800 },
      { combo: ["2", "4"], payout: 1500 },
    ];
    const top3Sets = kCombos(allUmas, 3);
    let truth = 0;
    for (const set of top3Sets) {
      const pt = comboProb("trio", set, p, allUmas);
      if (!(pt > 0)) continue;
      const s = new Set(set);
      const anyHit = lines.some(
        (l) => s.has(l.combo[0]) && s.has(l.combo[1]),
      );
      if (anyHit) truth += pt;
    }
    const stats = wideTicketStats(lines, p, allUmas);
    expect(stats.hitProb).toBeCloseTo(truth, 9);
  });

  it("hitProb = 1.0 when the ticket covers ALL pairs of a 3-horse field", () => {
    // In a 3-horse field there's only one possible top-3 set (all three),
    // and a full pair box hits it with certainty.
    const small: Runner[] = [
      { uma: "1", odds: 2.0 },
      { uma: "2", odds: 3.0 },
      { uma: "3", odds: 5.0 },
    ];
    const sp = winProbs(small);
    const umas = ["1", "2", "3"];
    const lines = [
      { combo: ["1", "2"], payout: 400 },
      { combo: ["1", "3"], payout: 600 },
      { combo: ["2", "3"], payout: 900 },
    ];
    const stats = wideTicketStats(lines, sp.p, umas);
    expect(stats.hitProb).toBeCloseTo(1.0, 9);
    // All three pairs hit the single top-3 set → best case = sum of payouts.
    expect(stats.bestCaseReturn).toBe(400 + 600 + 900);
    expect(stats.expWinningLines).toBeCloseTo(3.0, 9);
  });

  it("bestCaseReturn captures the all-covered-horses-fill-board multi-pay scenario", () => {
    // 4-horse field, ticket covers 3 of them as a full pair box. Best case
    // is when those 3 finish top-3 → all 3 lines pay.
    const small: Runner[] = [
      { uma: "1", odds: 2.0 },
      { uma: "2", odds: 3.0 },
      { uma: "3", odds: 5.0 },
      { uma: "4", odds: 8.0 },
    ];
    const sp = winProbs(small);
    const umas = ["1", "2", "3", "4"];
    const lines = [
      { combo: ["1", "2"], payout: 350 },
      { combo: ["1", "3"], payout: 550 },
      { combo: ["2", "3"], payout: 800 },
    ];
    const stats = wideTicketStats(lines, sp.p, umas);
    // Best top-3 outcome is {1,2,3} → 3 lines pay.
    expect(stats.bestCaseReturn).toBe(350 + 550 + 800);
  });

  it("a single-line wide ticket's hitProb equals comboProb('wide', that line)", () => {
    // Sanity: one line should produce the same hitProb as the legacy kernel.
    const line = { combo: ["1", "3"], payout: 700 };
    const stats = wideTicketStats([line], p, allUmas);
    expect(stats.hitProb).toBeCloseTo(
      comboProb("wide", line.combo, p, allUmas),
      9,
    );
    expect(stats.bestCaseReturn).toBe(700);
  });
});
