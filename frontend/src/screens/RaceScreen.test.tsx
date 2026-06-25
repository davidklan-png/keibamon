// ============================================================================
// RaceScreen presentational tests (race-first UX).
//
// What this pins:
//   - A registered race with 0 runners renders the "Entries Thu" chip and is
//     non-tappable (is-pending + disabled) instead of being filtered out.
//   - An open race with live odds renders the "odds open" label.
//   - A result race renders the "result" label.
//
// RaceScreen has no useEffect (only useState for the open-runner form panel,
// which stays closed here), so renderToStaticMarkup exercises the race-card
// rendering without jsdom or a live fetch.
// ============================================================================
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";

// FormPanel imports ../api (fetchers) at the top; it never renders in these
// tests (no runner is tapped) but the import still resolves. Stub it to keep
// the test focused on RaceScreen's own output.
vi.mock("./FormPanel", () => ({
  FormPanel: () => React.createElement("div", { "data-testid": "form-panel-stub" }),
}));

import { RaceScreen } from "./RaceScreen";
import type { LiveSnapshot } from "../api";

const OPEN_RACE = {
  date: "20260628",
  race_no: 11,
  name: "Hakodate Kinen",
  grade_label: "G3",
  venue: "Hakodate",
  post_time: "15:35",
  status: "open" as const,
  runners: [
    { umaban: 1, name: "Horse A", win_odds: 3.2, odds_is_live: true },
    { umaban: 2, name: "Horse B", win_odds: 5.1, odds_is_live: true },
    { umaban: 3, name: "Horse C", win_odds: 9.0, odds_is_live: true },
  ],
};

const REGISTERED_ZERO_RUNNERS = {
  date: "20260628",
  race_no: 9,
  name: "Radio NIKKEI Sho",
  grade_label: "G3",
  venue: "Fukushima",
  post_time: "15:10",
  status: "registered" as const,
  runners: [],
};

const RESULT_RACE = {
  date: "20260628",
  race_no: 5,
  name: "Sample Race",
  venue: "Hakodate",
  status: "result" as const,
  runners: [
    { umaban: 1, name: "Horse A", win_odds: 2.4 },
    { umaban: 2, name: "Horse B", win_odds: 6.0 },
  ],
};

const SNAP: LiveSnapshot = {
  meta: { date: "20260628" },
  races: [OPEN_RACE, REGISTERED_ZERO_RUNNERS, RESULT_RACE],
};

function renderHtml() {
  return renderToStaticMarkup(
    <RaceScreen
      runners={[]}
      raceLabel=""
      snap={SNAP}
      snapLoading={false}
      snapError=""
      selectedRaceDate="20260628"
      selectedRaceKey=""
      onReload={() => {}}
      onSeedManual={() => {}}
      onApplyRace={() => {}}
      onStandard={() => {}}
      onRefine={() => {}}
      raceStatus="manual"
      intuition={{}}
      onIntuition={() => {}}
    />,
  );
}

describe("RaceScreen — registered-races-visible", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("renders the 'Entries Thu' chip for a 0-runner registered race", () => {
    const html = renderHtml();
    expect(html).toContain("Entries Thu");
    // The registered race's name is visible (not filtered out).
    expect(html).toContain("Radio NIKKEI Sho");
  });

  it("marks the 0-runner card as non-tappable (is-pending + disabled)", () => {
    const html = renderHtml();
    // A disabled button serializes its disabled attribute.
    expect(html).toMatch(/is-pending/);
    expect(html).toMatch(/disabled=""/);
  });

  it("renders the 'odds open' label and runner count for a live race", () => {
    const html = renderHtml();
    expect(html).toContain("odds open");
    expect(html).toContain("Hakodate Kinen");
    // Runner count surfaces for a race with runners.
    expect(html).toContain("3 runners");
  });

  it("renders the 'result' label for a settled race", () => {
    const html = renderHtml();
    expect(html).toContain("result");
  });

  it("does not collapse to 'No live card available' when only registered races exist", () => {
    // Sanity for the bug: a card with 0-runner registered races still shows
    // the card list, not the empty state.
    expect(renderHtml()).not.toMatch(/No live card available/i);
  });
});
