// ============================================================================
// ManualTicketBuilder interaction tests (ticket-generation-alignment).
//
// Pins the three end-to-end edit scenarios at the component level:
//   1. Curated (non-full-box) ticket, opened + saved UNCHANGED → comes back
//      out with the SAME lines (re-priced), not a regenerated full box.
//   2. Same starting point, toggle one horse → locked→box transition fires
//      (banner swap) and Save yields a full box over the new picked set.
//   3. An already-full-box ticket opened for edit → no banner, behaves as
//      before (no lock).
//
// jsdom: tap-through needs event dispatch + React state flush.
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { winProbs, type Runner } from "../lib/fairvalue";
import { ManualTicketBuilder } from "./ManualTicketBuilder";
import type { ManualTicketInitial } from "./ManualTicketBuilder";
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
// Suppress unused `p` (kept to mirror the priced-market setup other suites use;
// the builder derives its own `p` from `runners` internally).
void p;

interface MountOpts {
  initial?: ManualTicketInitial;
}

function mount(opts: MountOpts = {}): {
  container: HTMLElement;
  root: Root;
  onRegister: ReturnType<typeof vi.fn>;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onRegister = vi.fn();
  act(() => {
    root.render(
      <ManualTicketBuilder
        runners={RUNNERS}
        unit={100}
        onUnitChange={vi.fn()}
        initial={opts.initial}
        onRegister={onRegister}
        onCancel={vi.fn()}
      />,
    );
  });
  return { container, root, onRegister, unmount: () => act(() => root.unmount()) };
}

