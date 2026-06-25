import { describe, it, expect } from "vitest";
import { recommend, recommendDiverse } from "./recommender";
import { winProbs, type Runner } from "./fairvalue";
import { moodKey, DEFAULT_STYLE } from "./types";
import type { RecommendInput, IntuitionState, StyleState } from "./types";

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

function mkInput(
  style: Partial<StyleState>,
  intuition: Record<string, IntuitionState> = {},
): RecommendInput {
  return {
    allUmas,
    p,
    style: {
      personality: "balanced",
      budget: 1200,
      unit: 100,
      complexity: "auto",
      flavor: "mixed",
      ...style,
    },
    intuition,
  };
}

describe("recommender", () => {
  it("returns 1-3 tickets for a balanced 8-horse field", () => {
    const out = recommend(mkInput({ personality: "balanced" }));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(3);
    // Each ticket has at least one line and respects budget.
    for (const t of out) {
      expect(t.lines.length).toBeGreaterThan(0);
      expect(t.cost).toBeLessThanOrEqual(1200);
      expect(t.cost).toEqual(t.lines.length * 100);
    }
  });

  it("safe personality prefers wide/quinella/trio (no trifecta)", () => {
    const out = recommend(mkInput({ personality: "safe" }));
    const types = new Set(out.map((t) => t.type));
    expect(types.has("trifecta")).toBe(false);
    expect(types.has("wide") || types.has("quinella") || types.has("trio")).toBe(
      true,
    );
  });

  it("longshot personality yields at least one high-variance ticket", () => {
    const out = recommend(
      mkInput({ personality: "longshot", budget: 3000, flavor: "value" }),
    );
    expect(out.some((t) => t.variance === "high")).toBe(true);
  });

  it("anchor constraint forces every ticket to include the anchor", () => {
    const out = recommend(
      mkInput({ personality: "balanced" }, { "3": "anchor" }),
    );
    expect(out.length).toBeGreaterThan(0);
    for (const t of out) {
      expect(t.core).toContain("3");
    }
  });

  it("avoid constraint drops every combo containing that horse", () => {
    const out = recommend(
      mkInput({ personality: "balanced" }, { "5": "avoid" }),
    );
    for (const t of out) {
      expect(t.core).not.toContain("5");
    }
  });

  it("anti-chalk suppresses chalk-only tickets", () => {
    const out = recommend(mkInput({ personality: "antiChalk", flavor: "value" }));
    // No top ticket should be tagged 'chalk'.
    for (const t of out) {
      if (t === out[0]) expect(t.tag).not.toBe("chalk");
    }
  });

  it("returns empty when pool is too small (< 2 horses)", () => {
    const { p: p2 } = winProbs([{ uma: "1", odds: 2.0 }]);
    const out = recommend({
      allUmas: ["1"],
      p: p2,
      style: mkInput({}).style,
      intuition: {},
    });
    expect(out.length).toBe(0);
  });
});

// ============================================================================
// recommendDiverse — default risk-tier spread (safer / balanced / spicier).
// ============================================================================

describe("recommendDiverse", () => {
  it("returns ≤3 tickets spanning ≥2 distinct moods on a full field", () => {
    const out = recommendDiverse(mkInput({ ...DEFAULT_STYLE }));
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(3);
    // On an 8-horse field the safe/balanced/longshot top picks land at
    // different variance/tag combinations → ≥2 distinct mood keys.
    const moods = new Set(out.map(moodKey));
    expect(moods.size).toBeGreaterThanOrEqual(2);
  });

  it("does not duplicate the same contender core across the set", () => {
    const out = recommendDiverse(mkInput({ ...DEFAULT_STYLE }));
    const cores = out.map((t) => t.core.slice().sort().join(","));
    expect(new Set(cores).size).toBe(cores.length);
  });

  it("respects intuition (single-personality input still filters)", () => {
    // When intuition is present the caller is expected to use recommend()
    // directly; recommendDiverse must still honor hard constraints (avoid)
    // if it is invoked — the avoid horse must not appear in any pick.
    const out = recommendDiverse(
      mkInput({ ...DEFAULT_STYLE }, { "5": "avoid" }),
    );
    for (const t of out) {
      expect(t.core).not.toContain("5");
    }
  });
});
