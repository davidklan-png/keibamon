// ============================================================================
// FillGuide tests (ADR-0011 Phase 3a + 3b — Option B).
//
// What this pins:
//   - BOX path (3a): the number grid 1..N highlights exactly the ticket's `set`;
//     BOX badge renders; point count + total render.
//   - Ordered path (3b): FORMATION / WHEEL badges render; position columns
//     with directional arrows render; axis tag marks the wheel's anchor slot.
//   - Share gate (3b Part 4): [data-not-advice] micro-line + share button are
//     present so exportTicketCard's hard gate is satisfied.
//
// Pure presentational — renderToStaticMarkup (no jsdom, no fetch).
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
import { FillGuide } from "./FillGuide";

const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4, name: "A" },
  { uma: "2", odds: 3.5, name: "B" },
  { uma: "3", odds: 6.2, name: "C" },
  { uma: "4", odds: 9.0, name: "D" },
  { uma: "5", odds: 18.5, name: "E" },
  { uma: "6", odds: 51.0, name: "F" },
  { uma: "7", odds: 8.5, name: "G" },
  { uma: "8", odds: 13.0, name: "H" },
];
const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);

/** Count occurrences of an exact `class="..."` attribute value. */
function countClass(html: string, cls: string): number {
  return html.split(`class="${cls}"`).length - 1;
}

/**
 * Build a 枠連 (bracket_quinella) BOX ticket directly — buildBoxTicket only
 * covers quinella/wide/trio, so construct the structure payload + cross-bracket
 * pair lines by hand. Used to pin the FillGuide waku-grid render.
 */
function bracketBoxTicket(brackets: string[], unit = 100): Ticket {
  const lines: Ticket["lines"] = [];
  for (let i = 0; i < brackets.length; i++) {
    for (let j = i + 1; j < brackets.length; j++) {
      lines.push({
        combo: [brackets[i], brackets[j]],
        prob: 0.1,
        fairOdds: 10,
        payout: 1000,
        tag: "fair" as ValueTag,
      });
    }
  }
  return {
    id: "bracket-test",
    type: "bracket_quinella",
    lines,
    hitProb: 0.1,
    cost: lines.length * unit,
    expectedReturn: lines.length * 100,
    avgPayout: 1000,
    bestCaseReturn: 1000,
    core: brackets.slice(),
    tag: "fair" as ValueTag,
    unit,
    variance: "high",
    rationaleKeys: [],
    structure: "box",
    structurePayload: { set: brackets.slice() },
  };
}

