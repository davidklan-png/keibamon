import { describe, it, expect } from "vitest";
import {
  winProbs,
  comboProb,
  kCombos,
  kPerms,
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
