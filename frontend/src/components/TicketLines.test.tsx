// ============================================================================
// TicketLines tests (ticket-detail UX, 2026-07-12).
//
// What this pins:
//   - BOX: renders the payload's number SET as tiles (NOT the expanded
//     permutations) + a BOX badge + a points line.
//   - FORMATION: labeled position columns (two for exacta, three for trifecta).
//   - WHEEL: axis (軸) tile prominent + partners (相手) row.
//   - SINGLE/legacy: capped chips, no structure badge.
//   - Derivation: a legacy flat ticket that IS a full box expansion renders as
//     Box; one that IS NOT (false-positive guard) stays on chips.
//   - points variant (full/count/none), incl. the count on the chips path; JA label set.
//
// Pure presentational — renderToStaticMarkup (no jsdom, no fetch), like
// FillGuide.test.tsx.
// ============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { winProbs, type Runner, type ValueTag } from "../lib/fairvalue";
import {
  buildBoxTicket,
  buildFormationTicket,
  buildWheelTicket,
} from "../lib/recommender";
import type { Ticket } from "../lib/types";
import { TicketLines, deriveBoxSet } from "./TicketLines";

const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4, name: "A" },
  { uma: "2", odds: 3.5, name: "B" },
  { uma: "3", odds: 6.2, name: "C" },
  { uma: "4", odds: 9.0, name: "D" },
  { uma: "5", odds: 18.5, name: "E" },
];
const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);

/** Count occurrences of an exact `class="..."` attribute value. */
function countClass(html: string, cls: string): number {
  return html.split(`class="${cls}"`).length - 1;
}

/** Build a minimal flat (no-structure) Ticket from raw combos — for derivation tests. */
function flatTicket(type: Ticket["type"], combos: string[][], unit = 100): Ticket {
  const core = [...new Set(combos.flat())];
  return {
    id: "flat-test",
    type,
    lines: combos.map((combo) => ({
      combo,
      prob: 0.1,
      fairOdds: 10,
      payout: 1000,
      tag: "fair" as ValueTag,
    })),
    hitProb: 0.1,
    cost: combos.length * unit,
    expectedReturn: combos.length * 100,
    avgPayout: 1000,
    bestCaseReturn: 1000,
    core,
    tag: "fair" as ValueTag,
    unit,
    variance: "high",
    rationaleKeys: [],
  };
}