/** Click the uma-grid cell carrying `uma`. Horse cells also show their odds. */
function clickCell(container: HTMLElement, uma: string): void {
  const cell = Array.from(container.querySelectorAll(".mt-manual-cell")).find(
    (b) => b.querySelector(".mt-manual-horse-num")?.textContent === uma,
  );
  expect(cell, `uma cell ${uma} should exist`).toBeTruthy();
  act(() => {
    (cell as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickType(container: HTMLElement, label: string): void {
  const btn = Array.from(container.querySelectorAll(".mt-manual-type")).find(
    (b) => b.textContent === label,
  );
  expect(btn, `bet type ${label} should exist`).toBeTruthy();
  act(() => {
    (btn as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickPositionCell(container: HTMLElement, positionIndex: number, uma: string): void {
  const positions = container.querySelectorAll(".mt-manual-position");
  expect(positions.length).toBeGreaterThan(positionIndex);
  const cell = Array.from(positions[positionIndex].querySelectorAll(".mt-manual-cell")).find(
    (b) => b.querySelector(".mt-manual-horse-num")?.textContent === uma,
  );
  expect(cell, `position ${positionIndex + 1} uma cell ${uma} should exist`).toBeTruthy();
  act(() => {
    (cell as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Click the primary CTA (the Save/Register button). */
function clickCta(container: HTMLElement): void {
  const cta = container.querySelector(".mt-cta") as HTMLElement | null;
  expect(cta, "CTA button should exist").toBeTruthy();
  act(() => {
    cta!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function sortedCombos(t: Ticket): string[] {
  return t.lines.map((l) => l.combo.slice().sort((a, b) => Number(a) - Number(b)).join("-")).sort();
}

describe("ManualTicketBuilder — locked/box edit mode", () => {
  beforeEach(() => setLang("en"));
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // A CURATED quinella: 3 lines over a 4-horse core {1,2,3,4}. A full quinella
  // box over 4 horses is C(4,2)=6, so 3 lines is a curated subset → locks.
  const CURATED: ManualTicketInitial = {
    id: "kb-curated",
    type: "quinella",
    unit: 100,
    lines: [
      ["1", "2"],
      ["3", "4"],
      ["1", "3"],
    ],
  };
  const curatedSorted = CURATED.lines!.map((c) => c.slice().sort((a, b) => Number(a) - Number(b)).join("-")).sort();

  it("shows the current win odds inside every horse-number selector", () => {
    const { container, unmount } = mount();
    const horse1 = Array.from(container.querySelectorAll(".mt-manual-horse")).find(
      (cell) => cell.querySelector(".mt-manual-horse-num")?.textContent === "1",
    );
    expect(horse1?.querySelector(".mt-manual-horse-odds")?.textContent).toBe("2.4×");
    const horse6 = Array.from(container.querySelectorAll(".mt-manual-horse")).find(
      (cell) => cell.querySelector(".mt-manual-horse-num")?.textContent === "6",
    );
    expect(horse6?.querySelector(".mt-manual-horse-odds")?.textContent).toBe("51.0×");
    unmount();
  });

  it("scenario 1 — open a curated ticket, change nothing, Save: identical lines", () => {
    const { container, onRegister } = mount({ initial: CURATED });

    // Locked hint is shown on mount.
    expect(container.querySelector("[data-mt-locked-hint]")).not.toBeNull();
    // Box note is NOT (we haven't touched anything).
    expect(container.querySelector("[data-mt-box-note]")).toBeNull();

    clickCta(container);

    expect(onRegister).toHaveBeenCalledTimes(1);
    const { ticket, id } = onRegister.mock.calls[0][0] as { ticket: Ticket; id?: string };
    expect(id).toBe("kb-curated");
    // Same 3 lines — NOT a regenerated 6-line full box over {1,2,3,4}.
    expect(ticket.lines).toHaveLength(3);
    expect(sortedCombos(ticket)).toEqual(curatedSorted);
    expect(ticket.cost).toBe(300); // 3 lines × ¥100, unchanged
  });

  it("scenario 2 — toggle a horse: locked→box transition + full box on Save", () => {
    const { container, onRegister } = mount({ initial: CURATED });

    // Starts locked.
    expect(container.querySelector("[data-mt-locked-hint]")).not.toBeNull();

    // Tapping horse 5 ends locked mode and rebuilds as a full box over
    // {1,2,3,4,5} = C(5,2) = 10 lines.
    clickCell(container, "5");

    // Banner swapped: locked hint gone, box note shown.
    expect(container.querySelector("[data-mt-locked-hint]")).toBeNull();
    expect(container.querySelector("[data-mt-box-note]")).not.toBeNull();

    clickCta(container);

    expect(onRegister).toHaveBeenCalledTimes(1);
    const { ticket } = onRegister.mock.calls[0][0] as { ticket: Ticket };
    // Full quinella box over 5 horses = 10 lines, not the original 3.
    expect(ticket.lines).toHaveLength(10);
    expect(ticket.cost).toBe(1000);
  });

  it("scenario 3 — an already-full-box ticket opens with no banner, no lock", () => {
    // Full quinella box over {1,2,3} = C(3,2) = 3 lines → isFullBox true →
    // never locks. Behaves exactly as before the alignment work.
    const fullBox: ManualTicketInitial = {
      id: "kb-fullbox",
      type: "quinella",
      unit: 100,
      lines: [
        ["1", "2"],
        ["1", "3"],
        ["2", "3"],
      ],
    };
    const { container, onRegister } = mount({ initial: fullBox });

    expect(container.querySelector("[data-mt-locked-hint]")).toBeNull();
    expect(container.querySelector("[data-mt-box-note]")).toBeNull();

    clickCta(container);

    expect(onRegister).toHaveBeenCalledTimes(1);
    const { ticket } = onRegister.mock.calls[0][0] as { ticket: Ticket };
    // Regenerating the full box over {1,2,3} yields the same 3 lines.
    expect(ticket.lines).toHaveLength(3);
    expect(sortedCombos(ticket)).toEqual(["1-2", "1-3", "2-3"]);
  });

  it("a brand-new ticket (no initial) never shows the locked hint", () => {
    const { container } = mount(); // no initial
    expect(container.querySelector("[data-mt-locked-hint]")).toBeNull();
    expect(container.querySelector("[data-mt-box-note]")).toBeNull();
  });

  it("builds a manual trifecta formation with separate 1st/2nd/3rd columns", () => {
    const { container, onRegister } = mount();

    clickType(container, "Trifecta");
    expect(container.querySelectorAll(".mt-manual-position")).toHaveLength(3);

    clickPositionCell(container, 0, "6");
    clickPositionCell(container, 1, "3");
    clickPositionCell(container, 1, "4");
    clickPositionCell(container, 2, "1");
    clickPositionCell(container, 2, "3");
    clickPositionCell(container, 2, "4");
    clickPositionCell(container, 2, "8");

    clickCta(container);

    expect(onRegister).toHaveBeenCalledTimes(1);
    const { ticket } = onRegister.mock.calls[0][0] as { ticket: Ticket };
    expect(ticket.type).toBe("trifecta");
    expect(ticket.structure).toBe("formation");
    expect(ticket.structurePayload).toEqual({
      positions: [["6"], ["3", "4"], ["1", "3", "4", "8"]],
    });
    expect(ticket.lines.map((l) => l.combo.join("-")).sort()).toEqual([
      "6-3-1",
      "6-3-4",
      "6-3-8",
      "6-4-1",
      "6-4-3",
      "6-4-8",
    ]);
    expect(ticket.cost).toBe(600);
  });

  it("reopens a saved formation with its position payload intact", () => {    const initial: ManualTicketInitial = {
      id: "kb-formation",
      type: "trifecta",
      unit: 100,
      structure: "formation",
      structurePayload: {
        positions: [["6"], ["3", "4"], ["1", "3", "4", "8"]],
      },
      lines: [
        ["6", "3", "1"],
        ["6", "3", "4"],
        ["6", "3", "8"],
        ["6", "4", "1"],
        ["6", "4", "3"],
        ["6", "4", "8"],
      ],
    };
    const { container, onRegister } = mount({ initial });

    expect(container.querySelectorAll(".mt-manual-position")).toHaveLength(3);
    clickCta(container);

    expect(onRegister).toHaveBeenCalledTimes(1);
    const { ticket, id } = onRegister.mock.calls[0][0] as { ticket: Ticket; id?: string };
    expect(id).toBe("kb-formation");
    expect(ticket.structure).toBe("formation");
    expect(ticket.structurePayload).toEqual(initial.structurePayload);
    expect(ticket.lines.map((l) => l.combo.join("-")).sort()).toEqual(
      initial.lines!.map((l) => l.join("-")).sort(),
    );
  });

  it("warns before a surprise-huge formation (≥50 lines)", () => {
    // Stage 6 guardrail: a full-field trifecta formation expands to many
    // priced lines; the builder must flag it before commit.
    const { container } = mount();
    clickType(container, "Trifecta");
    // Every horse in every position → 8P3 = 336 lines.
    for (const pos of [0, 1, 2]) {
      for (const u of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
        clickPositionCell(container, pos, u);
      }
    }
    expect(container.querySelector("[data-mt-big-warn]")).not.toBeNull();
  });

  it("does NOT show the box-rebuild note when a curated FORMATION unlocks", () => {
    // Stage 6: the "building a full box" note was wrong for an ordered
    // (formation) ticket. Unlocking a curated trifecta formation must NOT
    // show it — the rebuild is a formation, not a box.
    const initial: ManualTicketInitial = {
      id: "kb-curated-form",
      type: "trifecta",
      unit: 100,
      structure: "formation",
      structurePayload: { positions: [["6"], ["3", "4"], ["1", "3", "4", "8"]] },
      lines: [
        ["6", "3", "1"],
        ["6", "3", "4"],
        ["6", "3", "8"],
        ["6", "4", "1"],
        ["6", "4", "3"],
        ["6", "4", "8"],
      ],
    };
    const { container } = mount({ initial });
    expect(container.querySelector("[data-mt-locked-hint]")).not.toBeNull();
    // Toggle a position pick → unlocks (mode stays formation).
    clickPositionCell(container, 0, "5");
    expect(container.querySelector("[data-mt-locked-hint]")).toBeNull();
    expect(container.querySelector("[data-mt-box-note]")).toBeNull();
  });
});
