import { describe, it, expect } from "vitest";
import {
  buildManualFormationTicket,
  buildManualTicket,
  finalizeTicket,
  isFullBox,
  K_BY_TYPE,
  priceLines,
  runnersByBracket,
} from "./manualBuilder";
import { kCombos, rankClass, varianceLabel, winProbs, type BetType, type Runner } from "./fairvalue";

// 8-runner synthetic field with realistic odds spreads and brackets 1-8.
const RUNNERS: Runner[] = [
  { uma: "1", odds: 8.0, gate: 1 },
  { uma: "2", odds: 15.0, gate: 2 },
  { uma: "3", odds: 4.5, gate: 3 },
  { uma: "4", odds: 6.0, gate: 3 }, // shares bracket 3 with horse 3
  { uma: "5", odds: 12.0, gate: 4 },
  { uma: "6", odds: 3.0, gate: 5 }, // favorite
  { uma: "7", odds: 20.0, gate: 6 },
  { uma: "8", odds: 10.0, gate: 7 },
];

function priced() {
  const { p } = winProbs(RUNNERS);
  const allUmas = RUNNERS.map((r) => r.uma);
  return { p, allUmas };
}

describe("manualBuilder — quinella (uma-space box)", () => {
  it("expands a 3-horse picked set to C(3,2)=3 unordered lines", () => {
    const { p, allUmas } = priced();
    const picked = new Set(["3", "4", "6"]);
    const t = buildManualTicket(
      "quinella",
      picked,
      new Set(),
      RUNNERS,
      p,
      allUmas,
      100,
    );
    expect(t).not.toBeNull();
    if (!t) return;
    // 3 unordered pairs over a 3-pick.
    expect(t.lines).toHaveLength(3);
    // Line combos are sorted ascending and contain exactly the picked umas.
    const combos = t.lines.map((l) => l.combo.join("-")).sort();
    expect(combos).toEqual(["3-4", "3-6", "4-6"]);
    // Cost = lines * unit.
    expect(t.cost).toBe(300);
    // Quinella's lines are mutually exclusive → hitProb = Σ line.prob.
    const sumProb = t.lines.reduce((s, l) => s + l.prob, 0);
    expect(t.hitProb).toBeCloseTo(sumProb, 6);
    // avgPayout is the mean of per-line payouts.
    const mean = t.lines.reduce((s, l) => s + l.payout, 0) / t.lines.length;
    expect(t.avgPayout).toBeCloseTo(mean, 6);
  });

  it("returns null when the picked set is too small (< k)", () => {
    const { p, allUmas } = priced();
    const t = buildManualTicket(
      "quinella",
      new Set(["3"]),
      new Set(),
      RUNNERS,
      p,
      allUmas,
      100,
    );
    expect(t).toBeNull();
  });
});

