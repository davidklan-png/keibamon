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
import { winProbs, type Runner } from "../lib/fairvalue";
import {
  buildBoxTicket,
  buildFormationTicket,
  buildWheelTicket,
} from "../lib/recommender";
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

describe("FillGuide — ordered path (formation + wheel)", () => {
  beforeEach(() => setLang("en"));

  it("renders FORMATION badge + position columns with arrows for a formation ticket", () => {
    const S = ["1", "2", "3"];
    const ticket = buildFormationTicket("exacta", [S, S], p, allUmas, 100, "fg");
    expect(ticket).not.toBeNull();
    const html = renderToStaticMarkup(
      <FillGuide ticket={ticket!} runners={RUNNERS} unitStake={100} />,
    );
    expect(html).toContain("Exacta");
    expect(html).toMatch(/fillguide-formation-badge/);
    expect(html).toContain("FORMATION");
    // Ordered position columns present (NOT the flat grid).
    expect(html).toMatch(/fillguide-ordered/);
    expect(html).not.toMatch(/fillguide-grid/);
    // Two position columns + one directional arrow.
    expect(html).toMatch(/fillguide-pos-col/);
    expect(html).toMatch(/fillguide-arrow/);
    // Position labels render (1st, 2nd).
    expect(html).toContain("1st");
    expect(html).toContain("2nd");
    // No axis tag on a formation (axis is a wheel concept).
    expect(html).not.toMatch(/fillguide-pos-tag/);
  });

  it("renders WHEEL badge + axis tag on the anchored position for a wheel ticket", () => {
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
    // Axis tag marks the anchored position (1st).
    expect(html).toMatch(/fillguide-pos-tag/);
    expect(html).toContain("axis");
    // Three position columns (trifecta) + two arrows.
    const arrowCount = (html.match(/fillguide-arrow/g) || []).length;
    expect(arrowCount).toBe(2);
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
