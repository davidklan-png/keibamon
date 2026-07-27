// ============================================================================
// useFeedScrollRestore — direction-aware feed scroll restoration contract.
//
// jsdom has no real layout, so this pins the CONTRACT (the scrollTo calls the
// hook makes), not pixels:
//   - first mount on the feed is a no-op (don't fight browser restoration)
//   - forward feed → sub-view: jump to top
//   - return sub-view → feed: restore the offset captured when the feed left
//   - sub-view → sub-view: forward (top), and does NOT clobber the saved offset
//   - restore clamps to the current document height if the feed shrank
//   - a second leave/re-enter captures the NEW offset, not a stale one
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { useFeedScrollRestore } from "./useFeedScrollRestore";
import type { MtView } from "../../lib/mytickets-view";

function Harness({ view }: { view: MtView }) {
  useFeedScrollRestore(view);
  return null;
}

describe("useFeedScrollRestore", () => {
  let container: HTMLElement;
  let root: Root;
  let scrollTo: ReturnType<typeof vi.fn>;
  let scrollYVal: number;
  let scrollHeightVal: number;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    scrollTo = vi.fn();
    scrollYVal = 0;
    scrollHeightVal = 100_000; // tall doc — clamping rarely binds by default

    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      writable: true,
      value: scrollTo,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      get: () => scrollYVal,
      set: (v: number) => {
        scrollYVal = v;
      },
    });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      get: () => scrollHeightVal,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      get: () => 800,
    });
    // rAF runs its callback synchronously so the deferred restore fires
    // within act(); the timing itself is not under test here.
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      },
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: () => {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  function render(view: MtView) {
    act(() => {
      root.render(<Harness view={view} />);
    });
  }

  /** Simulate the user scrolling the feed to `y` (fires the capture listener). */
  function userScrollsTo(y: number) {
    scrollYVal = y;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  }

  it("first mount on the feed is a no-op (doesn't fight browser restoration)", () => {
    render("feed");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("forward feed → detail jumps to top", () => {
    render("feed");
    userScrollsTo(500);
    render("detail");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("returning feed → detail → feed restores the captured offset", () => {
    render("feed");
    userScrollsTo(500);
    render("detail"); // snapshot 500, jump to top
    scrollTo.mockClear();
    render("feed"); // restore
    expect(scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("sub-view → sub-view (detail → profile) is forward: top, and does NOT clobber the saved feed offset", () => {
    render("feed");
    userScrollsTo(500);
    render("detail");
    scrollTo.mockClear();
    render("profile"); // forward move: top, saved offset preserved
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockClear();
    render("feed"); // restore must still be the original 500, not clobbered
    expect(scrollTo).toHaveBeenCalledWith(0, 500);
  });

  it("clamps the restore when the feed shrank while away (ticket deleted/settled)", () => {
    render("feed");
    userScrollsTo(5000);
    render("detail");
    // The feed is now much shorter: 1500 tall, 800 viewport → max scroll 700.
    scrollHeightVal = 1500;
    scrollTo.mockClear();
    render("feed");
    expect(scrollTo).toHaveBeenCalledWith(0, 700); // 5000 clamped to 1500 - 800
  });

  it("a second leave/re-enter captures the NEW feed offset, not the stale one", () => {
    render("feed");
    userScrollsTo(500);
    render("detail");
    render("feed"); // restore 500
    userScrollsTo(200); // user scrolled somewhere else in the feed
    render("detail");
    scrollTo.mockClear();
    render("feed");
    expect(scrollTo).toHaveBeenCalledWith(0, 200);
  });
});
