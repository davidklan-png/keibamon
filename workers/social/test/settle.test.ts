import { describe, it, expect } from "vitest";

// ADR-0007 Phase 4 — regression gate for the extracted settle resolver.
//
// These fixtures are a verbatim port of `frontend/src/lib/settle.test.ts`. The
// frontend test still exists (importing via the shim), and this copy is the
// Worker-side gate that the extraction didn't drift behavior. If you add a
// case here, add it on the frontend side too — they MUST agree.

import {
  resolveTicket,
  lineHits,
  isEmptyResult,
  expandPlacings,
  type BetType,
  type RaceResult,
  type ResolveTicket,
} from "../src/settle";

// Minimal ResolveTicket builder — the worker doesn't know about the frontend's
// richer `Ticket` type, and the resolver only reads `type`, `lines[].combo`,
// and `avgPayout`. This builder is intentionally close to the frontend test's
// `ticket()` helper so the cases port cleanly.
function ticket(
  type: BetType,
  combos: string[][],
  unit = 100,
  avgPayout = 5000,
): ResolveTicket {
  return {
    type,
    lines: combos.map((combo) => ({ combo })),
    avgPayout,
  };
}

// Sample finishing orders used across the table.
const ORDER_TOP3_5_16_1 = [5, 16, 1, 7, 3]; // 2026 Takarazuka Kinen shape
const RESULT_FULL: RaceResult = {
  finishers: ORDER_TOP3_5_16_1,
  payouts: [
    { pool: "quinella", combo: "5-16", yen: 1230 },
    { pool: "wide", combo: "5-16", yen: 410 },
    { pool: "wide", combo: "5-1", yen: 180 },
    { pool: "wide", combo: "16-1", yen: 230 },
    { pool: "exacta", combo: "5-16", yen: 2580 },
    { pool: "trio", combo: "1-5-16", yen: 880 },
    { pool: "trifecta", combo: "5-16-1", yen: 14200 },
  ],
};
// Same race but the publisher didn't ship payouts — only finishing order.
const RESULT_ORDER_ONLY: RaceResult = {
  finishers: ORDER_TOP3_5_16_1,
};
// Legacy {pos, umaban} form (the splash page's expected shape).
const RESULT_LEGACY_TOP3: RaceResult = {
  top3: [
    { pos: 1, umaban: 5 },
    { pos: 2, umaban: 16 },
    { pos: 3, umaban: 1 },
  ],
  payouts: [{ pool: "trifecta", combo: "5-16-1", yen: 14200 }],
};

describe("settle.isEmptyResult", () => {
  it("treats null / undefined / {} as empty", () => {
    expect(isEmptyResult(null)).toBe(true);
    expect(isEmptyResult(undefined)).toBe(true);
    expect(isEmptyResult({})).toBe(true);
    expect(isEmptyResult({ payouts: [] })).toBe(true);
  });
  it("treats a result with finishers as non-empty", () => {
    expect(isEmptyResult({ finishers: [5] })).toBe(false);
    expect(isEmptyResult({ top3: [{ pos: 1, umaban: 5 }] })).toBe(false);
  });
});

