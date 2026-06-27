import { describe, it, expect } from "vitest";
import { recommend, recommendDiverse } from "./recommender";
import {
  winProbs,
  comboProb,
  wideTicketStats,
  type Runner,
} from "./fairvalue";
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

// ============================================================================
// Defect fixes — wide multi-win correctness + dominance floor + balanced mix.
// ============================================================================

// A larger field for the wide-box trimming test (chalk end of the market
// produces very cheap pairs that don't clear the per-line dominance floor).
const FIELD12: Runner[] = [
  { uma: "1", odds: 2.0 },
  { uma: "2", odds: 2.8 },
  { uma: "3", odds: 3.6 },
  { uma: "4", odds: 4.5 },
  { uma: "5", odds: 5.5 },
  { uma: "6", odds: 6.5 },
  { uma: "7", odds: 8.0 },
  { uma: "8", odds: 10.0 },
  { uma: "9", odds: 13.0 },
  { uma: "10", odds: 18.0 },
  { uma: "11", odds: 28.0 },
  { uma: "12", odds: 60.0 },
];

describe("recommender — WIDE multi-win correctness (defect 1)", () => {
  it("a wide ticket's hitProb ≤ naive Σ and equals true P(at least one line)", () => {
    const out = recommend(mkInput({ personality: "balanced", complexity: "two" }));
    const wide = out.find((t) => t.type === "wide");
    if (!wide) return; // no wide ticket on this field — skip
    const naive = wide.lines.reduce(
      (s, l) => s + comboProb("wide", l.combo, p, allUmas),
      0,
    );
    expect(wide.hitProb).toBeLessThanOrEqual(naive + 1e-9);
    // Cross-check against the helper directly.
    const stats = wideTicketStats(
      wide.lines.map((l) => ({ combo: l.combo, payout: l.payout })),
      p,
      allUmas,
    );
    expect(wide.hitProb).toBeCloseTo(stats.hitProb, 9);
  });

  it("a wide ticket reports bestCaseReturn ≥ max single line payout (multi-pay aware)", () => {
    const out = recommend(mkInput({ personality: "balanced", complexity: "two" }));
    const wide = out.find((t) => t.type === "wide");
    if (!wide) return;
    const maxLine = Math.max(...wide.lines.map((l) => l.payout));
    // bestCaseReturn is the multi-pay scenario (≥1 line); always ≥ the
    // top single-line payout, strictly > when ≥2 lines can co-hit.
    expect(wide.bestCaseReturn).toBeGreaterThanOrEqual(maxLine - 1e-6);
  });

  it("the impossible 'net loss on win' disappears for wide", () => {
    // A wide ticket's best-case must clear its cost on a real hit. If the
    // engine ever emits a wide ticket whose best 3-way hit ≤ cost, the
    // Explain screen's "if it hits" line would show a structural loss —
    // that's the bug we fixed.
    const out = recommend(mkInput({ personality: "balanced", complexity: "two" }));
    for (const t of out) {
      if (t.type !== "wide") continue;
      expect(t.bestCaseReturn).toBeGreaterThan(t.cost);
    }
  });
});

describe("recommender — dominance floor (defect 2)", () => {
  it("drops every line whose payout ≤ unit (can't profit solo)", () => {
    // For every emitted ticket, every surviving line must clear the unit
    // stake. A chalk-heavy field can produce sub-unit pairs (very over-bet
    // combos whose RET/prob < 1); those must not survive the filter.
    const out = recommend({
      allUmas: FIELD12.map((r) => r.uma),
      p: winProbs(FIELD12).p,
      style: { ...DEFAULT_STYLE, personality: "balanced", budget: 5000 },
      intuition: {},
    });
    expect(out.length).toBeGreaterThan(0);
    for (const t of out) {
      for (const line of t.lines) {
        expect(line.payout).toBeGreaterThan(t.unit);
      }
    }
  });

  it("trims/rejects a wide box whose best-case 3-way hit can't cover its cost", () => {
    // Force the engine to face a 12-horse field where an unguarded wide
    // box would carry 8+ cheap pairs. With budget headroom (5000) the
    // naive cap wouldn't trim — the dominance floor must.
    const out = recommend({
      allUmas: FIELD12.map((r) => r.uma),
      p: winProbs(FIELD12).p,
      style: {
        ...DEFAULT_STYLE,
        personality: "safe", // safe → wide in candidateTypes
        complexity: "two",
        budget: 5000,
      },
      intuition: {},
    });
    for (const t of out) {
      if (t.type !== "wide") continue;
      // The kept set's best realistic hit MUST clear cost (else it's
      // structurally doomed and should have been rejected/trimmed).
      expect(t.bestCaseReturn).toBeGreaterThan(t.cost);
    }
  });

  it("non-wide tickets also clear the dominance floor (best single-line > cost)", () => {
    // At most one quinella/exacta/trio/trifecta line wins per race, so the
    // best-case is the max single-line payout; that must clear the cost
    // for the ticket to ever be able to pay back.
    const out = recommend({
      allUmas: FIELD12.map((r) => r.uma),
      p: winProbs(FIELD12).p,
      style: { ...DEFAULT_STYLE, personality: "balanced", budget: 5000 },
      intuition: {},
    });
    for (const t of out) {
      if (t.type === "wide") continue;
      const maxLine = Math.max(...t.lines.map((l) => l.payout));
      expect(maxLine).toBeGreaterThan(t.cost);
    }
  });
});

describe("recommender — balanced tier structural mix (defect 3)", () => {
  it("the balanced top ticket contains both a market favorite and a non-favorite", () => {
    // favCut mirrors rankClass: top max(2, ceil(n/3)) of the market.
    const order = RUNNERS.map((r) => r.uma)
      .filter((u) => (p[u] || 0) > 0)
      .sort((a, b) => (p[b] || 0) - (p[a] || 0));
    const favCut = new Set(
      order.slice(0, Math.max(2, Math.ceil(order.length / 3))),
    );
    const out = recommend(mkInput({ personality: "balanced" }));
    expect(out.length).toBeGreaterThan(0);
    const top = out[0];
    const hasFav = top.core.some((u) => favCut.has(u));
    const hasNonFav = top.core.some((u) => !favCut.has(u));
    expect(hasFav).toBe(true);
    expect(hasNonFav).toBe(true);
  });

  it("pure-chalk and pure-value combos are non-preferred for balanced", () => {
    // Over many field shapes the balanced top should rarely be tagged
    // 'chalk' or 'value' — structural mix ('blend') is the new preferred.
    // Sample 3 field shapes; require ≥2/3 to land on blend.
    const fields: Runner[][] = [
      RUNNERS,
      FIELD12,
      [
        { uma: "1", odds: 1.8 },
        { uma: "2", odds: 4.0 },
        { uma: "3", odds: 7.0 },
        { uma: "4", odds: 12.0 },
        { uma: "5", odds: 25.0 },
        { uma: "6", odds: 50.0 },
      ],
    ];
    let blendCount = 0;
    for (const f of fields) {
      const fp = winProbs(f);
      const out = recommend({
        allUmas: f.map((r) => r.uma),
        p: fp.p,
        style: { ...DEFAULT_STYLE, personality: "balanced", budget: 2000 },
        intuition: {},
      });
      if (out.length > 0 && out[0].tag === "blend") blendCount += 1;
    }
    expect(blendCount).toBeGreaterThanOrEqual(2);
  });
});
