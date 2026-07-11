// ============================================================================
// BottomTabBar tests (Session 1 UX refactor — persistent thumb-zone nav).
//
// What this pins:
//   - The bar renders exactly THREE destination tabs (Races / My Tickets /
//     Reference), mapped onto App's `view` enum.
//   - The active tab reflects the current `view` (aria-current="page" + .on).
//   - Tapping a tab calls onNavigate with that tab's view id — the switch the
//     App wires to setView.
//   - Both EN and JA tab labels resolve to non-empty strings (bilingual gate).
//
// jsdom environment: the tap test needs a real DOM + click dispatch (act).
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { BottomTabBar, type TabView } from "./BottomTabBar";

function render(el: React.ReactElement): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("BottomTabBar", () => {
  beforeEach(() => {
    setLang("en");
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders exactly four destination tabs", () => {
    const { container, unmount } = render(
      <BottomTabBar view="browse" onNavigate={() => {}} />,
    );
    const buttons = container.querySelectorAll(".bottom-tabbar button");
    expect(buttons.length).toBe(4);
    const labels = Array.from(buttons).map((b) => b.textContent);
    expect(labels).toEqual(["Races", "Tickets", "Friends", "Reference"]);
    unmount();
  });

  it("marks the tab matching the current view as active", () => {
    const { container, unmount } = render(
      <BottomTabBar view="mine" onNavigate={() => {}} />,
    );
    const active = container.querySelector(
      ".bottom-tabbar button.on",
    ) as HTMLButtonElement;
    expect(active).toBeTruthy();
    expect(active.getAttribute("aria-current")).toBe("page");
    // The "mine" view maps to the Tickets tab (second of three).
    expect(active.textContent).toBe("Tickets");
    unmount();
  });

  it("switches view: tapping a tab calls onNavigate with its view id", () => {
    const onNavigate = vi.fn();
    const { container, unmount } = render(
      <BottomTabBar view="browse" onNavigate={onNavigate} />,
    );
    const buttons = Array.from(
      container.querySelectorAll(".bottom-tabbar button"),
    ) as HTMLButtonElement[];
    // Tap Tickets (mine), Friends, Reference, then Races (browse).
    act(() => buttons[1].click());
    act(() => buttons[2].click());
    act(() => buttons[3].click());
    act(() => buttons[0].click());
    const calls = onNavigate.mock.calls.map((c) => c[0] as TabView);
    expect(calls).toEqual(["mine", "friends", "reference", "browse"]);
    unmount();
  });

  it("renders bilingual labels (JA)", () => {
    setLang("ja");
    const html = renderToStaticMarkup(
      <BottomTabBar view="browse" onNavigate={() => {}} />,
    );
    expect(html).toContain(ja.tabs.races);
    expect(html).toContain(ja.tabs.tickets);
    expect(html).toContain(ja.tabs.friends);
    expect(html).toContain(ja.tabs.reference);
  });

  it("tab labels exist and are non-empty in both EN and JA", () => {
    for (const dict of [en, ja]) {
      for (const k of ["races", "tickets", "friends", "reference"] as const) {
        expect(typeof dict.tabs[k]).toBe("string");
        expect(dict.tabs[k].length).toBeGreaterThan(0);
      }
    }
  });
});
