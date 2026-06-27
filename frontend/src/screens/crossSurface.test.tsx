// ============================================================================
// Cross-surface integration test (ADR-0011 Phase 2).
//
// What this pins:
//   A mark made via the Roundup contender drill-down is read back by the
//   live-card FormPanel (RaceScreen's embed) when both surfaces share the
//   same impression store + raceId + horse name. The drift chip renders on
//   the FormPanel side when its currentOdds differs from the Roundup-time
//   odds_when_marked.
//
// This is the "unified research surface" contract: the same (race_id,
// horse_key) store entry underlies both lanes, so research-side marks flow
// into the ticket-builder and vice versa.
//
// jsdom environment: both surfaces mount HorseDrillView (useEffect fetch).
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import { fetchHorseForm, fetchJockeyForm } from "../api";
import { RoundupView } from "./RoundupView";
import { FormPanel } from "./FormPanel";
import type { ImpressionMap } from "../lib/impressions";
import type { WeeklyReport } from "../lib/weeklyReport";

vi.mock("../api", () => ({
  fetchHorseForm: vi.fn(),
  fetchJockeyForm: vi.fn(),
  FormFetchError: class extends Error {},
}));

const fetchHorseFormMock = fetchHorseForm as unknown as ReturnType<typeof vi.fn>;
const fetchJockeyFormMock = fetchJockeyForm as unknown as ReturnType<typeof vi.fn>;

const RACE_ID = "2026-tokyo-g3-cross";
const HORSE_NAME = "Cross Surface Star";

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
    weekend_headline: "Cross-surface fixture.",
    deep_dives: [
      {
        race_id: RACE_ID,
        name: "Cross Stakes",
        name_ja: "クロスステークス",
        grade: "G3",
        snapshot: {
          field_size: 10,
          post_time: "15:35",
          surface: "turf",
          distance_m: 2000,
          going: "good",
          weather: "fine",
          has_live_odds: false,
          has_gates: true,
        },
        why_this_race_matters: "Fixture race.",
        market_shape: "Even field.",
        gate_draw_impact: "Neutral.",
        pace_map: "Steady.",
        contender_groups: {
          core_contenders: [
            {
              horse_number: 5,
              horse_name: HORSE_NAME,
              win_odds: 6.0,
              gate: 5,
              reason: "Fits the trip.",
            },
          ],
          price_horses: [],
          fragile_favorites: [],
          chaos_slots: [],
        },
        trend_analysis: [],
        ticket_notes: {
          safeish: { shape: "5", cost_window: "¥100", rationale: "r", risk: "low" },
          balanced: { shape: "5", cost_window: "¥100", rationale: "r", risk: "low" },
          spicy: { shape: "5", cost_window: "¥100", rationale: "r", risk: "high" },
        },
      },
    ],
    weekend_themes: [],
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

describe("cross-surface: Roundup mark → FormPanel read-back", () => {
  beforeEach(() => {
    setLang("en");
    fetchHorseFormMock.mockReset();
    fetchJockeyFormMock.mockReset();
    // Resolve quickly so HorseContent renders the marks block.
    fetchHorseFormMock.mockResolvedValue({
      status: "ok",
      horse_name: HORSE_NAME,
      career: { starts: 8, wins: 2, top3: 5, win_pct: 0.25, top3_pct: 0.62 },
    });
    fetchJockeyFormMock.mockResolvedValue({ status: "no_history" });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("a mark made on the Roundup contender row is read back by the FormPanel embed", async () => {
    const report = buildReport();
    let store: ImpressionMap = {};

    // --- Lane A: Roundup contender drill-down ---
    const roundupContainer = document.createElement("div");
    document.body.appendChild(roundupContainer);
    const roundupRoot = createRoot(roundupContainer);
    act(() => {
      roundupRoot.render(
        <RoundupView
          report={report}
          impressions={store}
          onSetImpressions={(next) => {
            store = next;
          }}
          oddsSnapshotAt="2026-06-26T20:00:00Z"
        />,
      );
    });
    // Expand the deep-dive, then expand the contender row.
    const deepToggle = roundupContainer.querySelector(
      "button.deepdive-toggle",
    ) as HTMLButtonElement;
    act(() => deepToggle.click());
    const contenderToggle = roundupContainer.querySelector(
      "button.contender-toggle",
    ) as HTMLButtonElement;
    act(() => contenderToggle.click());
    // Flush the form fetch so HorseContent (with the marks row) renders.
    await act(async () => {
      await Promise.resolve();
    });
    // Tap "Anchor" on the Roundup-side HorseDrillView.
    const marks = roundupContainer.querySelectorAll("button.intuition-mark");
    const anchorBtn = Array.from(marks).find(
      (b) => b.textContent === "Anchor",
    ) as HTMLButtonElement | undefined;
    expect(anchorBtn, "Anchor mark rendered on Roundup side").toBeTruthy();
    act(() => anchorBtn!.click());

    // The store now carries the mark, keyed on (RACE_ID, normalized HORSE_NAME).
    const entries = Object.entries(store);
    expect(entries.length).toBe(1);
    const [key, impression] = entries[0];
    expect(key.startsWith(`${RACE_ID}|`)).toBe(true);
    expect(impression.mark).toBe("anchor");
    expect(impression.odds_when_marked).toBe(6.0); // contender's win_odds

    // Unmount the Roundup side.
    act(() => roundupRoot.unmount());

    // --- Lane B: FormPanel (RaceScreen's embed) with the SAME store ---
    const fpContainer = document.createElement("div");
    document.body.appendChild(fpContainer);
    const fpRoot = createRoot(fpContainer);
    act(() => {
      fpRoot.render(
        <FormPanel
          raceId={RACE_ID}
          horse={{ umaban: 5, name: HORSE_NAME }}
          currentOdds={3.4} // drifted shorter from 6.0
          impressions={store}
          onSetImpressions={() => {}}
          oddsSnapshotAt="2026-06-27T10:00:00Z"
          onClose={() => {}}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The "Anchor" mark reads back: its button wears the .on class.
    const fpAnchor = fpContainer.querySelector("button.intuition-mark.on");
    expect(fpAnchor, "Anchor mark read back on the FormPanel side").toBeTruthy();
    expect(fpAnchor!.textContent).toMatch(/anchor/i);

    // Drift chip renders: marked at 6.0, now 3.4 → shorter (▲).
    const drift = fpContainer.querySelector(".drift-chip");
    expect(drift, "drift chip renders across surfaces").toBeTruthy();
    expect(drift!.textContent).toContain("6.0");
    expect(drift!.textContent).toContain("3.4");
    expect(drift!.textContent).toContain("▲"); // shorter

    act(() => fpRoot.unmount());
  });
});
