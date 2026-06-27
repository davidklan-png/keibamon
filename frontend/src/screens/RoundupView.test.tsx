// ============================================================================
// RoundupView tests (ADR-0011 Phase 2 — inline contender drill-down).
//
// What this pins:
//   - Contender rows render inside an expanded deep-dive.
//   - A pre-seeded impression surfaces as a mark chip on the contender row
//     (the same vocabulary the live-card FormPanel uses).
//   - The lazy-fetch gate: collapsed contender rows never call fetchHorseForm;
//     expanding one mounts HorseDrillView which fetches exactly once.
//
// jsdom environment: contender rows are tappable buttons that mount
// HorseDrillView (whose fetch lives in useEffect), so the interaction tests
// need a real DOM + effect flush (act).
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { fetchHorseForm } from "../api";
import { RoundupView } from "./RoundupView";
import { setImpression } from "../lib/impressions";
import type { WeeklyReport } from "../lib/weeklyReport";

// Mock the api layer so HorseDrillView's mount-fetch is observable + controlled.
vi.mock("../api", () => ({
  fetchHorseForm: vi.fn(),
  fetchJockeyForm: vi.fn(),
  FormFetchError: class extends Error {},
}));

const fetchHorseFormMock = fetchHorseForm as unknown as ReturnType<typeof vi.fn>;

const RACE_ID = "2026-tokyo-g3";

function buildReport(): WeeklyReport {
  return {
    generator_version: "1.0.0",
    edition_key: "2026-W26",
    version: 1,
    edition_label: "Friday edition",
    weekend_label: "June 27–28, 2026",
    freshness: {
      published_at: "2026-06-26T20:00:00Z",
      odds_snapshot_at: null,
      gate_snapshot_at: null,
      card_snapshot_at: null,
      condition_snapshot_at: null,
      has_live_odds: false,
      has_gates: true,
      has_conditions: false,
    },
    glance: [],
    weekend_headline: "A graded-stakes weekend. Research framing, not a tip.",
    deep_dives: [
      {
        race_id: RACE_ID,
        name: "Test Stakes",
        name_ja: "テストステークス",
        grade: "G3",
        snapshot: {
          field_size: 12,
          post_time: "15:35",
          surface: "turf",
          distance_m: 2000,
          going: "good",
          weather: "cloudy",
          has_live_odds: false,
          has_gates: true,
        },
        why_this_race_matters: "Open G3 with a deep field.",
        market_shape: "Two favorites stand out.",
        gate_draw_impact: "Inside draws help.",
        pace_map: "Likely steady.",
        contender_groups: {
          core_contenders: [
            {
              horse_number: 1,
              horse_name: "Alpha Horse",
              win_odds: 3.2,
              gate: 1,
              reason: "Consistent form.",
            },
            {
              horse_number: 4,
              horse_name: "Beta Horse",
              win_odds: 5.6,
              gate: 4,
              reason: "Closing-type, fits the trip.",
            },
          ],
          price_horses: [],
          fragile_favorites: [],
          chaos_slots: [],
        },
        trend_analysis: ["Class drop in play."],
        ticket_notes: {
          safeish: { shape: "1-4", cost_window: "¥200–400", rationale: "Top pair.", risk: "Low." },
          balanced: { shape: "1-4-7", cost_window: "¥600", rationale: "Add a closer.", risk: "Medium." },
          spicy: { shape: "4-7-9", cost_window: "¥600", rationale: "Fade the favorite.", risk: "High." },
        },
      },
    ],
    weekend_themes: ["Class drops."],
    watchlist: [],
    ticket_lens: {
      best_for_safeish: null,
      best_for_balanced: null,
      best_for_longshot: null,
      most_fragile_favorite: null,
      best_to_simplify: null,
    },
    not_advice_reminder: "Research only, not betting advice.",
  };
}

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

function expandDeepDive(container: HTMLElement) {
  // The deep-dive toggle reveals the contender groups.
  const toggle = container.querySelector("button.deepdive-toggle") as HTMLButtonElement;
  expect(toggle, "deep-dive toggle rendered").toBeTruthy();
  act(() => toggle.click());
}

describe("RoundupView — inline contender drill-down", () => {
  beforeEach(() => {
    setLang("en");
    fetchHorseFormMock.mockReset();
    fetchHorseFormMock.mockReturnValue(new Promise(() => {})); // pending by default
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders contender rows inside an expanded deep-dive", () => {
    const report = buildReport();
    const { container } = render(
      <RoundupView
        report={report}
        impressions={{}}
        onSetImpressions={() => {}}
        oddsSnapshotAt={null}
      />,
    );
    expandDeepDive(container);
    expect(container.textContent).toContain("Alpha Horse");
    expect(container.textContent).toContain("Beta Horse");
  });

  it("surfaces a stored impression as a mark chip on the contender row", () => {
    const report = buildReport();
    // Pre-seed a "like" mark for Alpha Horse in this race.
    const store = setImpression({}, RACE_ID, "Alpha Horse", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 3.2,
      odds_snapshot_at: null,
    });
    const { container } = render(
      <RoundupView
        report={report}
        impressions={store}
        onSetImpressions={() => {}}
        oddsSnapshotAt={null}
      />,
    );
    expandDeepDive(container);
    // The mark chip renders with the Like label + the contender-mark-chip class.
    const chip = container.querySelector(".contender-mark-chip");
    expect(chip, "mark chip rendered").toBeTruthy();
    expect(chip!.textContent).toMatch(/like/i);
  });

  it("does NOT fetch contender forms while collapsed (lazy-fetch gate)", () => {
    const report = buildReport();
    const { container } = render(
      <RoundupView
        report={report}
        impressions={{}}
        onSetImpressions={() => {}}
        oddsSnapshotAt={null}
      />,
    );
    // Deep-dive collapsed → no contender HorseDrillView mounted → no fetch.
    // (2 contenders in core_contenders; expanding the deep-dive alone doesn't
    // expand any contender row.)
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(0);
    expandDeepDive(container);
    // Still 0: contender rows are visible but collapsed.
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(0);
  });

  it("fetches a contender's form exactly once when its row is expanded", () => {
    const report = buildReport();
    const { container } = render(
      <RoundupView
        report={report}
        impressions={{}}
        onSetImpressions={() => {}}
        oddsSnapshotAt={null}
      />,
    );
    expandDeepDive(container);
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(0);
    // Tap the first contender row to expand it (mount HorseDrillView).
    const contenderToggle = container.querySelector(
      "button.contender-toggle",
    ) as HTMLButtonElement;
    expect(contenderToggle, "contender toggle rendered").toBeTruthy();
    act(() => contenderToggle.click());
    // Mount = fetch exactly once.
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(1);
    expect(fetchHorseFormMock).toHaveBeenCalledWith("Alpha Horse", undefined);
    // Collapsing + re-expanding the same row mounts a fresh HorseDrillView
    // (fetches again). Just assert no spurious double-fetch from the single
    // expand action.
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(1);
  });
});