describe("FillGuide — grid + summary", () => {
  beforeEach(() => setLang("en"));

  it("highlights exactly the ticket's set (no extras/missing)", () => {
    const ticket = buildBoxTicket("quinella", ["2", "4", "6"], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    // Cells 2, 4, 6 are "on"; 1, 3, 5, 7, 8 are not.
    const onCells =
      html.match(/<span[^>]*fillguide-cell on[^>]*>(\d+)<\/span>/g) || [];
    const onNums = onCells
      .map((c) => c.match(/>(\d+)</)!)
      .map((m) => m[1]);
    expect(onNums.sort()).toEqual(["2", "4", "6"]);
    // An off-cell for 1 must exist.
    expect(html).toMatch(/fillguide-cell[^>]*>1</);
  });

  it("renders the BOX badge when structure === 'box'", () => {
    const ticket = buildBoxTicket("wide", ["1", "2", "3"], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    expect(html).toContain("Wide");
    expect(html).toMatch(/fillguide-box-badge/);
    expect(html).toContain("BOX");
  });

  it("renders the point count (lines.length) and total (ticket.cost)", () => {
    const ticket = buildBoxTicket("trio", ["1", "2", "3", "4"], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    // Trio box of 4 → 4 lines; cost = 4 × 100 = ¥400.
    expect(ticket!.lines.length).toBe(4);
    expect(html).toContain(">4<");
    expect(html).toContain("¥400");
  });

  it("grid size follows the field's max umaban", () => {
    const ticket = buildBoxTicket("quinella", ["1", "2"], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    // 8 runners → cells 1..8.
    for (let i = 1; i <= 8; i++) {
      expect(html).toContain(`>${i}<`);
    }
    // No cell 9.
    expect(html).not.toMatch(/>9</);
  });
});

describe("FillGuide — ordered path (formation + wheel) via shared TicketLines", () => {
  beforeEach(() => setLang("en"));

  it("formation: header badge + TicketLines position columns + arrows (body badge suppressed)", () => {
    const S = ["1", "2", "3"];
    const ticket = buildFormationTicket("exacta", [S, S], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    // Header carries the bet type + the single structure badge — the body's
    // TicketLines badge is suppressed (badge={false}) so there's no duplicate.
    expect(html).toContain("Exacta");
    expect(html).toMatch(/fillguide-formation-badge/);
    expect(html).toContain("FORMATION");
    expect(html).not.toContain("tl-head");
    expect(html).not.toContain("tl-badge-form");
    // The ordered body is the shared TicketLines columns (NOT the box grid).
    expect(html).toContain("tl-cols");
    expect(html).not.toMatch(/fillguide-grid/);
    // Exacta = two position columns + one arrow.
    expect(countClass(html, "tl-col")).toBe(2);
    expect(countClass(html, "tl-arrow")).toBe(1);
    // Position labels render (1st, 2nd). No axis tag on a formation.
    expect(html).toContain("1st");
    expect(html).toContain("2nd");
    expect(html).not.toContain("tl-axis-tag");
  });

  it("wheel: header badge + TicketLines axis tag, axis + partners columns", () => {
    const ticket = buildWheelTicket(
      "trifecta",
      ["1"],
      ["2", "3", "4"],
      1,
      p,
      allUmas,
      100,
      "fg",
    );
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    expect(html).toContain("Trifecta");
    expect(html).toMatch(/fillguide-wheel-badge/);
    expect(html).toContain("WHEEL");
    expect(html).not.toContain("tl-badge-wheel"); // body badge suppressed
    // Axis tag on the anchored position (rendered by TicketLines).
    expect(html).toContain("tl-axis-tag");
    expect(html).toContain("axis");
    // TicketLines renders the wheel as TWO columns (axis + partners) + 1 arrow
    // (it collapses the k reconstructed slots into axis/partners).
    expect(countClass(html, "tl-col")).toBe(2);
    expect(countClass(html, "tl-arrow")).toBe(1);
  });
});

describe("FillGuide — 枠連 (bracket_quinella) waku grid", () => {
  beforeEach(() => setLang("en"));

  it("renders the fixed 1-8 waku grid with selected brackets colored (not the horse grid)", () => {
    const ticket = bracketBoxTicket(["3", "7", "8"]);
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket} runners={RUNNERS} unitStake={100} />,
    );
    expect(html).toMatch(/fillguide-box-badge/);
    expect(html).toContain("BOX");
    // The waku grid is the FIXED 1-8 (brackets), NOT 1..maxUmaban horses.
    expect((html.match(/fillguide-cell/g) || []).length).toBe(8);
    // Selected brackets carry their bracket-N color class.
    expect(html).toContain("fillguide-cell bracket-3");
    expect(html).toContain("fillguide-cell bracket-7");
    expect(html).toContain("fillguide-cell bracket-8");
    // An unselected bracket (1) is a plain cell, not colored "on" or bracket-N.
    expect(html).toContain('class="fillguide-cell"');
    expect(html).not.toContain("fillguide-cell on");
  });
});

describe("FillGuide — share gate (3b Part 4)", () => {
  beforeEach(() => setLang("en"));

  it("carries the [data-not-advice] micro-line so exportTicketCard's gate passes", () => {
    const ticket = buildBoxTicket("quinella", ["1", "2"], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    expect(html).toMatch(/data-not-advice/);
    // The not-advice text is the app-wide disclaimer.
    expect(html).toContain("Recreational research only");
  });

  it("renders the share button", () => {
    const ticket = buildBoxTicket("wide", ["1", "2", "3"], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    expect(html).toMatch(/fillguide-share/);
    expect(html).toContain("Share");
  });
});