describe("manualBuilder — bracket_quinella (bracket-space box)", () => {
  it("expands 3 picked brackets to C(3,2)=3 bracket-pair lines", () => {
    const { p, allUmas } = priced();
    // Pick brackets 3, 5, 6 — covers 1 winning horse each (gate 3 has TWO
    // horses, 3 and 4, which exercises the horse-pair enumeration).
    const picked = new Set<number>([3, 5, 6]);
    const t = buildManualTicket(
      "bracket_quinella",
      new Set(),
      picked,
      RUNNERS,
      p,
      allUmas,
      100,
    );
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.lines).toHaveLength(3);
    const combos = t.lines.map((l) => l.combo.join("-")).sort();
    expect(combos).toEqual(["3-5", "3-6", "5-6"]);
    // Each line combo is BRACKET-space (not umabans): ["3","5"], etc.
    for (const ln of t.lines) {
      expect(ln.combo.length).toBe(2);
      // Each bracket label is 1-8 (single digit, not an umaban).
      for (const c of ln.combo) {
        expect(Number(c)).toBeGreaterThanOrEqual(1);
        expect(Number(c)).toBeLessThanOrEqual(8);
      }
    }
    // Cost = 3 lines * 100 unit = 300.
    expect(t.cost).toBe(300);
  });

  it("bracket 3 (2 horses) → 5 (1 horse) sums over the 2 horse-pairs", () => {
    const { p, allUmas } = priced();
    // Bracket 3 has horses {3, 4}; bracket 5 has horse {6}. The 3-5 bracket
    // pair is priced as comboProb("quinella", [3,6]) + comboProb("quinella", [4,6]).
    const picked = new Set<number>([3, 5]);
    const t = buildManualTicket(
      "bracket_quinella",
      new Set(),
      picked,
      RUNNERS,
      p,
      allUmas,
      100,
    );
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.lines).toHaveLength(1);
    // Sanity: probability is positive but ≤ 1.
    expect(t.lines[0].prob).toBeGreaterThan(0);
    expect(t.lines[0].prob).toBeLessThanOrEqual(1);
    // fairOdds = 1/prob; payout = RET/prob * unit (RET.quinella = 0.775).
    expect(t.lines[0].fairOdds).toBeCloseTo(1 / t.lines[0].prob, 4);
    expect(t.lines[0].payout).toBeCloseTo((0.775 / t.lines[0].prob) * 100, 2);
  });

  it("returns null when the field has no gate data", () => {
    // Same runners, but no `gate` → can't price a bracket-quinella.
    const noGateRunners: Runner[] = RUNNERS.map((r) => ({
      uma: r.uma,
      odds: r.odds,
    }));
    const { p } = winProbs(noGateRunners);
    const allUmas = noGateRunners.map((r) => r.uma);
    const t = buildManualTicket(
      "bracket_quinella",
      new Set(),
      new Set([3, 5]),
      noGateRunners,
      p,
      allUmas,
      100,
    );
    expect(t).toBeNull();
  });
});

describe("manualBuilder — exacta / trifecta (ordered box)", () => {
  it("exacta expands 2 umas to kPerms(2,2)=2 ordered lines", () => {
    const { p, allUmas } = priced();
    const t = buildManualTicket(
      "exacta",
      new Set(["3", "6"]),
      new Set(),
      RUNNERS,
      p,
      allUmas,
      100,
    );
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.lines).toHaveLength(2);
    const combos = t.lines.map((l) => l.combo.join("-")).sort();
    expect(combos).toEqual(["3-6", "6-3"]);
  });

  it("trifecta expands 3 umas to kPerms(3,3)=6 ordered lines", () => {
    const { p, allUmas } = priced();
    const t = buildManualTicket(
      "trifecta",
      new Set(["3", "4", "6"]),
      new Set(),
      RUNNERS,
      p,
      allUmas,
      100,
    );
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.lines).toHaveLength(6);
    // All distinct, ordered triples.
    const set = new Set(t.lines.map((l) => l.combo.join("-")));
    expect(set.size).toBe(6);
  });
});

describe("manualBuilder — explicit ordered formations", () => {
  it("builds a segregated trifecta from 1st/2nd/3rd position sets", () => {
    const { p, allUmas } = priced();
    const t = buildManualFormationTicket(
      "trifecta",
      [["6"], ["3", "4"], ["1", "3", "4", "8"]],
      p,
      allUmas,
      100,
    );
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.structure).toBe("formation");
    expect(t.structurePayload).toEqual({
      positions: [["6"], ["3", "4"], ["1", "3", "4", "8"]],
    });
    expect(t.lines.map((l) => l.combo.join("-")).sort()).toEqual([
      "6-3-1",
      "6-3-4",
      "6-3-8",
      "6-4-1",
      "6-4-3",
      "6-4-8",
    ]);
    expect(t.cost).toBe(600);
  });

  it("builds an exacta formation and rejects empty/non-ordered formations", () => {
    const { p, allUmas } = priced();
    const exacta = buildManualFormationTicket("exacta", [["6"], ["3", "4"]], p, allUmas, 100);
    expect(exacta?.lines.map((l) => l.combo.join("-")).sort()).toEqual(["6-3", "6-4"]);
    expect(buildManualFormationTicket("trifecta", [["6"], [], ["3"]], p, allUmas, 100)).toBeNull();
    expect(buildManualFormationTicket("quinella", [["6"], ["3"]], p, allUmas, 100)).toBeNull();
  });
});

