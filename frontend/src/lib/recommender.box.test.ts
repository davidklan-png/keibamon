// ============================================================================
// buildBoxTicket tests (ADR-0011 Phase 3a — structural box model).
//
// What this pins:
//   - Box expansion: quinella/wide box of N → C(N,2) distinct pair lines;
//     trio box of N → C(N,3) lines. cost === lines × unitStake.
//   - Wide routes hitProb + bestCaseReturn through wideTicketStats (true P(≥1),
//     multi-pay), NOT the naive Σ that overcounts overlapping pairs.
//   - Round-trip: for the same type + set + market, buildBoxTicket's line
//     probs/payouts are byte-identical to evaluateCombos → no pricing drift.
//   - Null guards: too-small set, scratched horse (p===0), and unsupported
//     ordered types (exacta/trifecta) all return null.
// ============================================================================
import { describe, it, expect } from "vitest";
import { buildBoxTicket } from "./recommender";
import {
  winProbs,
  comboProb,
  evaluateCombos,
  wideTicketStats,
  type Runner,
} from "./fairvalue";

const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4 },
  { uma: "2", odds: 3.5 },
  { uma: "3", odds: 6.2 },
  { uma: "4", odds: 9.0 },
  { uma: "5", odds: 18.5 },
  { uma: "6", odds: 51.0 },
  { uma: "7", odds: 8.5 },
  { uma: "8", odds: 13.0 },
];
const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);
const UNIT = 100;

describe("buildBoxTicket — expansion + cost", () => {
  it("quinella box of 5 → C(5,2)=10 distinct pair lines, cost === 10 × unitStake", () => {
    const set = ["1", "2", "3", "4", "5"];
    const t = buildBoxTicket("quinella", set, p, allUmas, UNIT, "t");
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(10);
    expect(t!.cost).toBe(10 * UNIT);
    // Each combo is an unordered pair; all distinct.
    const keys = t!.lines.map((l) => l.combo.slice().sort().join(","));
    expect(new Set(keys).size).toBe(10);
    // Structure is tagged.
    expect(t!.structure).toBe("box");
    expect((t!.structurePayload as { set: string[] }).set).toEqual(set);
    expect(t!.unitStake).toBe(UNIT);
  });

  it("wide box of 5 → C(5,2)=10 lines", () => {
    const t = buildBoxTicket("wide", ["1", "2", "3", "4", "5"], p, allUmas, UNIT, "w");
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(10);
  });

  it("trio box of 4 → C(4,3)=4 lines", () => {
    const t = buildBoxTicket("trio", ["1", "2", "3", "4"], p, allUmas, UNIT, "tri");
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(4);
    expect(t!.cost).toBe(4 * UNIT);
  });
});

describe("buildBoxTicket — wide via wideTicketStats (not naive Σ)", () => {
  it("wide hitProb === wideTicketStats(...).hitProb, not naive Σ", () => {
    const set = ["1", "2", "3", "4"];
    const t = buildBoxTicket("wide", set, p, allUmas, UNIT, "w");
    expect(t).not.toBeNull();
    const naive = t!.lines.reduce(
      (s, l) => s + comboProb("wide", l.combo, p, allUmas),
      0,
    );
    const stats = wideTicketStats(
      t!.lines.map((l) => ({ combo: l.combo, payout: l.payout })),
      p,
      allUmas,
    );
    // Matches the helper exactly.
    expect(t!.hitProb).toBeCloseTo(stats.hitProb, 9);
    // And is strictly less than the naive overcount (overlapping pairs).
    expect(stats.hitProb).toBeLessThan(naive);
  });

  it("wide bestCaseReturn === wideTicketStats(...).bestCaseReturn (multi-pay)", () => {
    const t = buildBoxTicket("wide", ["1", "2", "3", "4"], p, allUmas, UNIT, "w");
    expect(t).not.toBeNull();
    const stats = wideTicketStats(
      t!.lines.map((l) => ({ combo: l.combo, payout: l.payout })),
      p,
      allUmas,
    );
    expect(t!.bestCaseReturn).toBeCloseTo(stats.bestCaseReturn, 6);
  });

  it("quinella bestCaseReturn === max single-line payout (mutually exclusive)", () => {
    const t = buildBoxTicket("quinella", ["1", "2", "3", "4"], p, allUmas, UNIT, "q");
    expect(t).not.toBeNull();
    const maxLine = Math.max(...t!.lines.map((l) => l.payout));
    expect(t!.bestCaseReturn).toBeCloseTo(maxLine, 6);
  });
});

describe("buildBoxTicket — round-trip vs evaluateCombos (no pricing drift)", () => {
  for (const type of ["quinella", "wide", "trio"] as const) {
    it(`${type} box line probs/payouts === evaluateCombos over the same set`, () => {
      const set = ["1", "2", "3", "4"];
      const t = buildBoxTicket(type, set, p, allUmas, UNIT, "rt");
      expect(t).not.toBeNull();
      const evals = evaluateCombos(type, set, p, allUmas);
      // Same number of lines.
      expect(t!.lines.length).toBe(evals.length);
      // Index both by sorted-combo key for an order-independent compare.
      const keyOf = (c: string[]) => c.slice().sort().join(",");
      const boxMap = new Map(t!.lines.map((l) => [keyOf(l.combo), l]));
      for (const e of evals) {
        const line = boxMap.get(keyOf(e.combo));
        expect(line, `combo ${e.combo} present in box`).toBeDefined();
        expect(line!.prob).toBeCloseTo(e.prob, 12);
        // payout = RET/prob × unit; evaluateCombos gives estPayoutPerUnit at
        // unit=1, so multiply by UNIT to compare apples-to-apples.
        expect(line!.payout).toBeCloseTo(e.estPayoutPerUnit * UNIT, 6);
      }
    });
  }
});

describe("buildBoxTicket — null guards", () => {
  it("returns null when set.length < k for the bet type", () => {
    // quinella/wide need 2, trio needs 3.
    expect(buildBoxTicket("quinella", ["1"], p, allUmas, UNIT, "x")).toBeNull();
    expect(buildBoxTicket("wide", ["1"], p, allUmas, UNIT, "x")).toBeNull();
    expect(buildBoxTicket("trio", ["1", "2"], p, allUmas, UNIT, "x")).toBeNull();
  });

  it("returns null when any selected horse has p === 0 (scratched)", () => {
    // Horse "9" is not in RUNNERS → p["9"] is undefined/0.
    const t = buildBoxTicket(
      "quinella",
      ["1", "9"],
      p,
      allUmas,
      UNIT,
      "x",
    );
    expect(t).toBeNull();
  });

  it("returns null for unsupported ordered types (exacta/trifecta)", () => {
    // 3a scopes box tickets to unordered types only.
    expect(
      buildBoxTicket("exacta", ["1", "2", "3"], p, allUmas, UNIT, "x"),
    ).toBeNull();
    expect(
      buildBoxTicket("trifecta", ["1", "2", "3"], p, allUmas, UNIT, "x"),
    ).toBeNull();
  });
});
