// ============================================================================
// MyTicketsEmpty tests (Session 2 UX refactor — honest signed-out empty state).
//
// What this pins:
//   - The heading + body copy render (the i18n keys resolve, not raw keys).
//   - The marks-teaser has TWO variants:
//       * has-marks → "{n} horses across {m} races" with N/M computed from the
//         impression map (distinct horses / distinct races).
//       * zero-marks → the gentler variant with NO fabricated numbers.
//   - The inline Sign-in control is wired to openSignIn() (the same Clerk modal
//     the header account slot opens).
//   - summarizeMarks counts distinct horses + distinct races correctly.
//   - Both EN and JA copy resolve to non-empty strings (bilingual gate).
//
// jsdom environment: the Sign-in tap test needs a real DOM + click dispatch.
// useAuth() is mocked so the test supplies a spy openSignIn without standing up
// Clerk or AuthProvider.
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import type { ImpressionMap, Impression } from "../lib/impressions";

// Mock the auth context so the empty state reads a spyable openSignIn without
// dragging Clerk / AuthProvider into the test. The component only uses
// openSignIn from useAuth().
const openSignIn = vi.fn();
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ openSignIn }),
}));

import { MyTicketsEmpty, summarizeMarks } from "./MyTicketsEmpty";

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

function mark(umaban: number): Impression {
  return {
    mark: "like",
    umaban,
    odds_when_marked: null,
    odds_snapshot_at: null,
    formed_at: 0,
  };
}

// Two races: race "r1" has two marked horses, race "r2" has one. So N=3, M=2.
const MARKS: ImpressionMap = {
  "r1|horsea": mark(1),
  "r1|horseb": mark(2),
  "r2|horsec": mark(3),
};

describe("summarizeMarks", () => {
  it("counts distinct horses (N) and distinct races (M)", () => {
    expect(summarizeMarks(MARKS)).toEqual({ horses: 3, races: 2 });
  });

  it("returns zeros for an empty map", () => {
    expect(summarizeMarks({})).toEqual({ horses: 0, races: 0 });
  });

  it("counts a single race with one mark as 1 horse / 1 race", () => {
    expect(summarizeMarks({ "r1|horsea": mark(1) })).toEqual({
      horses: 1,
      races: 1,
    });
  });
});

describe("MyTicketsEmpty", () => {
  beforeEach(() => {
    setLang("en");
    openSignIn.mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the heading and body copy", () => {
    const { container, unmount } = render(<MyTicketsEmpty impressions={{}} />);
    expect(container.querySelector(".mt-empty-title")?.textContent).toBe(
      en.mineEmpty.title,
    );
    expect(container.querySelector(".mt-empty-body")?.textContent).toBe(
      en.mineEmpty.body,
    );
    unmount();
  });

  it("shows the has-marks teaser with N horses across M races", () => {
    const { container, unmount } = render(
      <MyTicketsEmpty impressions={MARKS} />,
    );
    const teaser = container.querySelector(".mt-empty-teaser")?.textContent ?? "";
    expect(teaser).toContain("3 horses");
    expect(teaser).toContain("2 races");
    // No leftover interpolation placeholders.
    expect(teaser).not.toContain("{n}");
    expect(teaser).not.toContain("{m}");
    unmount();
  });

  it("shows the gentler zero-marks teaser with no fabricated numbers", () => {
    const { container, unmount } = render(<MyTicketsEmpty impressions={{}} />);
    const teaser = container.querySelector(".mt-empty-teaser")?.textContent ?? "";
    expect(teaser).toBe(en.mineEmpty.teaserEmpty);
    // Gentle variant must not invent a count.
    expect(teaser).not.toMatch(/\d/);
    unmount();
  });

  it("wires the Sign-in control to openSignIn()", () => {
    const { container, unmount } = render(<MyTicketsEmpty impressions={{}} />);
    const cta = container.querySelector(".mt-empty-cta") as HTMLButtonElement;
    expect(cta).toBeTruthy();
    expect(cta.textContent).toBe(en.mineEmpty.signIn);
    act(() => cta.click());
    expect(openSignIn).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("renders JA copy when the language is Japanese", () => {
    setLang("ja");
    const { container, unmount } = render(<MyTicketsEmpty impressions={MARKS} />);
    expect(container.querySelector(".mt-empty-title")?.textContent).toBe(
      ja.mineEmpty.title,
    );
    const teaser = container.querySelector(".mt-empty-teaser")?.textContent ?? "";
    expect(teaser).toContain("3頭");
    expect(teaser).toContain("2レース");
    unmount();
  });

  it("mineEmpty keys exist and are non-empty in both EN and JA", () => {
    for (const dict of [en, ja]) {
      for (const k of [
        "title",
        "body",
        "teaser",
        "teaserEmpty",
        "signIn",
      ] as const) {
        expect(typeof dict.mineEmpty[k]).toBe("string");
        expect(dict.mineEmpty[k].length).toBeGreaterThan(0);
      }
    }
  });
});
