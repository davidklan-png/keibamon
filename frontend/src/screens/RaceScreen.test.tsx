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

// Thursday roster capture (2026-06-25): a race whose entries are declared
// but whose live odds pool hasn't opened. The snapshot.py contract keeps
// status='registered' until any runner has odds_is_live=true. The card must
// be OPENABLE (the user can tap to see the roster + jockey labels), and the
// race-meta must surface the runner count (not the "Entries pending" chip).
const REGISTERED_WITH_ROSTER = {
  date: "20260628",
  race_no: 11,
  name: "Hakodate Kinen (pre-market)",
  grade_label: "G3",
  venue: "Hakodate",
  post_time: "15:35",
  status: "registered" as const,
  runners: [
    { umaban: 1, name: "Horse A", win_odds: null, odds_is_live: false, jockey_id: "01096", jockey_name: "Ono" },
    { umaban: 2, name: "Horse B", win_odds: null, odds_is_live: false, jockey_id: "01115", jockey_name: "Hamanaka" },
  ],
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
  races: [OPEN_RACE, REGISTERED_ZERO_RUNNERS, RESULT_RACE, REGISTERED_WITH_ROSTER],
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

  it("renders the 'Entries pending' chip (weekday-free) for a 0-runner registered race", () => {
    const html = renderHtml();
    // P1.1: weekday-free copy — never a wrong day name.
    expect(html).toContain("Entries pending");
    // No hardcoded weekday anywhere in the snapshot-driven UI.
    expect(html).not.toMatch(/Entries (Thu|Fri|Sat|Sun|Mon|Tue|Wed)\b/);
    // The registered race's name is visible (not filtered out).
    expect(html).toContain("Radio NIKKEI Sho");
  });

  it("keeps the 0-runner card visually pending (is-pending) but OPENABLE (no disabled)", () => {
    const html = renderHtml();
    // P1.2: the card stays visually gray via is-pending ...
    expect(html).toMatch(/is-pending/);
    // ... but it's no longer a dead tile: the disabled attribute must NOT
    // serialize on any race-card / race-row. (assert per-class so we don't
    // false-match the unrelated date-chip / btn disabled states.)
    const cardMatches = html.match(/<button[^>]*race-card[^>]*>/g) || [];
    const rowMatches = html.match(/<button[^>]*race-row[^>]*>/g) || [];
    const allCards = [...cardMatches, ...rowMatches];
    expect(allCards.length).toBeGreaterThan(0);
    for (const tag of allCards) {
      expect(tag).not.toMatch(/disabled=""/);
    }
  });

  it("renders runner count (not 'Entries pending') when a registered race has a declared roster", () => {
    // Thursday roster capture: status='registered' but runners are present.
    // The card surfaces the count and stays tappable; the "Entries pending"
    // chip is reserved for the 0-runner case only.
    const html = renderHtml();
    expect(html).toContain("Hakodate Kinen (pre-market)");
    // 2 declared runners → runner-count copy, NOT the entries-pending chip.
    expect(html).toContain("2 runners");
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