describe("settle.lineHits", () => {
  it("quinella matches top-2 as a set, in any order", () => {
    expect(lineHits("quinella", ["5", "16"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("quinella", ["16", "5"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("quinella", ["5", "1"], ORDER_TOP3_5_16_1)).toBe(false);
  });
  it("exacta matches top-2 in ORDER only", () => {
    expect(lineHits("exacta", ["5", "16"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("exacta", ["16", "5"], ORDER_TOP3_5_16_1)).toBe(false);
  });
  it("trio matches top-3 as a set", () => {
    expect(lineHits("trio", ["5", "16", "1"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("trio", ["1", "16", "5"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("trio", ["5", "16", "7"], ORDER_TOP3_5_16_1)).toBe(false);
  });
  it("trifecta matches top-3 in ORDER only", () => {
    expect(lineHits("trifecta", ["5", "16", "1"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("trifecta", ["1", "16", "5"], ORDER_TOP3_5_16_1)).toBe(false);
  });
  it("wide hits when both named horses are top-3", () => {
    expect(lineHits("wide", ["5", "16"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("wide", ["5", "1"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("wide", ["16", "1"], ORDER_TOP3_5_16_1)).toBe(true);
    expect(lineHits("wide", ["5", "7"], ORDER_TOP3_5_16_1)).toBe(false);
  });
});

describe("settle.resolveTicket — table-driven (5 bet types)", () => {
  type Case = {
    name: string;
    type: BetType;
    combos: string[][];
    unit: number;
    result: RaceResult;
    expectState: "won" | "miss" | "open";
    expectReturned?: number;
    expectSource?: "result" | "estimate";
  };

  const cases: Case[] = [
    // ---- WON cases ----
    {
      name: "quinella WON — single line, payouts present",
      type: "quinella",
      combos: [["5", "16"]],
      unit: 200,
      result: RESULT_FULL,
      expectState: "won",
      expectReturned: 2460, // 1230 * 200/100
      expectSource: "result",
    },
    {
      name: "wide WON — multiple winning pairs sum",
      type: "wide",
      combos: [["5", "16"], ["5", "1"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "won",
      expectReturned: 410 + 180, // both pairs hit at unit 100
      expectSource: "result",
    },
    {
      name: "exacta WON — ordered top-2",
      type: "exacta",
      combos: [["5", "16"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "won",
      expectReturned: 2580,
      expectSource: "result",
    },
    {
      name: "trio WON — unordered top-3",
      type: "trio",
      combos: [["1", "5", "16"]], // publisher canonicalizes; resolver should match
      unit: 100,
      result: RESULT_FULL,
      expectState: "won",
      expectReturned: 880,
      expectSource: "result",
    },
    {
      name: "trifecta WON — ordered top-3",
      type: "trifecta",
      combos: [["5", "16", "1"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "won",
      expectReturned: 14200,
      expectSource: "result",
    },

    // ---- MISS cases ----
    {
      name: "quinella MISS — combo not in top-2",
      type: "quinella",
      combos: [["5", "7"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "miss",
    },
    {
      name: "exacta MISS — wrong order",
      type: "exacta",
      combos: [["16", "5"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "miss",
    },
    {
      name: "trifecta MISS — wrong order",
      type: "trifecta",
      combos: [["1", "16", "5"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "miss",
    },
    {
      name: "wide MISS — one of pair outside top-3",
      type: "wide",
      combos: [["5", "7"]],
      unit: 100,
      result: RESULT_FULL,
      expectState: "miss",
    },

    // ---- Multi-line: partial hits ----
    {
      name: "multi-line ticket — only the hitting line pays",
      type: "wide",
      combos: [["5", "16"], ["7", "3"]], // first hits, second misses
      unit: 100,
      result: RESULT_FULL,
      expectState: "won",
      expectReturned: 410,
      expectSource: "result",
    },

    // ---- Payout-source fallbacks ----
    {
      name: "WON with no payouts in result → commit-time estimate, source=estimate",
      type: "trifecta",
      combos: [["5", "16", "1"]],
      unit: 100,
      result: RESULT_ORDER_ONLY,
      expectState: "won",
      // avgPayout defaults to 5000 in the helper; 5000 * 100/100 = 5000.
      expectReturned: 5000,
      expectSource: "estimate",
    },
    {
      name: "legacy {pos, umaban} top3 form is honored",
      type: "trifecta",
      combos: [["5", "16", "1"]],
      unit: 100,
      result: RESULT_LEGACY_TOP3,
      expectState: "won",
      expectReturned: 14200,
      expectSource: "result",
    },
  ];

  for (const c of cases) {
    it(`${c.type} — ${c.name}`, () => {
      const t = ticket(c.type, c.combos, c.unit);
      const out = resolveTicket(t, c.unit, c.result);
      expect(out.state).toBe(c.expectState);
      if (c.expectReturned !== undefined) {
        expect(out).toHaveProperty("returned");
        expect((out as { returned: number }).returned).toBe(c.expectReturned);
      }
      if (c.expectSource) {
        expect((out as { source: string }).source).toBe(c.expectSource);
      }
    });
  }
});

describe("settle.resolveTicket — empty result keeps the ticket open", () => {
  it("returns {state:'open', reason:'no_finishers_yet'} when the result is empty", () => {
    const t = ticket("trifecta", [["5", "16", "1"]]);
    const out = resolveTicket(t, 100, null);
    expect(out).toEqual({ state: "open", reason: "no_finishers_yet" });
    const out2 = resolveTicket(t, 100, {});
    expect(out2).toEqual({ state: "open", reason: "no_finishers_yet" });
    const out3 = resolveTicket(t, 100, { payouts: [] });
    expect(out3).toEqual({ state: "open", reason: "no_finishers_yet" });
  });

  it("does not mutate the input ticket", () => {
    const t = ticket("exacta", [["5", "16"]]);
    const snapshot = JSON.parse(JSON.stringify(t));
    resolveTicket(t, 100, RESULT_FULL);
    expect(t).toEqual(snapshot);
  });
});

// ===========================================================================
// Phase 4 Task 2 — dead-heat (同着) + scratch (返還) correctness.
//
// These cases exercise the resolver's expansion of placings-as-sets (a tie at
// a position lists ≥2 umabans there) and the scratch → refund branch. They
// MUST stay green before settlement goes GA on real result data — the Phase 2
// ADR flagged both as correctness gaps the single-`finishers` shape couldn't
// express.
// ===========================================================================

// Dead heat at 2nd: 5 wins; 16 and 7 dead-heat for 2nd; 1 is 3rd.
// expandPlacings yields two orderings: [5,16,1] and [5,7,1].
const DEAD_HEAT_2ND_PLACINGS = [
  { pos: 1, umabans: [5] },
  { pos: 2, umabans: [16, 7] },
  { pos: 3, umabans: [1] },
];
const DEAD_HEAT_2ND: RaceResult = {
  placings: DEAD_HEAT_2ND_PLACINGS,
  payouts: [
    // JRA lists each winning combo on a tie as its own payout row.
    { pool: "quinella", combo: "5-16", yen: 800 },
    { pool: "quinella", combo: "5-7", yen: 600 },
    { pool: "exacta", combo: "5-16", yen: 1600 },
    { pool: "exacta", combo: "5-7", yen: 1400 },
    { pool: "wide", combo: "5-16", yen: 300 },
    { pool: "wide", combo: "5-7", yen: 280 },
    { pool: "wide", combo: "16-7", yen: 420 },
    { pool: "trifecta", combo: "5-16-1", yen: 8800 },
    { pool: "trifecta", combo: "5-7-1", yen: 7600 },
    { pool: "trio", combo: "1-5-16", yen: 1200 },
    { pool: "trio", combo: "1-5-7", yen: 1100 },
  ],
};

// Dead heat at 3rd: 5, 16, then 1 and 7 tie for 3rd. expandPlacings yields
// [5,16,1] and [5,16,7] (1×1×2 = 2 orderings).
const DEAD_HEAT_3RD: RaceResult = {
  placings: [
    { pos: 1, umabans: [5] },
    { pos: 2, umabans: [16] },
    { pos: 3, umabans: [1, 7] },
  ],
  payouts: [
    { pool: "trifecta", combo: "5-16-1", yen: 6200 },
    { pool: "trifecta", combo: "5-16-7", yen: 5400 },
    { pool: "trio", combo: "1-5-16", yen: 900 },
    { pool: "trio", combo: "5-7-16", yen: 850 },
    { pool: "wide", combo: "5-1", yen: 220 },
    { pool: "wide", combo: "5-7", yen: 240 },
    { pool: "wide", combo: "16-1", yen: 290 },
    { pool: "wide", combo: "7-16", yen: 510 },
  ],
};

describe("settle.expandPlacings — dead-heat enumeration", () => {
  it("clean race → one ordering (the input order)", () => {
    expect(
      expandPlacings([
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
        { pos: 3, umabans: [1] },
      ]),
    ).toEqual([[5, 16, 1]]);
  });

  it("dead heat at 2nd → 2 orderings (1×2×1)", () => {
    expect(expandPlacings(DEAD_HEAT_2ND_PLACINGS)).toEqual([
      [5, 16, 1],
      [5, 7, 1],
    ]);
  });

  it("dead heat at 3rd → 2 orderings (1×1×2)", () => {
    expect(
      expandPlacings([
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16] },
        { pos: 3, umabans: [1, 7] },
      ]),
    ).toEqual([
      [5, 16, 1],
      [5, 16, 7],
    ]);
  });

  it("three-way tie at 2nd → 3 orderings (1×3×1)", () => {
    expect(
      expandPlacings([
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16, 7, 3] },
        { pos: 3, umabans: [1] },
      ]),
    ).toEqual([
      [5, 16, 1],
      [5, 7, 1],
      [5, 3, 1],
    ]);
  });

  it("capped at 36 orderings for implausible ties", () => {
    // 1 clean placing + 6 two-way ties = 2^6 = 64 orderings → capped at 36.
    // Each ordering has length 7 (1 + 6 placings processed before the cap).
    const placings = [
      { pos: 1, umabans: [1] },
      ...Array.from({ length: 6 }, (_, i) => ({
        pos: i + 2,
        umabans: [i * 10 + 2, i * 10 + 3],
      })),
    ];
    const out = expandPlacings(placings);
    expect(out.length).toBe(36);
    expect(out[0].length).toBe(7);
  });

  it("empty placings → empty orderings", () => {
    expect(expandPlacings([])).toEqual([]);
  });
});

describe("settle.resolveTicket — dead heat at 2nd (placings form)", () => {
  // A line naming 1st + EITHER tied 2nd-place horse hits. A line naming both
  // tied horses as a 2-horse combo only hits for wide (where both must be
  // top-3); quinella/exacta require 1st + one of the tied horses.
  const cases: Array<{
    name: string;
    type: BetType;
    combos: string[][];
    expectState: "won" | "miss";
    expectReturned?: number;
  }> = [
    // Quinella: line names 1st + one of the tied horses. Both hit under
    // enumeration (one ordering each).
    {
      name: "quinella [5,16] hits via ordering [5,16,1]",
      type: "quinella",
      combos: [["5", "16"]],
      expectState: "won",
      expectReturned: 800,
    },
    {
      name: "quinella [5,7] hits via ordering [5,7,1]",
      type: "quinella",
      combos: [["5", "7"]],
      expectState: "won",
      expectReturned: 600,
    },
    // Exacta: ordered 1st→2nd. [5,16] matches [5,16,1]; [5,7] matches [5,7,1].
    {
      name: "exacta [5,16] hits (ordered)",
      type: "exacta",
      combos: [["5", "16"]],
      expectState: "won",
      expectReturned: 1600,
    },
    {
      name: "exacta [5,7] hits (the OTHER tied horse)",
      type: "exacta",
      combos: [["5", "7"]],
      expectState: "won",
      expectReturned: 1400,
    },
    // Wide: both horses top-3. [5,16], [5,7], and [16,7] all hit (top-3
    // contains all of {5, 16, 7, 1} in JRA's rank semantics, but enumeration
    // covers the 1st + tied-2nd cases; the [16,7] pair is the JRA "two
    // tied horses both top-3" pair, listed in payouts).
    {
      name: "wide [5,16] hits",
      type: "wide",
      combos: [["5", "16"]],
      expectState: "won",
      expectReturned: 300,
    },
    {
      name: "wide [5,7] hits",
      type: "wide",
      combos: [["5", "7"]],
      expectState: "won",
      expectReturned: 280,
    },
    // Trio: top-3 as a set. Both [5,16,1] and [5,7,1] hit (one ordering each).
    {
      name: "trio [5,16,1] hits",
      type: "trio",
      combos: [["5", "16", "1"]],
      expectState: "won",
      expectReturned: 1200,
    },
    {
      name: "trio [5,7,1] hits (the OTHER tied horse)",
      type: "trio",
      combos: [["5", "7", "1"]],
      expectState: "won",
      expectReturned: 1100,
    },
    // Trifecta: top-3 ordered. [5,16,1] and [5,7,1] each match one ordering.
    {
      name: "trifecta [5,16,1] hits",
      type: "trifecta",
      combos: [["5", "16", "1"]],
      expectState: "won",
      expectReturned: 8800,
    },
    {
      name: "trifecta [5,7,1] hits",
      type: "trifecta",
      combos: [["5", "7", "1"]],
      expectState: "won",
      expectReturned: 7600,
    },
    // MISS: a line naming only the two tied-2nd horses (no 1st-place horse)
    // can't be top-2 in either ordering.
    {
      name: "quinella [16,7] misses — neither is 1st in any ordering",
      type: "quinella",
      combos: [["16", "7"]],
      expectState: "miss",
    },
    {
      name: "trifecta [16,5,1] misses — wrong order in every enumeration",
      type: "trifecta",
      combos: [["16", "5", "1"]],
      expectState: "miss",
    },
  ];

  for (const c of cases) {
    it(`${c.type} — ${c.name}`, () => {
      const t = ticket(c.type, c.combos, 100);
      const out = resolveTicket(t, 100, DEAD_HEAT_2ND);
      expect(out.state).toBe(c.expectState);
      if (c.expectReturned !== undefined) {
        expect(out).toHaveProperty("returned");
        expect((out as { returned: number }).returned).toBe(c.expectReturned);
      }
    });
  }

  it("multi-line ticket sums payouts across the tied horses", () => {
    // Two winning quinella lines: [5,16] pays 800, [5,7] pays 600 → 1400.
    // Verifies payoutYen sums across multiple winning lines AND that
    // enumeration finds both tied-horse variants.
    const t = ticket("quinella", [["5", "16"], ["5", "7"]], 100);
    const out = resolveTicket(t, 100, DEAD_HEAT_2ND);
    expect(out.state).toBe("won");
    expect((out as { returned: number }).returned).toBe(1400);
  });
});

describe("settle.resolveTicket — dead heat at 3rd (placings form)", () => {
  const cases: Array<{
    name: string;
    type: BetType;
    combos: string[][];
    expectState: "won" | "miss";
    expectReturned?: number;
  }> = [
    {
      name: "trifecta [5,16,1] hits via ordering [5,16,1]",
      type: "trifecta",
      combos: [["5", "16", "1"]],
      expectState: "won",
      expectReturned: 6200,
    },
    {
      name: "trifecta [5,16,7] hits via ordering [5,16,7]",
      type: "trifecta",
      combos: [["5", "16", "7"]],
      expectState: "won",
      expectReturned: 5400,
    },
    {
      name: "trio [5,16,1] hits",
      type: "trio",
      combos: [["5", "16", "1"]],
      expectState: "won",
      expectReturned: 900,
    },
    {
      name: "trio [5,16,7] hits (the OTHER tied horse)",
      type: "trio",
      combos: [["5", "16", "7"]],
      expectState: "won",
      expectReturned: 850,
    },
    {
      name: "wide [16,1] hits — 2nd and one tied 3rd both top-3",
      type: "wide",
      combos: [["16", "1"]],
      expectState: "won",
      expectReturned: 290,
    },
    {
      name: "wide [16,7] hits — 2nd and the other tied 3rd",
      type: "wide",
      combos: [["16", "7"]],
      expectState: "won",
      expectReturned: 510,
    },
    {
      name: "trifecta [5,1,16] misses — wrong order in every enumeration",
      type: "trifecta",
      combos: [["5", "1", "16"]],
      expectState: "miss",
    },
  ];

  for (const c of cases) {
    it(`${c.type} — ${c.name}`, () => {
      const t = ticket(c.type, c.combos, 100);
      const out = resolveTicket(t, 100, DEAD_HEAT_3RD);
      expect(out.state).toBe(c.expectState);
      if (c.expectReturned !== undefined) {
        expect(out).toHaveProperty("returned");
        expect((out as { returned: number }).returned).toBe(c.expectReturned);
      }
    });
  }
});

describe("settle.resolveTicket — scratch → refund (all 5 bet types)", () => {
  // Any line containing a scratched umaban refunds the WHOLE ticket (JRA 返還).
  // We don't compute the refund amount — the state alone is the contract.
  const scratchResult: RaceResult = {
    finishers: [5, 16, 1, 7, 3],
    scratched: [7], // 7 was a late scratch; any line naming it refunds
    payouts: [],
  };

  const types: BetType[] = ["quinella", "wide", "exacta", "trio", "trifecta"];
  for (const type of types) {
    it(`${type} with a scratched umaban in the line → refunded`, () => {
      const combos =
        type === "trifecta" || type === "trio"
          ? [["5", "7", "16"]]
          : [["5", "7"]];
      const t = ticket(type, combos, 100);
      const out = resolveTicket(t, 100, scratchResult);
      expect(out).toEqual({ state: "refunded", reason: "scratched" });
    });
  }

  it("ticket WITHOUT a scratched umaban settles normally", () => {
    // Same scratch (7), but the line names only non-scratched horses.
    const t = ticket("quinella", [["5", "16"]], 100);
    const out = resolveTicket(t, 100, scratchResult);
    // 5 and 16 are the real top-2 → won, no payouts present → estimate.
    expect(out.state).toBe("won");
    expect((out as { source: string }).source).toBe("estimate");
  });

  it("scratch refunds the WHOLE multi-line ticket even if other lines hit", () => {
    // Line 1 would win (5,16 are top-2); line 2 contains the scratch. JRA
    // refunds ALL lines containing a scratch in the ticket — the resolver
    // refunds the whole ticket regardless of the other lines' outcomes.
    const t = ticket("quinella", [["5", "16"], ["5", "7"]], 100);
    const out = resolveTicket(t, 100, scratchResult);
    expect(out).toEqual({ state: "refunded", reason: "scratched" });
  });
});

// ===========================================================================
// bracket_quinella (枠連, "gate" in the app's UI) — bracket-space combo.
//
// Unlike the other five bet types, the ticket's `combo` names WAKU (1-8),
// not umabans, so hitting requires a per-race umaban→waku lookup
// (`RaceResult.gates`). Two different horses can legitimately share one
// waku, so the comparison must be a duplicate-preserving multiset match,
// not a Set (which would collapse ["3","3"] to a single element).
// ===========================================================================

// Same finish as ORDER_TOP3_5_16_1 (5 wins, 16 2nd, 1 3rd, 7 4th, 3 5th),
// with a bracket lookup: horse 5→waku 3, horse 16→waku 8, horse 1→waku 1.
const GATES_TOP3_5_16_1 = [
  { umaban: 5, waku: 3 },
  { umaban: 16, waku: 8 },
  { umaban: 1, waku: 1 },
  { umaban: 7, waku: 4 },
  { umaban: 3, waku: 2 },
];
const RESULT_WITH_GATES: RaceResult = {
  finishers: ORDER_TOP3_5_16_1,
  gates: GATES_TOP3_5_16_1,
  payouts: [{ pool: "bracket_quinella", combo: "3-8", yen: 1190 }],
};

describe("settle.lineHits — bracket_quinella", () => {
  const gates = new Map(GATES_TOP3_5_16_1.map((g) => [g.umaban, g.waku]));

  it("matches the top-2's brackets, unordered", () => {
    expect(lineHits("bracket_quinella", ["3", "8"], ORDER_TOP3_5_16_1, gates)).toBe(true);
    expect(lineHits("bracket_quinella", ["8", "3"], ORDER_TOP3_5_16_1, gates)).toBe(true);
  });

  it("misses a bracket combo not matching the top-2", () => {
    expect(lineHits("bracket_quinella", ["3", "1"], ORDER_TOP3_5_16_1, gates)).toBe(false);
  });

  it("returns false without a gates map (can't resolve bracket space)", () => {
    expect(lineHits("bracket_quinella", ["3", "8"], ORDER_TOP3_5_16_1)).toBe(false);
  });

  it("multiset match: two horses sharing a bracket, combo names it twice", () => {
    // Horses 5 and 16 both in waku 3; top-2 are exactly those two horses.
    const sharedGates = new Map([
      [5, 3],
      [16, 3],
      [1, 1],
    ]);
    expect(lineHits("bracket_quinella", ["3", "3"], ORDER_TOP3_5_16_1, sharedGates)).toBe(true);
    // A combo of ["3","8"] should NOT match when both top-2 are waku 3 —
    // proves this isn't silently collapsing to a Set of brackets.
    expect(lineHits("bracket_quinella", ["3", "8"], ORDER_TOP3_5_16_1, sharedGates)).toBe(false);
  });
});

describe("settle.resolveTicket — bracket_quinella", () => {
  it("WON — bracket combo matches top-2's brackets", () => {
    const t = ticket("bracket_quinella", [["3", "8"]], 100);
    const out = resolveTicket(t, 100, RESULT_WITH_GATES);
    expect(out.state).toBe("won");
    expect((out as { returned: number }).returned).toBe(1190);
    expect((out as { source: string }).source).toBe("result");
  });

  it("MISS — bracket combo doesn't match", () => {
    const t = ticket("bracket_quinella", [["1", "2"]], 100);
    const out = resolveTicket(t, 100, RESULT_WITH_GATES);
    expect(out.state).toBe("miss");
  });

  it("stays OPEN when the result has placings but no gates block", () => {
    // Simulates a result built before bracket_quinella support shipped.
    const t = ticket("bracket_quinella", [["3", "8"]], 100);
    const out = resolveTicket(t, 100, RESULT_ORDER_ONLY); // no `gates` field
    expect(out).toEqual({ state: "open", reason: "no_finishers_yet" });
  });

  it("is NOT affected by the generic scratch-refund check (different number space)", () => {
    // scratched:[8] would, if wrongly compared against the umaban-space
    // scratch check, look like it refunds a ticket naming bracket "8" — but
    // bracket_quinella's combo is bracket space, not umaban space, so this
    // must resolve on the actual bracket match instead of short-circuiting
    // to refunded.
    const resultWithUnrelatedScratch: RaceResult = {
      ...RESULT_WITH_GATES,
      scratched: [8], // umaban 8 scratched — irrelevant to a "waku 8" combo
    };
    const t = ticket("bracket_quinella", [["3", "8"]], 100);
    const out = resolveTicket(t, 100, resultWithUnrelatedScratch);
    expect(out.state).toBe("won");
  });
});

describe("settle.resolveTicket — placings precedence over legacy forms", () => {
  it("placings take precedence when both placings and finishers are present", () => {
    // If both are supplied, placings wins. A tie at 2nd (16,7) is honored —
    // [5,7] hits via the tie even though `finishers` says strict 1-2-3 order.
    const mixed: RaceResult = {
      finishers: [5, 16, 1, 7, 3], // legacy — should be IGNORED
      placings: [
        { pos: 1, umabans: [5] },
        { pos: 2, umabans: [16, 7] },
        { pos: 3, umabans: [1] },
      ],
      payouts: [{ pool: "quinella", combo: "5-7", yen: 600 }],
    };
    const t = ticket("quinella", [["5", "7"]], 100);
    const out = resolveTicket(t, 100, mixed);
    expect(out.state).toBe("won");
    expect((out as { returned: number }).returned).toBe(600);
  });

  it("legacy top3 with duplicate pos is treated as a dead heat", () => {
    // Two top3 entries with pos=2 → a dead heat at 2nd in legacy form.
    const legacyTie: RaceResult = {
      top3: [
        { pos: 1, umaban: 5 },
        { pos: 2, umaban: 16 },
        { pos: 2, umaban: 7 },
      ],
      payouts: [{ pool: "quinella", combo: "5-7", yen: 600 }],
    };
    const t = ticket("quinella", [["5", "7"]], 100);
    const out = resolveTicket(t, 100, legacyTie);
    expect(out.state).toBe("won");
    expect((out as { returned: number }).returned).toBe(600);
  });
});
