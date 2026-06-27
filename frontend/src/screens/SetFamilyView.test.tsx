// ============================================================================
// SetFamilyView tests (ADR-0011 Phase 3a — Option A).
//
// What this pins:
//   - One row per set-family type (quinella, wide, trio); trio row omitted
//     when the set has < 3 horses.
//   - Row costs/point counts: quinella box of 5 → 10 pts; trio box of 4 → 4.
//   - 枠連 row omitted when any selected runner lacks a numeric gate; shown
//     when all selected runners carry a gate.
//   - Tapping a box row fires onSelectTicket with the structured ticket.
//
// jsdom: the tap-through test needs event dispatch; the render is otherwise
// presentational.
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { winProbs, type Runner } from "../lib/fairvalue";
import { SetFamilyView } from "./SetFamilyView";
import type { Ticket } from "../lib/types";

const RUNNERS_NO_GATE: Runner[] = [
  { uma: "1", odds: 2.4, name: "A" },
  { uma: "2", odds: 3.5, name: "B" },
  { uma: "3", odds: 6.2, name: "C" },
  { uma: "4", odds: 9.0, name: "D" },
  { uma: "5", odds: 18.5, name: "E" },
  { uma: "6", odds: 51.0, name: "F" },
  { uma: "7", odds: 8.5, name: "G" },
  { uma: "8", odds: 13.0, name: "H" },
];

const RUNNERS_WITH_GATE: Runner[] = RUNNERS_NO_GATE.map((r, i) => ({
  ...r,
  gate: (i % 4) + 1, // brackets 1-4 cycling
}));

const { p } = winProbs(RUNNERS_NO_GATE);
const allUmas = RUNNERS_NO_GATE.map((r) => r.uma);

function render(el: React.ReactElement): {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { container, root, unmount: () => act(() => root.unmount()) };
}

const BANNED = [/\bguaranteed\b/i, /\bsure thing\b/i, /\block\b/i, /\bbeat the market\b/i];

describe("SetFamilyView — rows + counts", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders quinella + wide rows (no trio) for a 2-horse set", () => {
    const { container } = render(
      <SetFamilyView
        set={["1", "2"]}
        runners={RUNNERS_NO_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const html = container.innerHTML;
    // Quinella + wide present; trio absent (needs ≥3).
    expect(html).toContain("Quinella");
    expect(html).toContain("Wide");
    expect(html).not.toContain(">Trio<");
    // 枠連 omitted (no gate).
    expect(html).not.toContain("Bracket quinella");
    // Each present pair-box row carries 1 pt (C(2,2)).
    const pts = container.querySelectorAll(".setfamily-points");
    expect(pts.length).toBeGreaterThanOrEqual(2);
  });

  it("quinella box of 5 shows 10 pts and the 10×unit cost", () => {
    const { container } = render(
      <SetFamilyView
        set={["1", "2", "3", "4", "5"]}
        runners={RUNNERS_NO_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    // Trio row present now (set ≥ 3).
    expect(container.innerHTML).toContain("Trio");
    const quinellaRow = Array.from(container.querySelectorAll(".setfamily-row")).find(
      (r) => r.textContent?.includes("Quinella"),
    );
    expect(quinellaRow).toBeTruthy();
    expect(quinellaRow!.textContent).toContain("10");
    // 10 pts × ¥100 = ¥1,000.
    expect(quinellaRow!.textContent).toContain("¥1,000");
  });

  it("trio box of 4 shows 4 pts", () => {
    const { container } = render(
      <SetFamilyView
        set={["1", "2", "3", "4"]}
        runners={RUNNERS_NO_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const trioRow = Array.from(container.querySelectorAll(".setfamily-row")).find(
      (r) => r.textContent?.includes("Trio"),
    );
    expect(trioRow).toBeTruthy();
    expect(trioRow!.textContent).toContain("4");
    expect(trioRow!.textContent).toContain("¥400");
  });
});

describe("SetFamilyView — 枠連 omit/present", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("omits the 枠連 row when runners lack a gate", () => {
    const { container } = render(
      <SetFamilyView
        set={["1", "2", "3"]}
        runners={RUNNERS_NO_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    expect(container.innerHTML).not.toContain("Bracket quinella");
  });

  it("shows the 枠連 row when all selected runners carry a gate", () => {
    // Select runners in distinct brackets → bracket row present, display-only.
    const { container } = render(
      <SetFamilyView
        set={["1", "3", "5"]}
        runners={RUNNERS_WITH_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    expect(container.innerHTML).toContain("Bracket quinella");
  });
});

describe("SetFamilyView — tap-through", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tapping a quinella box row fires onSelectTicket with a structured box ticket", () => {
    let captured: Ticket | null = null;
    const { container } = render(
      <SetFamilyView
        set={["1", "2", "3"]}
        runners={RUNNERS_NO_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
        onSelectTicket={(tk) => {
          captured = tk;
        }}
      />,
    );
    const quinellaRow = Array.from(container.querySelectorAll("button.setfamily-row")).find(
      (r) => r.textContent?.includes("Quinella"),
    ) as HTMLButtonElement | undefined;
    expect(quinellaRow).toBeTruthy();
    act(() => {
      quinellaRow!.click();
    });
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("quinella");
    expect(captured!.structure).toBe("box");
    expect((captured!.structurePayload as { set: string[] }).set).toEqual(["1", "2", "3"]);
  });

  it("contains no banned honesty words", () => {
    const { container } = render(
      <SetFamilyView
        set={["1", "2", "3", "4"]}
        runners={RUNNERS_WITH_GATE}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const html = container.innerHTML;
    for (const re of BANNED) expect(html).not.toMatch(re);
  });
});