describe("TicketLines", () => {
  beforeEach(() => setLang("en"));

  // ---- BOX -------------------------------------------------------------
  it("box: renders the payload SET as tiles, not the permutations (+ points)", () => {
    // Quinella box of {1,2,3,4}: C(4,2)=6 combos, but the SET is 4 horses.
    const ticket = buildBoxTicket("quinella", ["1", "2", "3", "4"], p, allUmas, 100, "tl");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket!} unitStake={100} />,
    );
    // BOX badge present.
    expect(html).toContain("BOX");
    // Exactly 4 tiles — the SET (1,2,3,4), NOT the 6 combos or 12 permutations.
    expect(countClass(html, "tl-tile")).toBe(4);
    expect(html).toContain(">1<");
    expect(html).toContain(">4<");
    // 5 is not in the set → not rendered as a tile.
    expect(html).not.toContain(">5<");
    // Points line carries the combo count (6), proving cost framing.
    expect(html).toContain("tl-points");
    expect(html).toContain("6");
    // No chip fallback.
    expect(html).not.toContain("tl-chip");
  });

  it("box: points=\"none\" suppresses the points line", () => {
    const ticket = buildBoxTicket("trio", ["1", "2", "3", "4"], p, allUmas, 100, "tl");
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket!} unitStake={100} points="none" />,
    );
    expect(html).toContain("BOX");
    expect(html).not.toContain("tl-points");
  });

  it("box: points=\"count\" renders the combo total with no unit/cost", () => {
    // C(4,2)=6 quinella combos over {1,2,3,4}. The count line states the total
    // without duplicating the cost a host already prints.
    const ticket = buildBoxTicket("quinella", ["1", "2", "3", "4"], p, allUmas, 100, "tl");
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket!} unitStake={100} points="count" />,
    );
    expect(html).toContain("tl-points");
    expect(html).toContain("6 combos");
    // No unit, no cost, no "×" framing — count only.
    expect(html).not.toContain("¥100");
    expect(html).not.toMatch(/×.*=/);
  });

  it("chips: points=\"count\" renders the total on the legacy chip path (no +N)", () => {
    // A flat non-box ticket (3 of P(5,3)) takes the chip path. The count line
    // now renders there too, and the compact "+N" truncation chip is gone —
    // the count line is the one way the combo total is expressed.
    const ticket = flatTicket("trifecta", [
      ["1", "2", "3"],
      ["1", "2", "4"],
      ["1", "3", "4"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} points="count" />,
    );
    expect(html).toContain("tl-chip");
    expect(html).toContain("tl-points");
    expect(html).toContain("3 combos");
    expect(html).not.toContain("tl-chip-more"); // the old "+N" chip is gone
  });

  // ---- FORMATION -------------------------------------------------------
  it("formation: renders labeled position columns (trifecta = 3 columns)", () => {
    const set = ["1", "2", "3"];
    const ticket = buildFormationTicket(
      "trifecta",
      [set, set, set],
      p,
      allUmas,
      100,
      "tl",
    );
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket!} unitStake={100} />,
    );
    expect(html).toContain("FORMATION");
    // Three position columns + two arrows between them.
    expect(countClass(html, "tl-col")).toBe(3);
    expect(countClass(html, "tl-arrow")).toBe(2);
    // Position labels present.
    expect(html).toContain("1st");
    expect(html).toContain("3rd");
    expect(html).toContain("tl-points");
  });

  it("formation: exacta = two columns", () => {
    const set = ["1", "2", "3", "4"];
    const ticket = buildFormationTicket("exacta", [set, set], p, allUmas, 100, "tl");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket!} unitStake={100} />,
    );
    expect(countClass(html, "tl-col")).toBe(2);
    expect(countClass(html, "tl-arrow")).toBe(1);
  });

  // ---- WHEEL -----------------------------------------------------------
  it("wheel: axis prominent + partners row + axis tag", () => {
    const ticket = buildWheelTicket(
      "trifecta",
      ["1"],
      ["2", "3", "4"],
      1,
      p,
      allUmas,
      100,
      "tl",
    );
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket!} unitStake={100} />,
    );
    expect(html).toContain("WHEEL");
    // Axis tag (軸 / axis) + partners label.
    expect(html).toContain("tl-axis-tag");
    expect(html).toContain("Partners");
    // Two columns: axis + partners.
    expect(countClass(html, "tl-col")).toBe(2);
    expect(html).toContain("tl-points");
  });

  // ---- SINGLE / legacy -------------------------------------------------
  it("single: a small non-box flat ticket renders capped chips, no badge", () => {
    const ticket = flatTicket("trifecta", [
      ["1", "2", "3"],
      ["2", "3", "4"],
      ["1", "3", "4"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).not.toContain("BOX");
    expect(html).not.toContain("FORMATION");
    expect(html).not.toContain("WHEEL");
    expect(html).toContain("tl-chip");
    expect(html).not.toContain("tl-tile");
  });

  it("single: a long flat non-box ticket caps chips and offers the 'all N combos' expander", () => {
    // 10 trifecta combos from a 5-horse field — NOT a full box (P(5,3)=60),
    // and more than the full-mode CAP of 8.
    const combos = [
      ["1", "2", "3"],
      ["1", "2", "4"],
      ["1", "2", "5"],
      ["1", "3", "4"],
      ["1", "3", "5"],
      ["2", "1", "3"],
      ["2", "1", "4"],
      ["2", "3", "4"],
      ["3", "1", "2"],
      ["3", "2", "1"],
    ];
    const ticket = flatTicket("trifecta", combos, 100);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).toContain("tl-more");
    expect(html).toContain("All 10 combos");
  });

  // ---- Derivation ------------------------------------------------------
  it("derivation: a legacy flat ticket that IS a full box renders as Box", () => {
    // All 6 trifecta permutations of {1,2,3} — no `structure` field set.
    const perms = [
      ["1", "2", "3"],
      ["1", "3", "2"],
      ["2", "1", "3"],
      ["2", "3", "1"],
      ["3", "1", "2"],
      ["3", "2", "1"],
    ];
    const ticket = flatTicket("trifecta", perms);
    expect(ticket.structure).toBeUndefined();
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    // Detected as a box: badge + the 3-horse SET (not 6 chips).
    expect(html).toContain("BOX");
    expect(countClass(html, "tl-tile")).toBe(3);
    expect(html).toContain("6"); // combo count in the points line
    expect(html).not.toContain("tl-chip");
  });

  it("derivation FALSE-POSITIVE GUARD: a flat non-box must NOT render as Box", () => {
    // 3 of the 6 trifecta permutations of {1,2,3} — a real bet, NOT a full box.
    const partial = [
      ["1", "2", "3"],
      ["2", "1", "3"],
      ["3", "2", "1"],
    ];
    const ticket = flatTicket("trifecta", partial);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).not.toContain("BOX");
    expect(html).not.toContain("tl-tile");
    expect(html).toContain("tl-chip");
  });

  it("derivation: a legacy flat quinella box renders as Box", () => {
    // C(3,2)=3 combos of {1,2,3} — exactly a quinella box.
    const ticket = flatTicket("quinella", [
      ["1", "2"],
      ["1", "3"],
      ["2", "3"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).toContain("BOX");
    expect(countClass(html, "tl-tile")).toBe(3);
  });

  // ---- bracket_quinella (枠連) -----------------------------------------
  // Brackets are a SEPARATE number space from umabans: a "3" tile must read as
  // bracket 3, not horse 3 (bet-type-aware tile treatment), and the box
  // derivation must tolerate same-bracket ゾロ目 lines (3-3) that the umaban
  // "no repeat within a combo" guard would reject. The false-positive guard
  // (a hand-picked partial bracket selection must NOT render as a box) is the
  // critical correctness property.
  it("bracket box: renders the bracket SET as labelled tiles (not umabans)", () => {
    // 3 brackets {3,7,8} → C(3,2)=3 cross pairs. A full bracket box.
    const ticket = flatTicket("bracket_quinella", [
      ["3", "7"],
      ["3", "8"],
      ["7", "8"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).toContain("BOX");
    // Bracket tiles carry the bet-type-aware class (multi-class, so count via
    // regex, not the exact-match countClass helper) + the head tag labels them.
    expect((html.match(/tl-tile-bracket/g) || []).length).toBe(3);
    expect(html).toContain("tl-bracket-tag");
    expect(html).toContain("Brackets");
    // The 3-bracket SET as tiles, not 3 chips.
    expect(html).not.toContain("tl-chip");
  });

  it("bracket box: a same-bracket ゾロ目 line (3-3) does NOT degrade to chips", () => {
    // {3,7,8} full cross expansion + a legal 3-3 ゾロ目 (bracket 3 fields ≥2
    // horses). The umaban repeat-guard would reject 3-3 and fall back to chips;
    // the bracket path permits it and still renders the SET.
    const ticket = flatTicket("bracket_quinella", [
      ["3", "7"],
      ["3", "8"],
      ["7", "8"],
      ["3", "3"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).toContain("BOX");
    expect((html.match(/tl-tile-bracket/g) || []).length).toBe(3);
    expect(html).not.toContain("tl-chip");
  });

  it("bracket FALSE-POSITIVE GUARD: a partial bracket selection must NOT render as Box", () => {
    // Only 2 of the 3 cross pairs of {3,7,8} — a hand-picked subset, NOT a
    // full bracket box. Must render as chips so it can't be mistaken for one.
    const ticket = flatTicket("bracket_quinella", [
      ["3", "7"],
      ["3", "8"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).not.toContain("BOX");
    expect(html).not.toContain("tl-tile-bracket");
    expect(html).toContain("tl-chip");
  });

  // ---- deriveBoxSet direct ---------------------------------------------
  it("deriveBoxSet: full ordered box → set; partial → null; single → null", () => {
    expect(
      deriveBoxSet(
        flatTicket("trifecta", [
          ["1", "2", "3"],
          ["1", "3", "2"],
          ["2", "1", "3"],
          ["2", "3", "1"],
          ["3", "1", "2"],
          ["3", "2", "1"],
        ]),
      ),
    ).toEqual(["1", "2", "3"]);
    expect(
      deriveBoxSet(
        flatTicket("trifecta", [
          ["1", "2", "3"],
          ["2", "1", "3"],
        ]),
      ),
    ).toBeNull();
    // A single combination (2-horse quinella = C(2,2)=1) is not a multi-way box.
    expect(deriveBoxSet(flatTicket("quinella", [["1", "2"]]))).toBeNull();
  });

  it("deriveBoxSet: bracket full cross-box → set; with ゾロ目 → set; partial → null", () => {
    // 3 brackets {3,7,8}: C(3,2)=3 cross pairs → the bracket set.
    expect(
      deriveBoxSet(
        flatTicket("bracket_quinella", [
          ["3", "7"],
          ["3", "8"],
          ["7", "8"],
        ]),
      ),
    ).toEqual(["3", "7", "8"]);
    // Same full cross-box PLUS a legal 3-3 ゾロ目 line — still the bracket set
    // (same-bracket pairs are permitted, not required).
    expect(
      deriveBoxSet(
        flatTicket("bracket_quinella", [
          ["3", "7"],
          ["3", "8"],
          ["7", "8"],
          ["3", "3"],
        ]),
      ),
    ).toEqual(["3", "7", "8"]);
    // Only 2 of 3 cross pairs → null (false-positive guard).
    expect(
      deriveBoxSet(
        flatTicket("bracket_quinella", [
          ["3", "7"],
          ["3", "8"],
        ]),
      ),
    ).toBeNull();
  });

  // ---- Old share snapshot (no structure) -------------------------------
  it("legacy snapshot: a bare ticket with no structure renders via the chip path", () => {
    const ticket = flatTicket("exacta", [
      ["1", "2"],
      ["3", "4"],
    ]);
    // No migration: the ticket object is unchanged, structure stays absent.
    expect(ticket.structure).toBeUndefined();
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).toContain("tl-chip");
    expect(html).not.toContain("tl-tile");
    expect(html).not.toContain("BOX");
  });

  // ---- JA labels -------------------------------------------------------
  it("JA: structure badges + position/partner labels localize", () => {
    setLang("ja");
    const wheel = buildWheelTicket("trifecta", ["1"], ["2", "3"], 1, p, allUmas, 100, "tl");
    const html = renderToStaticMarkup(
      <TicketLines ticket={wheel!} unitStake={100} />,
    );
    expect(html).toContain("流し"); // wheel
    expect(html).toContain("軸"); // axis
    expect(html).toContain("相手"); // partners
    expect(html).toContain("1着"); // position 1 label
  });

  it("JA: box badge + points line localize", () => {
    setLang("ja");
    const box = buildBoxTicket("quinella", ["1", "2", "3"], p, allUmas, 100, "tl");
    const html = renderToStaticMarkup(
      <TicketLines ticket={box!} unitStake={100} />,
    );
    expect(html).toContain("ボックス"); // BOX
    expect(html).toContain("点"); // combo counter (点)
  });

  it("JA: bracket box head tag localizes to 枠", () => {
    setLang("ja");
    const ticket = flatTicket("bracket_quinella", [
      ["3", "7"],
      ["3", "8"],
      ["7", "8"],
    ]);
    const html = renderToStaticMarkup(
      <TicketLines ticket={ticket} unitStake={100} />,
    );
    expect(html).toContain("ボックス"); // BOX
    expect(html).toContain("tl-bracket-tag");
    expect(html).toContain("枠"); // Brackets → 枠
  });
});
