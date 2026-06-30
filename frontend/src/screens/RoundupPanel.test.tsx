// ============================================================================
// RoundupPanel tests (ADR-0015 — research lane moved INTO the Races shell).
//
// What this pins:
//   - Published edition: RoundupPanel renders <RoundupView> with an edition
//     <select> populated from the worker's inputs. The latest edition's label
//     shows in the option text.
//   - Empty state: RoundupPanel renders <EmptyRoundup> with the cadence
//     message + a fetch to /api/live for the upcoming graded stakes.
//
// The panel is a section-returning unit (no <main>/header/Footer) — it slots
// into the App browse shell. Both states share the parent's impression store;
// the marks→FormPanel read-back path is pinned by crossSurface.test.tsx.
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import {
  fetchWeeklyReport,
  fetchLiveSnapshot,
  type WeeklyReportResponse,
} from "../api";
import { RoundupPanel } from "./RoundupPanel";

vi.mock("../api", () => ({
  fetchWeeklyReport: vi.fn(),
  fetchLiveSnapshot: vi.fn(),
  // RoundupView pulls these on mount of an expanded contender row; keep them
  // as no-ops so the test never hits a real network.
  fetchHorseForm: vi.fn().mockReturnValue(new Promise(() => {})),
  fetchJockeyForm: vi.fn().mockReturnValue(new Promise(() => {})),
  FormFetchError: class extends Error {},
}));

const weeklyMock = fetchWeeklyReport as unknown as ReturnType<typeof vi.fn>;
const liveMock = fetchLiveSnapshot as unknown as ReturnType<typeof vi.fn>;

function render(el: React.ReactElement): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { container, unmount: () => act(() => root.unmount()) };
}

/** Minimal published payload whose single race generates a deterministic report. */
function publishedResponse(): WeeklyReportResponse {
  return {
    status: "published",
    inputs: [
      {
        edition_key: "2026-W26",
        edition_label: "Friday edition",
        weekend_label: "June 27–28, 2026",
        version: 1,
        published_at: "2026-06-26T20:00:00Z",
        odds_snapshot_at: null,
        gate_snapshot_at: null,
        card_snapshot_at: null,
        condition_snapshot_at: null,
        races: [
          {
            race_id: "2026-tokyo-g3-panel",
            name: "Panel Stakes",
            name_ja: "パネルステークス",
            grade: "G3",
            venue: "Tokyo",
            venue_ja: "東京",
            surface: "turf",
            distance_m: 2000,
            post_time: "15:35",
            date: "2026-06-28",
            runners: [
              { horse_number: 1, horse_name: "Alpha", gate: 1, win_odds: 3.2 },
              { horse_number: 4, horse_name: "Beta", gate: 4, win_odds: 5.6 },
            ],
          },
        ],
      },
    ],
  };
}

describe("RoundupPanel — published vs empty state (ADR-0015)", () => {
  beforeEach(() => {
    setLang("en");
    weeklyMock.mockReset();
    liveMock.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders RoundupView with an edition selector when /api/weekly-report is published", async () => {
    weeklyMock.mockResolvedValue(publishedResponse());
    const { container } = render(
      <RoundupPanel
        impressions={{}}
        onSetImpressions={() => {}}
        oddsSnapshotAt={null}
      />,
    );
    // Flush the fetch + state update.
    await act(async () => {
      await Promise.resolve();
    });
    // Edition selector populated with the published edition.
    const select = container.querySelector(
      ".edition-select select",
    ) as HTMLSelectElement | null;
    expect(select, "edition selector rendered").toBeTruthy();
    expect(select!.options.length).toBeGreaterThanOrEqual(1);
    // The option text is "<edition_label> · <weekend_label>".
    expect(select!.textContent).toContain("Friday edition");
    // EmptyRoundup is NOT rendered.
    expect(container.querySelector(".roundup-empty")).toBeNull();
  });

  it("renders EmptyRoundup when /api/weekly-report is empty", async () => {
    weeklyMock.mockResolvedValue({ status: "empty" } as WeeklyReportResponse);
    liveMock.mockResolvedValue({ races: [] });
    const { container } = render(
      <RoundupPanel
        impressions={{}}
        onSetImpressions={() => {}}
        oddsSnapshotAt={null}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // EmptyRoundup renders the empty-title + cadence message.
    expect(container.querySelector(".roundup-empty")).toBeTruthy();
    expect(container.textContent).toContain("No roundup published yet");
    // No edition selector in the empty state.
    expect(container.querySelector(".edition-select")).toBeNull();
  });
});
