// ============================================================================
// buildFormationTicket + buildWheelTicket tests (ADR-0011 Phase 3b — ordered
// structural tickets).
//
// What this pins:
//   - Formation expansion: exacta positions=[S,S] → kPerms(S,2) distinct
//     ordered tuples (no repeats); trifecta positions=[S,S,S] → kPerms(S,3).
//   - No-repeat filter: positions=[A,B] drops any tuple where a horse appears
//     in two slots.
//   - cost === lines.length × unitStake; structure tagged "formation".
//   - Round-trip: formation over positions=[S,S] (resp [S,S,S]) line
//     probs/payouts === evaluateCombos("exacta", S) (resp "trifecta") → no
//     pricing drift.
//   - Wheel: axis pinned to `position`, opponents permute the rest. Exacta
//     wheel (1 axis, 3 opponents, pos 1) → 3 tuples; trifecta wheel → P(3,2)=6.
//     structure tagged "wheel" with axis/opponents/position payload.
//   - Null guards: non-ordered type, wrong positions.length, empty set,
//     scratched contender, out-of-range position.
// ============================================================================
import { describe, it, expect } from "vitest";
import { buildFormationTicket, buildWheelTicket } from "./recommender";
import {
  winProbs,
  comboProb,
  evaluateCombos,
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

describe("buildFormationTicket — expansion + no-repeat", () => {
  it("exacta formation positions=[S,S] → kPerms(S,2) distinct ordered tuples", () => {
    const S = ["1", "2", "3"];
    const t = buildFormationTicket("exacta", [S, S], p, allUmas, UNIT, "t");
    expect(t).not.toBeNull();
    // P(3,2) = 6 ordered tuples.
    expect(t!.lines.length).toBe(6);
    // All tuples are distinct.
    const keys = t!.lines.map((l) => l.combo.join(","));
    expect(new Set(keys).size).toBe(6);
    // No tuple has a repeat (1-1, 2-2, 3-3 must be absent).
    for (const l of t!.lines) {
      expect(l.combo[0]).not.toBe(l.combo[1]);
    }
    expect(t!.cost).toBe(6 * UNIT);
    expect(t!.structure).toBe("formation");
  });

  it("trifecta formation positions=[S,S,S] → kPerms(S,3)", () => {
    const S = ["1", "2", "3", "4"];
    const t = buildFormationTicket(
      "trifecta",
      [S, S, S],
      p,
      allUmas,
      UNIT,
      "t",
    );
    expect(t).not.toBeNull();
    // P(4,3) = 24 ordered triples.
    expect(t!.lines.length).toBe(24);
    // No triple has a repeat.
    for (const l of t!.lines) {
      expect(new Set(l.combo).size).toBe(3);
    }
  });

  it("no-repeat filter: positions=[A,B] with A∩B drops the shared horse", () => {
    // positions = [[1,2], [2,3]] → tuples (1,2),(1,3),(2,2)❌,(2,3) → 3 kept.
    const t = buildFormationTicket(
      "exacta",
      [["1", "2"], ["2", "3"]],
      p,
      allUmas,
      UNIT,
      "t",
    );
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(3);
    const keys = t!.lines.map((l) => l.combo.join(",")).sort();
    expect(keys).toEqual(["1,2", "1,3", "2,3"]);
  });

  it("free formation: positions=[[1],[2,3,4]] → 3 tuples (axis@1 wheel-shape)", () => {
    const t = buildFormationTicket(
      "exacta",
      [["1"], ["2", "3", "4"]],
      p,
      allUmas,
      UNIT,
      "t",
    );
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(3);
    // All have 1 fixed in first slot.
    for (const l of t!.lines) {
      expect(l.combo[0]).toBe("1");
    }
  });
});

describe("buildFormationTicket — mutually-exclusive math", () => {
  it("hitProb === Σ line.prob; bestCaseReturn === max line.payout", () => {
    const S = ["1", "2", "3", "4"];
    const t = buildFormationTicket("trifecta", [S, S, S], p, allUmas, UNIT, "t");
    expect(t).not.toBeNull();
    const sum = t!.lines.reduce((s, l) => s + l.prob, 0);
    expect(t!.hitProb).toBeCloseTo(sum, 12);
    const maxPayout = Math.max(...t!.lines.map((l) => l.payout));
    expect(t!.bestCaseReturn).toBeCloseTo(maxPayout, 6);
  });
});

describe("buildFormationTicket — round-trip vs evaluateCombos (no drift)", () => {
  it("exacta formation positions=[S,S] === evaluateCombos('exacta', S)", () => {
    const S = ["1", "2", "3", "4"];
    const t = buildFormationTicket("exacta", [S, S], p, allUmas, UNIT, "rt");
    expect(t).not.toBeNull();
    const evals = evaluateCombos("exacta", S, p, allUmas);
    expect(t!.lines.length).toBe(evals.length);
    const keyOf = (c: string[]) => c.join(",");
    const formMap = new Map(t!.lines.map((l) => [keyOf(l.combo), l]));
    for (const e of evals) {
      const line = formMap.get(keyOf(e.combo));
      expect(line, `combo ${e.combo} present`).toBeDefined();
      expect(line!.prob).toBeCloseTo(e.prob, 12);
      expect(line!.payout).toBeCloseTo(e.estPayoutPerUnit * UNIT, 6);
    }
  });

  it("trifecta formation positions=[S,S,S] === evaluateCombos('trifecta', S)", () => {
    const S = ["1", "2", "3", "4"];
    const t = buildFormationTicket(
      "trifecta",
      [S, S, S],
      p,
      allUmas,
      UNIT,
      "rt",
    );
    expect(t).not.toBeNull();
    const evals = evaluateCombos("trifecta", S, p, allUmas);
    expect(t!.lines.length).toBe(evals.length);
    const keyOf = (c: string[]) => c.join(",");
    const formMap = new Map(t!.lines.map((l) => [keyOf(l.combo), l]));
    for (const e of evals) {
      const line = formMap.get(keyOf(e.combo));
      expect(line, `combo ${e.combo} present`).toBeDefined();
      expect(line!.prob).toBeCloseTo(e.prob, 12);
      expect(line!.payout).toBeCloseTo(e.estPayoutPerUnit * UNIT, 6);
    }
  });
});

describe("buildFormationTicket — null guards", () => {
  it("returns null for unordered bet types", () => {
    expect(
      buildFormationTicket("quinella", [["1"], ["2"]], p, allUmas, UNIT, "x"),
    ).toBeNull();
    expect(
      buildFormationTicket("trio", [["1"], ["2"], ["3"]], p, allUmas, UNIT, "x"),
    ).toBeNull();
  });

  it("returns null when positions.length !== bet depth", () => {
    // exacta needs 2 positions; given 3.
    expect(
      buildFormationTicket(
        "exacta",
        [["1"], ["2"], ["3"]],
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
    // trifecta needs 3 positions; given 2.
    expect(
      buildFormationTicket("trifecta", [["1"], ["2"]], p, allUmas, UNIT, "x"),
    ).toBeNull();
  });

  it("returns null when any position set is empty", () => {
    expect(
      buildFormationTicket(
        "exacta",
        [["1"], []],
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
  });

  it("returns null when any contender is scratched (p===0)", () => {
    // Horse "9" is not in RUNNERS → p["9"] is undefined/0.
    expect(
      buildFormationTicket(
        "exacta",
        [["1"], ["9"]],
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
  });

  it("returns null when no-repeat filter leaves zero tuples", () => {
    // positions = [[1], [1]] → only tuple is (1,1) which repeats → dropped.
    expect(
      buildFormationTicket("exacta", [["1"], ["1"]], p, allUmas, UNIT, "x"),
    ).toBeNull();
  });
});

describe("buildWheelTicket — axis-anchored delegation", () => {
  it("exacta wheel: axis=1 @ pos 1, opponents=[2,3,4] → 3 tuples", () => {
    const t = buildWheelTicket(
      "exacta",
      ["1"],
      ["2", "3", "4"],
      1,
      p,
      allUmas,
      UNIT,
      "w",
    );
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(3);
    // Axis pinned to pos 1.
    for (const l of t!.lines) {
      expect(l.combo[0]).toBe("1");
    }
    expect(t!.cost).toBe(3 * UNIT);
    expect(t!.structure).toBe("wheel");
    expect(t!.structurePayload).toMatchObject({
      axis: ["1"],
      opponents: ["2", "3", "4"],
      position: 1,
    });
  });

  it("trifecta wheel: axis=1 @ pos 1, opponents=[2,3,4] → P(3,2)=6 tuples", () => {
    const t = buildWheelTicket(
      "trifecta",
      ["1"],
      ["2", "3", "4"],
      1,
      p,
      allUmas,
      UNIT,
      "w",
    );
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(6);
    for (const l of t!.lines) {
      expect(l.combo[0]).toBe("1");
      // opponents fill pos 2 + 3, distinct.
      expect(l.combo[1]).not.toBe(l.combo[2]);
    }
  });

  it("exacta wheel axis @ pos 2: opponents fill pos 1, axis pinned pos 2", () => {
    const t = buildWheelTicket(
      "exacta",
      ["1"],
      ["2", "3", "4"],
      2,
      p,
      allUmas,
      UNIT,
      "w",
    );
    expect(t).not.toBeNull();
    expect(t!.lines.length).toBe(3);
    for (const l of t!.lines) {
      expect(l.combo[1]).toBe("1"); // axis in 2nd slot
    }
  });

  it("wheel line probs match orderProb directly (same kernel)", () => {
    const t = buildWheelTicket(
      "exacta",
      ["1"],
      ["2", "3", "4"],
      1,
      p,
      allUmas,
      UNIT,
      "w",
    );
    expect(t).not.toBeNull();
    for (const l of t!.lines) {
      const direct = comboProb("exacta", l.combo, p, allUmas);
      expect(l.prob).toBeCloseTo(direct, 12);
    }
  });
});

describe("buildWheelTicket — null guards", () => {
  it("returns null for unordered bet types", () => {
    expect(
      buildWheelTicket(
        "quinella",
        ["1"],
        ["2", "3"],
        1,
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
  });

  it("returns null when position out of range for the bet depth", () => {
    // exacta has depth 2 → position 3 invalid.
    expect(
      buildWheelTicket(
        "exacta",
        ["1"],
        ["2", "3"],
        3,
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
  });

  it("returns null when axis is empty", () => {
    expect(
      buildWheelTicket(
        "exacta",
        [],
        ["2", "3"],
        1,
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
  });

  it("returns null when opponents empty (no tuples to permute)", () => {
    expect(
      buildWheelTicket(
        "exacta",
        ["1"],
        [],
        1,
        p,
        allUmas,
        UNIT,
        "x",
      ),
    ).toBeNull();
  });
});
