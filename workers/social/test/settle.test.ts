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
