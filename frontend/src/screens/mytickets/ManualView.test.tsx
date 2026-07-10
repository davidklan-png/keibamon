// @vitest-environment jsdom
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../../i18n";
import type { LiveRace } from "../../api";
import { mtRunnersOf } from "../../lib/mytickets-view";
import type { MtCtx } from "./ctx";
import { ManualView } from "./ManualView";

const raceA: LiveRace = {
  date: "20260712",
  venue: "Hanshin",
  race_no: 5,
  name: "Summer Mile",
  post_time: "13:15",
  runners: [
    { umaban: 1, name: "A", win_odds: 2.4 },
    { umaban: 2, name: "B", win_odds: 4.8 },
  ],
};
const raceB: LiveRace = {
  date: "20260712",
  venue: "Fukushima",
  race_no: 11,
  name: "Summer Stakes",
  post_time: "15:45",
  runners: [
    { umaban: 1, name: "C", win_odds: 7.1 },
    { umaban: 2, name: "D", win_odds: 12.6 },
  ],
};

function mount(): { container: HTMLElement; root: Root; commitManual: ReturnType<typeof vi.fn>; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const commitManual = vi.fn();
  const ctx = {
    t: (key: string) => key,
    tFmt: (key: string, values: Record<string, number>) => `${values.count} ${key}`,
    setView: vi.fn(),
    manualEditId: null,
    tickets: [],
    feature: raceA,
    races: [raceA, raceB],
    fallbackDate: "20260712",
    featRunners: mtRunnersOf(raceA),
    runnersForTicket: vi.fn(),
    unit: 200,
    setUnit: vi.fn(),
    commitManual,
  } as unknown as MtCtx;
  act(() => root.render(<ManualView ctx={ctx} />));
  return { container, root, commitManual, unmount: () => act(() => root.unmount()) };
}

describe("ManualView race selection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the selected race context and switches the builder to any available race", () => {
    setLang("en");
    const { container, commitManual, unmount } = mount();
    expect(container.textContent).toContain("Hanshin R5 · Summer Mile");

    const select = container.querySelector(".mt-manual-race-select select") as HTMLSelectElement;
    expect(select.options).toHaveLength(2);
    act(() => {
      select.value = "20260712|Fukushima|11|Summer Stakes";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("Fukushima R11 · Summer Stakes");
    const firstOdds = container.querySelector(".mt-manual-horse-odds");
    expect(firstOdds?.textContent).toBe("7.1×");

    for (const uma of ["1", "2"]) {
      const horse = Array.from(container.querySelectorAll(".mt-manual-horse")).find(
        (cell) => cell.querySelector(".mt-manual-horse-num")?.textContent === uma,
      ) as HTMLElement;
      act(() => horse.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    }
    const save = container.querySelector(".mt-cta") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    act(() => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(commitManual).toHaveBeenCalledWith(expect.anything(), undefined, raceB);
    unmount();
  });
});
