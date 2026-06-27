import { describe, it, expect } from "vitest";
import {
  resolveTicket,
  lineHits,
  isEmptyResult,
  expandPlacings,
  type RaceResult,
} from "./settle";
import { winProbs, wideTicketStats, type Runner } from "./fairvalue";
import type { Ticket } from "./types";
import type { BetType } from "./fairvalue";

// ADR-0007 Phase 2 — table-driven settle tests for all five bet types the
// recommender emits. Each case has a fresh race result (the actual finishing
// order on the day) and asserts the resolver's won/miss + returned value.

function ticket(type: BetType, combos: string[][], unit = 100, avgPayout = 5000): Ticket {
  return {
    id: "t",
    type,
    lines: combos.map((combo) => ({
      combo,
      prob: 0.1,
      fairOdds: 10,
      payout: 1000,
      tag: "blend",
    })),
    hitProb: 0.1,
    cost: combos.length * unit,
    expectedReturn: combos.length * unit * 0.9,
    avgPayout,
    bestCaseReturn: 1000,
    core: Array.from(new Set(combos.flat())),
    tag: "blend",
    unit,
    variance: "low",
    rationaleKeys: [],
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
// Mirror of workers/social/test/settle.test.ts. If you add a case here, add
// it on the worker side too — they MUST agree (the resolver is shared).
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

// Dead heat at 3rd: 5, 16, then 1 and 7 tie for 3rd.
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
  const cases: Array<{
    name: string;
    type: BetType;
    combos: string[][];
    expectState: "won" | "miss";
    expectReturned?: number;
  }> = [
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
  const scratchResult: RaceResult = {
    finishers: [5, 16, 1, 7, 3],
    scratched: [7],
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
    const t = ticket("quinella", [["5", "16"]], 100);
    const out = resolveTicket(t, 100, scratchResult);
    expect(out.state).toBe("won");
    expect((out as { source: string }).source).toBe("estimate");
  });

  it("scratch refunds the WHOLE multi-line ticket even if other lines hit", () => {
    const t = ticket("quinella", [["5", "16"], ["5", "7"]], 100);
    const out = resolveTicket(t, 100, scratchResult);
    expect(out).toEqual({ state: "refunded", reason: "scratched" });
  });
});

describe("settle.resolveTicket — placings precedence over legacy forms", () => {
  it("placings take precedence when both placings and finishers are present", () => {
    const mixed: RaceResult = {
      finishers: [5, 16, 1, 7, 3],
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

// ============================================================================
// ADR-wide-co-win — settlement vs prediction consistency for WIDE.
//
// Wide is the only JRA bet where multiple lines can win in a single race
// (up to C(3,2)=3 pairs when the ticket's covered horses fill the board).
// The settlement resolver must credit every winning line against the
// publisher's payouts (it does — resolveTicket loops every line and sums
// yen for each that hits), and the recommender's wideTicketStats must
// produce a best-case return that AGREES with what settlement credits on
// the same top-3 outcome. This pins the two paths to the same answer so
// prediction and settlement can't drift.
// ============================================================================
describe("wide multi-win — settlement credits every winning pair", () => {
  // Realistic 6-horse market so the trio kernel has clean probabilities.
  const WIDE_RUNNERS: Runner[] = [
    { uma: "1", odds: 2.4 },
    { uma: "2", odds: 3.5 },
    { uma: "3", odds: 6.2 },
    { uma: "4", odds: 9.0 },
    { uma: "5", odds: 18.5 },
    { uma: "6", odds: 51.0 },
  ];
  const { p } = winProbs(WIDE_RUNNERS);
  const allUmas = WIDE_RUNNERS.map((r) => r.uma);

  it("resolveTicket credits the sum of all wide pairs that hit the top-3", () => {
    // Ticket holds all 3 pairs of {1,2,3}. Day-of: top-3 = [1,2,4] → only
    // pair {1,2} hits. Settlement credits just that pair's payout row.
    const tk: Ticket = {
      id: "wide-test",
      type: "wide",
      lines: [
        { combo: ["1", "2"], prob: 0.3, fairOdds: 3, payout: 410, tag: "blend" },
        { combo: ["1", "3"], prob: 0.2, fairOdds: 5, payout: 700, tag: "blend" },
        { combo: ["2", "3"], prob: 0.15, fairOdds: 7, payout: 900, tag: "blend" },
      ],
      hitProb: 0,
      cost: 300,
      expectedReturn: 0,
      avgPayout: 670,
      bestCaseReturn: 0,
      core: ["1", "2", "3"],
      tag: "blend",
      unit: 100,
      variance: "low",
      rationaleKeys: [],
    };
    const result: RaceResult = {
      finishers: [1, 2, 4, 5, 6],
      payouts: [{ pool: "wide", combo: "1-2", yen: 410 }],
    };
    const out = resolveTicket(tk, 100, result);
    expect(out.state).toBe("won");
    expect((out as { returned: number }).returned).toBe(410);
  });

  it("when all 3 covered horses fill the board, settlement credits all 3 pairs", () => {
    // Same ticket, day-of: top-3 = [1,2,3] → all 3 pairs hit. Settlement
    // sums the 3 payout rows (mirrors what a real bettor receives).
    const tk: Ticket = {
      id: "wide-test",
      type: "wide",
      lines: [
        { combo: ["1", "2"], prob: 0.3, fairOdds: 3, payout: 410, tag: "blend" },
        { combo: ["1", "3"], prob: 0.2, fairOdds: 5, payout: 700, tag: "blend" },
        { combo: ["2", "3"], prob: 0.15, fairOdds: 7, payout: 900, tag: "blend" },
      ],
      hitProb: 0,
      cost: 300,
      expectedReturn: 0,
      avgPayout: 670,
      bestCaseReturn: 0,
      core: ["1", "2", "3"],
      tag: "blend",
      unit: 100,
      variance: "low",
      rationaleKeys: [],
    };
    const result: RaceResult = {
      finishers: [1, 2, 3, 4, 5],
      payouts: [
        { pool: "wide", combo: "1-2", yen: 410 },
        { pool: "wide", combo: "1-3", yen: 700 },
        { pool: "wide", combo: "2-3", yen: 900 },
      ],
    };
    const out = resolveTicket(tk, 100, result);
    expect(out.state).toBe("won");
    expect((out as { returned: number }).returned).toBe(410 + 700 + 900);
  });

  it("wideTicketStats.bestCaseReturn matches the all-three-hit settlement lines", () => {
    // Consistency pin: the recommender's predicted best-case (over the
    // Henery γ model) and the resolver's actual credit (over the day's
    // payouts) agree on WHICH LINES pay in the all-three-hit scenario.
    // The numerical payouts differ (one is fair-value est, the other is
    // the real payout table), but the SET of paying lines is identical —
    // 3 pairs from {1,2,3}.
    const lines = [
      { combo: ["1", "2"], payout: 410 },
      { combo: ["1", "3"], payout: 700 },
      { combo: ["2", "3"], payout: 900 },
    ];
    const stats = wideTicketStats(lines, p, allUmas);
    // All 3 lines pay in the all-three-hit case → best case = sum.
    expect(stats.bestCaseReturn).toBe(410 + 700 + 900);
    // A 3-pair box covering exactly 3 horses wins iff those 3 finish top-3;
    // in that case 3 lines pay, so E[winning lines] = 3 × P(they fill board).
    expect(stats.expWinningLines).toBeLessThanOrEqual(3.0);
    expect(stats.expWinningLines).toBeGreaterThan(0);
  });
});
