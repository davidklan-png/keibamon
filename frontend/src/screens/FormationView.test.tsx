// ============================================================================
// FormationView tests (ADR-0011 Phase 3b — Option A, ordered family).
//
// What this pins:
//   - One row per ordered formation type (exacta, trifecta); quinella/wide/trio
//     NEVER appear (those belong to SetFamilyView).
//   - Point counts: exacta formation of N → P(N,2); trifecta → P(N,3).
//   - Cost = points × unitStake.
//   - Directional arrows between position columns.
//   - Tapping a row fires onSelectTicket with a structured formation ticket.
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
import { FormationView } from "./FormationView";
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

describe("FormationView — rows + counts", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders exacta + trifecta rows for a 3-horse set; no quinella/wide/trio", () => {
    const { container } = render(
      <FormationView
        set={["1", "2", "3"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain("Exacta");
    expect(html).toContain("Trifecta");
    // Unordered types never appear here.
    expect(html).not.toContain(">Quinella<");
    expect(html).not.toContain(">Wide<");
    expect(html).not.toContain(">Trio<");
  });

  it("exacta formation of 4 → P(4,2)=12 pts; cost ¥1,200", () => {
    const { container } = render(
      <FormationView
        set={["1", "2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const exactaRow = Array.from(container.querySelectorAll(".formation-row")).find(
      (r) => r.textContent?.includes("Exacta"),
    );
    expect(exactaRow).toBeTruthy();
    expect(exactaRow!.textContent).toContain("12");
    expect(exactaRow!.textContent).toContain("¥1,200");
  });

  it("trifecta formation of 4 → P(4,3)=24 pts; cost ¥2,400", () => {
    const { container } = render(
      <FormationView
        set={["1", "2", "3", "4"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    const trifectaRow = Array.from(container.querySelectorAll(".formation-row")).find(
      (r) => r.textContent?.includes("Trifecta"),
    );
    expect(trifectaRow).toBeTruthy();
    expect(trifectaRow!.textContent).toContain("24");
    expect(trifectaRow!.textContent).toContain("¥2,400");
  });

  it("directional arrows render between position columns", () => {
    const { container } = render(
      <FormationView
        set={["1", "2", "3"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
      />,
    );
    // Trifecta row has 2 arrows (3 positions → 2 connectors).
    const trifectaRow = Array.from(container.querySelectorAll(".formation-row")).find(
      (r) => r.textContent?.includes("Trifecta"),
    );
    expect(trifectaRow).toBeTruthy();
    const arrows = trifectaRow!.querySelectorAll(".formation-arrow");
    expect(arrows.length).toBe(2);
  });
});

describe("FormationView — tap-through + guardrail", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("tapping an exacta row fires onSelectTicket with a structured formation ticket", () => {
    let captured: Ticket | null = null;
    const { container } = render(
      <FormationView
        set={["1", "2", "3"]}
        runners={RUNNERS}
        p={p}
        allUmas={allUmas}
        unitStake={100}
        onSelectTicket={(tk) => {
          captured = tk;
        }}
      />,
    );
    const exactaRow = Array.from(container.querySelectorAll("button.formation-row")).find(
      (r) => r.textContent?.includes("Exacta"),
    ) as HTMLButtonElement | undefined;
    expect(exactaRow).toBeTruthy();
    act(() => {
      exactaRow!.click();
    });
    expect(captured).not.toBeNull();
    expect(captured!.type).toBe("exacta");
    expect(captured!.structure).toBe("formation");
  });

  it("contains no banned honesty words", () => {
    const { container } = render(
      <FormationView
        set={["1", "2", "3", "4"]}
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