describe("manualBuilder — runnersByBracket", () => {
  it("groups umas by gate, returns null when no runner carries a gate", () => {
    expect(runnersByBracket(RUNNERS)?.get(3)).toEqual(["3", "4"]);
    expect(runnersByBracket(RUNNERS)?.get(5)).toEqual(["6"]);
    const noGate: Runner[] = [{ uma: "1", odds: 5 }];
    expect(runnersByBracket(noGate)).toBeNull();
  });
});

describe("manualBuilder — K_BY_TYPE coverage", () => {
  it("every BetType has an entry", () => {
    const types = ["quinella", "wide", "exacta", "trio", "trifecta", "bracket_quinella"] as const;
    for (const ty of types) {
      expect(K_BY_TYPE[ty]).toBeDefined();
      expect([2, 3]).toContain(K_BY_TYPE[ty]);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 1 (ticket-generation-alignment): priceLines extraction + variance/tag
// alignment with the recommender. priceLines must reproduce the box path's
// line-for-line output; variance/tag must follow the SAME formulas recommend()
// uses (via the shared varianceLabel + rankClass(core)), not the old
// `ordered ? high : low` / per-line-majority-vote proxies.
// ---------------------------------------------------------------------------
describe("manualBuilder — priceLines extraction (parity with box path)", () => {
  it("priceLines over the box combos reproduces buildManualTicket's lines", () => {
    const { p, allUmas } = priced();
    const picked = new Set(["3", "4", "6"]);
    const t = buildManualTicket("trio", picked, new Set(), RUNNERS, p, allUmas, 100);
    expect(t).not.toBeNull();
    if (!t) return;
    // Re-derive the SAME unordered combos the box path expanded and price them
    // via priceLines — output must be byte-identical (the locked edit path
    // relies on this so re-pricing never drifts from a fresh build).
    const combos = kCombos(Array.from(picked).sort((a, b) => Number(a) - Number(b)), 3);
    const { lines } = priceLines("trio", combos, p, allUmas, 100);
    expect(lines).toEqual(t.lines);
  });

  it("priceLines → finalizeTicket round-trips to the full build (incl. wide)", () => {
    const { p, allUmas } = priced();
    const picked = new Set(["3", "6"]);
    const t = buildManualTicket("wide", picked, new Set(), RUNNERS, p, allUmas, 100);
    expect(t).not.toBeNull();
    if (!t) return;
    const { lines } = priceLines("wide", kCombos(["3", "6"], 2), p, allUmas, 100);
    const rebuilt = finalizeTicket("wide", lines, 100, p, allUmas);
    // Same lines, same assembled numbers — wide's wideTicketStats path runs
    // inside finalizeTicket, so hitProb/bestCaseReturn match the full build.
    expect(rebuilt.lines).toEqual(t.lines);
    expect(rebuilt.hitProb).toBeCloseTo(t.hitProb, 6);
    expect(rebuilt.bestCaseReturn).toBeCloseTo(t.bestCaseReturn, 6);
    expect(rebuilt.variance).toBe(t.variance);
    expect(rebuilt.tag).toBe(t.tag);
  });

  it("priceLines drops zero-probability (scratched) combos", () => {
    const { p, allUmas } = priced();
    // Horse "1" has p>0 in this field, so force a scratched entry by asking
    // for a combo against a horse not in the market — comboProb returns 0.
    const { lines } = priceLines("quinella", [["3", "NOPE"]], p, allUmas, 100);
    expect(lines).toEqual([]);
  });
});

describe("manualBuilder — variance/tag aligned with recommender", () => {
  it("a longshot quinella box is 'high' variance (formula), not 'low' (old ordered proxy)", () => {
    const { p, allUmas } = priced();
    // Quinella is UNORDERED → the old manual proxy forced variance "low" for
    // EVERY quinella. This longshot-only box has a tiny hit probability, so the
    // shared formula (hitProb < 0.15 → high) flips it to "high". That flip is
    // the alignment being proven, not a coincidence.
    const picked = new Set(["5", "7", "8"]); // odds 12.0 / 20.0 / 10.0
    const t = buildManualTicket("quinella", picked, new Set(), RUNNERS, p, allUmas, 100);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.hitProb).toBeLessThan(0.15);
    expect(t.variance).toBe("high");
  });

  it("every manual ticket's variance === varianceLabel(hitProb, avgPayout, unit)", () => {
    const { p, allUmas } = priced();
    const cases: Array<{ type: BetType; pick: string[] }> = [
      { type: "quinella", pick: ["3", "4", "6"] },
      { type: "wide", pick: ["3", "6"] },
      { type: "exacta", pick: ["3", "6"] },
      { type: "trio", pick: ["3", "4", "6"] },
      { type: "trifecta", pick: ["3", "4", "6"] },
    ];
    for (const c of cases) {
      const t = buildManualTicket(c.type, new Set(c.pick), new Set(), RUNNERS, p, allUmas, 100);
      expect(t).not.toBeNull();
      if (!t) continue;
      expect(t.variance).toBe(varianceLabel(t.hitProb, t.avgPayout, t.unit));
    }
  });

  it("tag matches rankClass(core) (no per-line majority vote)", () => {
    const { p, allUmas } = priced();
    const picked = new Set(["3", "4", "6"]);
    const t = buildManualTicket("trio", picked, new Set(), RUNNERS, p, allUmas, 100);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.tag).toBe(rankClass(t.core, p, allUmas));
  });
});

// ---------------------------------------------------------------------------
// Step 2 (ticket-generation-alignment): isFullBox heuristic. Count-based —
// lines.length >= C(core,k) (unordered) or P(core,k) (ordered). Drives the
// ManualTicketBuilder's locked-mode decision: a curated (non-full-box) auto
// ticket locks onto its original lines until the user changes a pick, so Save
// without any change can't silently regenerate the full box.
// ---------------------------------------------------------------------------
describe("manualBuilder — isFullBox", () => {
  // isFullBox only reads combos.length + core + type, so empty combos suffice.
  function combos(n: number): string[][] {
    return Array.from({ length: n }, () => []);
  }

  it("an exact full box → true (C(n,k) unordered; P(n,k) ordered)", () => {
    expect(isFullBox("quinella", combos(3), ["1", "2", "3"])).toBe(true); // C(3,2)=3
    expect(isFullBox("trifecta", combos(6), ["1", "2", "3"])).toBe(true); // P(3,3)=6
    expect(isFullBox("trio", combos(10), ["1", "2", "3", "4", "5"])).toBe(true); // C(5,3)=10
    expect(isFullBox("exacta", combos(2), ["3", "6"])).toBe(true); // P(2,2)=2
  });

  it("a curated (recommend()-shaped) ticket with fewer lines than the full count → false", () => {
    // recommend()-style trio over a 7-horse core keeps ~10 of C(7,3)=35.
    expect(isFullBox("trio", combos(10), ["1", "2", "3", "4", "5", "6", "7"])).toBe(false);
    // Curated exacta: 1 line over a 2-horse core, P(2,2)=2 expected.
    expect(isFullBox("exacta", combos(1), ["3", "6"])).toBe(false);
  });

  it("bracket_quinella is always full-box (recommend() never produces it)", () => {
    expect(isFullBox("bracket_quinella", combos(1), ["3"])).toBe(true);
  });

  it("a full box with one zero-prob combo removed reads as curated (safe false-negative)", () => {
    // A quinella box over 4 horses = C(4,2)=6 combos, but a scratched horse
    // made one combo unpriceable so the builder dropped it → 5 combos. The
    // count heuristic can't tell this from a curated subset → false (lock
    // engages). Safe: the user confirms the reduced set as-is, or taps to
    // rebuild. Documented limitation, never the unsafe direction.
    expect(isFullBox("quinella", combos(5), ["1", "2", "3", "4"])).toBe(false);
  });
});
