// ============================================================================
// WheelView tests (ADR-0011 Phase 3b — Option A, wheel family).
//
// What this pins:
//   - One row per ordered wheel type (exacta, trifecta); the axis is pinned to
//     1着 (the JRA 軸1頭流し pattern).
//   - Point counts: exacta wheel (1 axis, N opponents) → N pts; trifecta →
//     P(N,2) pts.
//   - Cost = points × unitStake.
//   - Axis tag + axis column styling distinguish the anchor from opponents.
//   - Tapping a row fires onSelectTicket with a structured wheel ticket.
//   - Guardrail: no banned honesty phrases.
//
// jsdom: the tap-through test needs event dispatch.
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { winProbs, type Runner } from "../lib/fairvalue";
import { WheelView } from "./WheelView";
import type { Ticket } from "../lib/types";

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

describe("WheelView — rows + counts", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders exacta + trifecta wheel rows for 1 axis + 3 opponents", () => {
    const { container } = render(
      <WheelView
        axis="1"
        opponents={["2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain("Exacta");
    expect(html).toContain("Trifecta");
  });

  it("exacta wheel (1 axis, 3 opponents) → 3 pts; cost ¥300", () => {
    const { container } = render(
      <WheelView
        axis="1"
        opponents={["2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const exactaRow = Array.from(container.querySelectorAll(".wheel-row")).find(
      (r) => r.textContent?.includes("Exacta"),
    );
    expect(exactaRow).toBeTruthy();
    expect(exactaRow!.textContent).toContain("3");
    expect(exactaRow!.textContent).toContain("¥300");
  });

  it("trifecta wheel (1 axis, 3 opponents) → P(3,2)=6 pts; cost ¥600", () => {
    const { container } = render(
      <WheelView
        axis="1"
        opponents={["2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const trifectaRow = Array.from(container.querySelectorAll(".wheel-row")).find(
      (r) => r.textContent?.includes("Trifecta"),
    );
    expect(trifectaRow).toBeTruthy();
    expect(trifectaRow!.textContent).toContain("6");
    expect(trifectaRow!.textContent).toContain("¥600");
  });

  it("axis column carries the axis tag + axis styling", () => {
    const { container } = render(
      <WheelView
        axis="1"
        opponents={["2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const html = container.innerHTML;
    // The axis tag (軸/axis label) renders on the anchored column.
    expect(html).toMatch(/wheel-pos-tag/);
    expect(html).toContain("axis");
    // The axis column has the turf accent border.
    expect(html).toMatch(/wheel-pos-axis/);
  });
});

describe("WheelView — tap-through + guardrail", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tapping a trifecta row fires onSelectTicket with a structured wheel ticket", () => {
    let captured: Ticket | null = null;
    const { container } = render(
      <WheelView
        axis="1"
        opponents={["2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
        onSelectTicket={(tk) => {
          captured = tk;
        }}
      />,
    );
    const trifectaRow = Array.from(container.querySelectorAll("button.wheel-row")).find(
      (r) => r.textContent?.includes("Trifecta"),
    ) as HTMLButtonElement | undefined;
    expect(trifectaRow).toBeTruthy();
    act(() => {
      trifectaRow!.click();
    });
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("trifecta");
    expect(captured!.structure).toBe("wheel");
  });

  it("contains no banned honesty words", () => {
    const { container } = render(
      <WheelView
        axis="1"
        opponents={["2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const html = container.innerHTML;
    for (const re of BANNED) expect(html).not.toMatch(re);
  });
});
