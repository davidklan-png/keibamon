// ============================================================================
// Fixture: deterministic /api/live + /api/social responses for visual
// regression. Captures the shapes src/api.ts and src/auth/socialClient.ts
// expect. One open G1 race with 8 runners + a handful of committed tickets
// across open/won/miss states so feed/detail renders real content.
// ============================================================================
import type { LiveSnapshot } from "../../src/api";
import type { CommittedTicket } from "../../src/lib/types";

const RACE_RUNNERS = [
  { umaban: 1, name: "Croix du Nord", win_odds: 2.4, odds_is_live: true },
  { umaban: 2, name: "Shin Tsubaki", win_odds: 11.6, odds_is_live: true },
  { umaban: 3, name: "Pegasus Seiya", win_odds: 7.2, odds_is_live: true },
  { umaban: 4, name: "Meiner Sapphire", win_odds: 18.8, odds_is_live: true },
  { umaban: 5, name: "Sekifu", win_odds: 23.9, odds_is_live: true },
  { umaban: 6, name: "Ho O Biscay", win_odds: 5.1, odds_is_live: true },
  { umaban: 7, name: "Solar Apex", win_odds: 9.7, odds_is_live: true },
  { umaban: 8, name: "Kitasan Magic", win_odds: 14.3, odds_is_live: true },
];

const RACE_KEY = "20260621|Tokyo|11|Tokyo Takarazuka (G1)";

/** The fixture snapshot: one race at Tokyo, R11, open. */
export const FIXTURE_SNAPSHOT: LiveSnapshot = {
  meta: {
    status: "ok",
    updated_at: "2026-06-21T13:00:00+09:00",
    date: "20260621",
  },
  races: [
    {
      date: "20260621",
      race_no: 11,
      race_id: "jra-20260621-05-11",
      name: "Tokyo Takarazuka (G1)",
      grade_label: "G1",
      post_time: "15:40",
      venue: "Tokyo",
      // #14 — surface/distance_m so the RaceContextBar's surf-dist segment
      // is exercised in visual baselines. Without these, every baseline shows
      // the segment omitted and a formatter regression would pass CI. Going
      // is still prop-only-optional on LiveRace (not on the type yet), so we
      // don't set it here.
      surface: "turf",
      distance_m: 2000,
      status: "open",
      runners: RACE_RUNNERS,
    },
  ],
};

const RUNNERS_SNAPSHOT = RACE_RUNNERS.map((r) => ({
  num: r.umaban,
  en: r.name ?? "",
  ja: r.name ?? "",
  odds: r.win_odds ?? 0,
}));

const RACE_SNAPSHOT = {
  raceKey: RACE_KEY,
  grade: "G1",
  nameEn: "Tokyo Takarazuka (G1)",
  nameJa: "東京宝塚（G1）",
  venueEn: "Tokyo",
  venueJa: "東京",
  raceNo: 11,
  dateEn: "Jun 21, Sat",
  dateJa: "6月21日（土）",
  post: "15:40",
  runners: RUNNERS_SNAPSHOT,
};

/** A small set of tickets across the committed states. */
export const FIXTURE_TICKETS: CommittedTicket[] = [
  {
    id: "kb-open-1",
    serial: "KB-7F2A91",
    ticket: {
      id: "rec-open",
      type: "quinella",
      lines: [
        { combo: ["1", "6"], prob: 0.18, fairOdds: 5.5, payout: 1100, tag: "chalk" },
      ],
      hitProb: 0.18,
      cost: 200,
      expectedReturn: 198,
      avgPayout: 1100,
      core: ["1", "6"],
      tag: "chalk",
      unit: 200,
      variance: "low",
      rationaleKeys: [],
    },
    unit: 200,
    mood: "safer",
    state: "open",
    payoutBase: 1100,
    race: RACE_SNAPSHOT,
    owner: "you",
    claps: 0,
    createdAt: Date.parse("2026-06-21T13:00:00Z"),
  },
  {
    id: "kb-won-1",
    serial: "KB-9A15D7",
    ticket: {
      id: "rec-won",
      type: "win",
      lines: [
        { combo: ["1"], prob: 0.42, fairOdds: 2.4, payout: 480, tag: "chalk" },
      ],
      hitProb: 0.42,
      cost: 300,
      expectedReturn: 402,
      avgPayout: 480,
      core: ["1"],
      tag: "chalk",
      unit: 300,
      variance: "low",
      rationaleKeys: [],
    },
    unit: 300,
    mood: "safer",
    state: "won",
    payoutBase: 480,
    returned: 7200,
    race: RACE_SNAPSHOT,
    owner: { en: "Rin", ja: "リン", color: "#FF6A6A", initial: "R", initialJa: "リ" },
    claps: 41,
    cheers: 41,
    createdAt: Date.parse("2026-06-20T13:00:00Z"),
  },
];

/** Registers page.route() handlers that intercept /api/live + social Worker calls. */
export async function installApiMocks(page: import("@playwright/test").Page): Promise<void> {
  // /api/live → deterministic open race
  await page.route("**/api/live", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FIXTURE_SNAPSHOT),
    }),
  );
  // /api/weekly-report → empty. ADR-0015: RoundupPanel now renders inline on
  // the Races Research lane, and the visual baseline for that surface must be
  // the deterministic EmptyRoundup state. Without this mock, the panel would
  // hit whatever the dev server's D1 happens to carry (published edition or
  // not), making the research-mode baseline flake. Pinned to empty so the
  // capture shows the cadence message + the fixture's G1 as an upcoming
  // graded stake — the same honest empty state users see on a non-race-week
  // browser.
  await page.route("**/api/weekly-report", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "empty" }),
    }),
  );
  // Social Worker calls — return deterministic shapes for visual regression.
  await page.route("**/api/social/**", (route) => {
    const url = route.request().url();
    if (url.includes("/tickets")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tickets: FIXTURE_TICKETS }),
      });
    }
    if (url.includes("/me")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "playwright-fake-user", handle: "playwright" }),
      });
    }
    if (url.includes("/friends/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ count: 0, avatars: [] }),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}
