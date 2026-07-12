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

import { RaceScreen, gradeClass } from "./RaceScreen";
import type { LiveSnapshot } from "../api";
import type { Runner } from "../lib/fairvalue";
import { setImpression, type ImpressionMap } from "../lib/impressions";

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
      snapError=""
      selectedRaceDate="20260628"
      selectedRaceKey=""
      onApplyRace={() => {}}
      onStandard={() => {}}
      raceStatus="manual"
      raceId="test-race"
      impressions={{}}
      oddsSnapshotAt={null}
      onSetImpressions={() => {}}
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

describe("RaceScreen — grade badge", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("renders a grade-chip.grade-G3 for a graded race on the popular race-card", () => {
    const html = renderHtml();
    // Hakodate Kinen is grade_label "G3" → badge present with grade-G3 class.
    expect(html).toMatch(/grade-chip[^"]*grade-G3/);
    // The badge text is the canonical label.
    expect(html).toContain(">G3<");
  });

  it("renders a grade badge inside the all-races list too", () => {
    const html = renderHtml();
    // At least one race-row carries a grade-chip (the snapshot has 3 graded
    // G3 races + 1 ungraded result race).
    expect(html).toMatch(/race-row[\s\S]*grade-chip[\s\S]*grade-G3/);
  });

  it("does NOT render a grade-chip for an ungraded race", () => {
    const html = renderHtml();
    // RESULT_RACE has no grade_label. Its name must appear, but never inside
    // a grade-chip wrapper.
    expect(html).toContain("Sample Race");
    // Strip each grade-chip span and confirm "Sample Race" isn't inside one.
    const chips = html.match(/<span[^>]*grade-chip[^>]*>[\s\S]*?<\/span>/g) || [];
    for (const chip of chips) {
      expect(chip).not.toContain("Sample Race");
    }
  });
});

describe("gradeClass", () => {
  it("maps ASCII and roman forms to G1/G2/G3", () => {
    expect(gradeClass("G1")).toBe("G1");
    expect(gradeClass("G2")).toBe("G2");
    expect(gradeClass("G3")).toBe("G3");
    expect(gradeClass("GI")).toBe("G1");
    expect(gradeClass("GII")).toBe("G2");
    expect(gradeClass("GIII")).toBe("G3");
  });

  it("folds case, full-width, and surrounding whitespace", () => {
    expect(gradeClass("g1")).toBe("G1");
    expect(gradeClass(" G1 ")).toBe("G1");
    // Full-width G１ (U+FF27 U+FF11) folds under NFKC.
    expect(gradeClass("Ｇ１")).toBe("G1");
    // Roman numeral Ⅲ (U+2162) folds to "III" under NFKC.
    expect(gradeClass("GⅢ")).toBe("G3");
  });

  it("returns null for ungraded, empty, and dirt-Jpn grades", () => {
    expect(gradeClass("OP")).toBeNull();
    expect(gradeClass("Listed")).toBeNull();
    expect(gradeClass("")).toBeNull();
    expect(gradeClass(null)).toBeNull();
    expect(gradeClass(undefined)).toBeNull();
    // Dirt grades are a separate system — must not wear a turf-G badge.
    expect(gradeClass("JpnI")).toBeNull();
    expect(gradeClass("JpnII")).toBeNull();
    expect(gradeClass("JpnIII")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADR-0016: inline runner-row marks. The runner cell restructured from a
// single <button class="runner runner-tappable"> into a .runner-row wrapper
// holding (a) the SAME tappable button (opens drill, unchanged) + (b) a
// compact RunnerMark badge. The HTML constraint is real — interactive
// elements can't nest inside a <button>, so the mark control is a SIBLING.
//
// These tests pin:
//   - The .runner-row wrapper exists, and the tappable button is its child.
//   - The .runner-mark-badge is a sibling (not nested in the button).
//   - Marked runners carry a row-level highlight (has-mark / is-anchor).
//   - The drill-opening button click target stays the SAME className combo
//     (.runner.runner-tappable) — no behavior regression for users who
//     muscle-memorized tapping the row to open the form panel.
// ---------------------------------------------------------------------------
const RUNNERS: Runner[] = [
  { uma: "1", name: "Horse A", odds: 3.2 },
  { uma: "2", name: "Horse B", odds: 5.1 },
  { uma: "3", name: "Horse C", odds: 9.0 },
] as Runner[];

function renderRunnersHtml(impressions: ImpressionMap = {}) {
  return renderToStaticMarkup(
    <RaceScreen
      runners={RUNNERS}
      raceLabel=""
      snap={null}
      snapError=""
      selectedRaceDate=""
      selectedRaceKey=""
      onApplyRace={() => {}}
      onStandard={() => {}}
      raceStatus="manual"
      raceId="test-race"
      impressions={impressions}
      oddsSnapshotAt="2026-07-02T00:00:00Z"
      onSetImpressions={() => {}}
    />,
  );
}

describe("RaceScreen — ADR-0016 runner-row restructure", () => {
  beforeEach(() => setLang("en"));

  it("wraps each runner button in a .runner-row with a sibling .runner-mark-badge", () => {
    const html = renderRunnersHtml();
    // The wrapper exists once per runner (3 runners → 3 .runner-row).
    // Trailing whitespace inside the className string is tolerated.
    const rowCount = (html.match(/class="runner-row[^"]*"/g) || []).length;
    expect(rowCount).toBe(RUNNERS.length);
    // The tappable button keeps its className combo (drill-opener path intact).
    expect(html).toMatch(/class="runner runner-tappable[^"]*"/);
    // The mark badge sits OUTSIDE the button — assert no nested button.
    const buttonMatches = html.match(/<button[^>]*runner runner-tappable[^>]*>[\s\S]*?<\/button>/g) || [];
    for (const tag of buttonMatches) {
      // The runner button's content is the uma + name + odds — never a mark badge.
      expect(tag).not.toContain("runner-mark-badge");
    }
    // The mark badge is present in the document.
    expect(html).toContain("runner-mark-badge");
  });

  it("renders one RunnerMark badge per runner (collapsed by default)", () => {
    const html = renderRunnersHtml();
    // Trailing space inside the className is tolerated (template literal).
    const badgeCount = (html.match(/class="runner-mark-badge[^"]*"/g) || []).length;
    expect(badgeCount).toBe(RUNNERS.length);
    // Closed by default — no chip strip anywhere.
    expect(html).not.toContain("runner-mark-strip");
  });

  it("flags a marked runner's row with .has-mark, and an anchor row with .is-anchor", () => {
    const impressions: ImpressionMap = {
      ...setImpression({}, "test-race", "Horse A", { mark: "anchor", umaban: 1 }),
      ...setImpression({}, "test-race", "Horse B", { mark: "like", umaban: 2 }),
    };
    const html = renderRunnersHtml(impressions);
    // The anchor row carries both flags; the like row only has-mark.
    expect(html).toMatch(/class="runner-row is-anchor has-mark"/);
    expect(html).toMatch(/class="runner-row has-mark"/);
    // Unmarked Horse C row has neither flag.
    expect(html).toMatch(/class="runner-row"/);
  });

  it("keeps the tappable button's drill-opener behavior intact (className + aria-pressed)", () => {
    const html = renderRunnersHtml();
    // aria-pressed is the existing behavior; pin it so a future refactor
    // can't quietly drop the affordance. Trailing className space tolerated.
    expect(html).toMatch(/class="runner runner-tappable[^"]*"[^>]*aria-pressed=/);
  });
});
