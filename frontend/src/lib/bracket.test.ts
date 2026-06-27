// ============================================================================
// bracketQuinellaAgg tests (ADR-0011 Phase 3a — 枠連 aggregation).
//
// What this pins:
//   - Omit-when-gate-absent: any selected runner without a numeric gate → null.
//   - points = C(distinctBrackets, 2); cost = points × unitStake.
//   - hitProb = Σ pairProb over bracket-pairs (mutually exclusive, like quinella).
//   - Each bracket-pair's pairProb === Σ comboProb("quinella", [h1,h2]) over
//     horse-pairs crossing the two brackets (reuses the quinella kernel, no
//     new BetType).
// ============================================================================
import { describe, it, expect } from "vitest";
import { bracketQuinellaAgg } from "./recommender";
import { winProbs, comboProb, type Runner } from "./fairvalue";

const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4, gate: 1 },
  { uma: "2", odds: 3.5, gate: 1 },
  { uma: "3", odds: 6.2, gate: 2 },
  { uma: "4", odds: 9.0, gate: 3 },
  { uma: "5", odds: 18.5, gate: 4 },
  { uma: "6", odds: 51.0, gate: 5 },
  { uma: "7", odds: 8.5, gate: 6 },
  { uma: "8", odds: 13.0, gate: 7 },
];
const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);
const UNIT = 100;

describe("bracketQuinellaAgg — omit when gate absent", () => {
  it("returns null when any selected runner lacks a numeric gate", () => {
    // Runner "3" has gate stripped → omit rather than guess.
    const selected: Runner[] = [
      RUNNERS[0], // gate 1
      { ...RUNNERS[2], gate: undefined }, // no gate
      RUNNERS[3], // gate 3
    ];
    expect(bracketQuinellaAgg(selected, p, allUmas, UNIT)).toBeNull();
  });

  it("returns null when gate is present but fewer than 2 distinct brackets", () => {
    // All in bracket 1 → no bracket-pair.
    const selected: Runner[] = [
      RUNNERS[0], // gate 1
      RUNNERS[1], // gate 1
    ];
    expect(bracketQuinellaAgg(selected, p, allUmas, UNIT)).toBeNull();
  });

  it("returns null for fewer than 2 runners", () => {
    expect(bracketQuinellaAgg([RUNNERS[0]], p, allUmas, UNIT)).toBeNull();
  });
});

describe("bracketQuinellaAgg — points + cost + brackets", () => {
  it("points = C(distinctBrackets, 2), cost = points × unitStake", () => {
    // 4 runners across brackets {1,1,3,4} → distinct {1,3,4} → C(3,2)=3 pairs.
    const selected = [RUNNERS[0], RUNNERS[1], RUNNERS[3], RUNNERS[4]];
    const agg = bracketQuinellaAgg(selected, p, allUmas, UNIT);
    expect(agg).not.toBeNull();
    expect(agg!.brackets).toEqual([1, 3, 4]);
    expect(agg!.points).toBe(3);
    expect(agg!.cost).toBe(3 * UNIT);
  });

  it("handles each bracket-pair contributing one point when brackets are all distinct", () => {
    // 3 runners in brackets {2,5,7} → C(3,2)=3 pairs.
    const selected = [RUNNERS[2], RUNNERS[5], RUNNERS[7]];
    const agg = bracketQuinellaAgg(selected, p, allUmas, UNIT);
    expect(agg).not.toBeNull();
    expect(agg!.brackets).toEqual([2, 5, 7]);
    expect(agg!.points).toBe(3);
  });
});

describe("bracketQuinellaAgg — quinella-kernel reuse + mutual exclusion", () => {
  it("hitProb === Σ bracket-pair prob, each pair = Σ quinella over crossing horses", () => {
    // 4 runners: brackets {1,1,3,4}. Bracket-pairs: (1,3), (1,4), (3,4).
    // (1,3) covers horses in bracket 1 (umas 1,2) × bracket 3 (uma 4).
    const selected = [RUNNERS[0], RUNNERS[1], RUNNERS[3], RUNNERS[4]];
    const agg = bracketQuinellaAgg(selected, p, allUmas, UNIT);
    expect(agg).not.toBeNull();

    // Manually recompute each bracket-pair's prob via the quinella kernel.
    const byBracket = new Map<number, string[]>([
      [1, ["1", "2"]],
      [3, ["4"]],
      [4, ["5"]],
    ]);
    const brackets = [1, 3, 4];
    let expected = 0;
    let bestPayout = 0;
    for (let i = 0; i < brackets.length; i++) {
      for (let j = i + 1; j < brackets.length; j++) {
        const a = byBracket.get(brackets[i])!;
        const b = byBracket.get(brackets[j])!;
        let pairProb = 0;
        for (const h1 of a) {
          for (const h2 of b) {
            pairProb += comboProb("quinella", [h1, h2], p, allUmas);
          }
        }
        if (pairProb > 0) {
          expected += pairProb;
          const payout = (0.775 / pairProb) * UNIT;
          if (payout > bestPayout) bestPayout = payout;
        }
      }
    }
    expect(agg!.hitProb).toBeCloseTo(expected, 12);
    expect(agg!.bestCaseReturn).toBeCloseTo(bestPayout, 6);
  });

  it("bestCaseReturn is the max single bracket-pair payout (mutually exclusive)", () => {
    // Only one bracket-pair can fill 1st-2nd → best case is the top pair.
    // Selected set = {1 (gate 1), 5 (gate 4)} → single bracket-pair (1,4)
    // covering only the SELECTED horses (the aggregation is over the user's
    // marked set, not the full field's brackets).
    const selected = [RUNNERS[0], RUNNERS[4]];
    const agg = bracketQuinellaAgg(selected, p, allUmas, UNIT);
    expect(agg).not.toBeNull();
    expect(agg!.points).toBe(1);
    const pairProb = comboProb("quinella", ["1", "5"], p, allUmas);
    const expectedPayout = (0.775 / pairProb) * UNIT;
    expect(agg!.bestCaseReturn).toBeCloseTo(expectedPayout, 6);
    expect(agg!.cost).toBe(UNIT);
  });
});
