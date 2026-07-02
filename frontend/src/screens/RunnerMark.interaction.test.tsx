// ============================================================================
// RunnerMark interaction tests (ADR-0016).
//
// Companion to RunnerMark.test.tsx (presentational). These cover the write
// path — the part that matters most for correctness: a chip click MUST
// produce the same setImpression output HorseDrillView's IntuitionMarks
// would, with odds_when_marked sourced from the runner's current odds and
// odds_snapshot_at from the snapshot heartbeat.
//
// jsdom environment: chip clicks need event dispatch + state flush.
// ============================================================================
// @vitest-environment jsdom
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { RunnerMark, MARK_KINDS } from "./RunnerMark";
import {
  setImpression,
  type ImpressionMap,
} from "../lib/impressions";

// Freeze Date.now so the component's setImpression call and the expected
// value we build in the test produce byte-identical formed_at timestamps.
const NOW = 1_700_000_000_000;
let dateSpy: ReturnType<typeof vi.spyOn> | null = null;

interface MountOpts {
  raceId?: string;
  horseName?: string;
  umaban?: number;
  odds?: number | null;
  oddsSnapshotAt?: string | null;
  impressions?: ImpressionMap;
  isOpen?: boolean;
}

interface Harness {
  root: Root;
  container: HTMLElement;
  setProps: (next: Partial<MountOpts>) => void;
  setImpressions: (next: ImpressionMap) => void;
  captured: { impressions: ImpressionMap; openChange: (string | null)[] };
}

// The harness keeps the latest impression map + openChange calls so tests
// can assert what RunnerMark wrote through. setProps / setImpressions let
// a test re-render the component under controlled state.
function mount(opts: MountOpts = {}): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const captured: Harness["captured"] = {
    impressions: opts.impressions ?? {},
    openChange: [],
  };

  let state: MountOpts & { isOpen: boolean } = {
    raceId: opts.raceId ?? "race-1",
    horseName: opts.horseName ?? "Horse A",
    umaban: opts.umaban ?? 1,
    odds: opts.odds ?? null,
    oddsSnapshotAt: opts.oddsSnapshotAt ?? null,
    impressions: opts.impressions ?? {},
    isOpen: opts.isOpen ?? false,
  };

  function render() {
    act(() => {
      root.render(
        <RunnerMark
          raceId={state.raceId!}
          horseName={state.horseName!}
          umaban={state.umaban!}
          odds={state.odds ?? null}
          oddsSnapshotAt={state.oddsSnapshotAt ?? null}
          impressions={state.impressions!}
          onSetImpressions={(next) => {
            captured.impressions = next;
          }}
          isOpen={state.isOpen}
          onOpenChange={(next) => {
            captured.openChange.push(next);
            state.isOpen = next !== null;
            render();
          }}
        />,
      );
    });
  }

  render();

  return {
    root,
    container,
    captured,
    setProps: (next) => {
      state = { ...state, ...next };
      render();
    },
    setImpressions: (next) => {
      captured.impressions = next;
      state = { ...state, impressions: next };
      render();
    },
  };
}

function click(el: Element | null) {
  if (!el) throw new Error("click target not found");
  act(() => {
    el.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

describe("RunnerMark — chip clicks write through setImpression", () => {
  beforeEach(() => {
    setLang("en");
    dateSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    dateSpy?.mockRestore();
    dateSpy = null;
  });

  it("writes the chosen mark with the runner's odds + snapshot stamped", () => {
    const h = mount({
      odds: 5.4,
      oddsSnapshotAt: "2026-07-02T10:00:00Z",
      isOpen: true,
    });
    // Click the "like" chip (first in MARK_KINDS order).
    const chips = h.container.querySelectorAll("button.runner-mark-chip");
    expect(chips.length).toBe(MARK_KINDS.length); // no clear when unmarked
    click(chips[0]); // like

    const expected = setImpression({}, "race-1", "Horse A", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 5.4,
      odds_snapshot_at: "2026-07-02T10:00:00Z",
    });
    expect(h.captured.impressions).toEqual(expected);
  });

  it("passes odds_when_marked=null when runner odds are 0 (no market yet)", () => {
    const h = mount({ odds: 0, isOpen: true });
    const chips = h.container.querySelectorAll("button.runner-mark-chip");
    click(chips[0]); // like
    // normalizeName("Horse A") strips ALL whitespace → "HorseA" (no lowercasing).
    const stored = h.captured.impressions["race-1|HorseA"];
    expect(stored).toBeDefined();
    expect(stored.odds_when_marked).toBeNull();
  });

  it("passes odds_when_marked=null when odds prop is null", () => {
    const h = mount({ odds: null, isOpen: true });
    const chips = h.container.querySelectorAll("button.runner-mark-chip");
    click(chips[2]); // priceHorse
    const stored = h.captured.impressions["race-1|HorseA"];
    expect(stored.mark).toBe("priceHorse");
    expect(stored.odds_when_marked).toBeNull();
  });

  it("tapping the active chip clears the mark (writes mark=null)", () => {
    // Seed an active mark, open the strip, tap the active chip.
    const seed = setImpression({}, "race-1", "Horse A", {
      mark: "anchor",
      umaban: 1,
    });
    const h = mount({ impressions: seed, isOpen: true });
    // The anchor chip is the 5th in MARK_KINDS order; it's marked .on.
    const active = h.container.querySelector(
      "button.runner-mark-chip.on.runner-mark-anchor",
    );
    expect(active).not.toBeNull();
    click(active);
    // Cleared impressions = empty map (setImpression with mark=null deletes).
    expect(h.captured.impressions).toEqual({});
  });

  it("clear chip (when active) writes mark=null", () => {
    const seed = setImpression({}, "race-1", "Horse A", {
      mark: "like",
      umaban: 1,
    });
    const h = mount({ impressions: seed, isOpen: true });
    const clear = h.container.querySelector("button.runner-mark-clear");
    expect(clear).not.toBeNull();
    click(clear);
    expect(h.captured.impressions).toEqual({});
  });

  it("collapses the strip after a choose (onOpenChange fires with null)", () => {
    const h = mount({ isOpen: true });
    const chips = h.container.querySelectorAll("button.runner-mark-chip");
    click(chips[0]);
    // The strip auto-collapses: onOpenChange was called with null.
    expect(h.captured.openChange).toContain(null);
  });

  it("tapping the badge opens the strip (onOpenChange called with the uma)", () => {
    const h = mount({ umaban: 7, isOpen: false });
    const badge = h.container.querySelector("button.runner-mark-badge");
    click(badge);
    expect(h.captured.openChange).toContain("7");
  });

  it("tapping the badge when open collapses the strip", () => {
    const h = mount({ umaban: 7, isOpen: true });
    const badge = h.container.querySelector("button.runner-mark-badge");
    click(badge);
    expect(h.captured.openChange).toContain(null);
  });
});
