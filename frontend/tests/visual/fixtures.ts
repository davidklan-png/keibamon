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

// ---------------------------------------------------------------------------
// Ticket-detail UX — structured-ticket fixtures for the per-mode visual
// snapshots (box / formation / wheel). Lines are GENERATED from the payload so
// counts + cost are genuine; prob math is irrelevant to the renderer (it reads
// structure + payload + lines.length + cost). All three reuse the open G1 race.
// ---------------------------------------------------------------------------
const STRUCT_TS = Date.parse("2026-06-21T13:00:00Z");
type FixtureLine = CommittedTicket["ticket"]["lines"][number];
function structLine(combo: string[]): FixtureLine {
  return { combo, prob: 0, fairOdds: 0, payout: 0, tag: "blend" };
}
/** k-permutations of arr (ordered box + wheel expansions). */
function permute(arr: string[], k: number): string[][] {
  const out: string[][] = [];
  const rec = (cur: string[], rest: string[]): void => {
    if (cur.length === k) {
      out.push(cur);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      rec([...cur, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  rec([], arr);
  return out;
}
/** Cartesian product of disjoint position sets (formation expansion — no
 *  repeat-filter needed when the sets are disjoint). */
function formationExpansion(positions: string[][]): string[][] {
  return positions.reduce<string[][]>(
    (acc, set) => acc.flatMap((prefix) => set.map((u) => [...prefix, u])),
    [[]],
  );
}

const STRUCT_UNIT = 100;
const BOX_SET = ["1", "2", "3", "4"]; // P(4,3) = 24 trifecta perms
const FORM_POSITIONS = [["1", "2"], ["3", "4"], ["5", "6"]]; // 2×2×2 = 8
const WHEEL_AXIS = ["1"];
const WHEEL_OPP = ["2", "3", "4"]; // P(3,2) = 6 partners over 2着/3着

function structuredTicket(p: {
  id: string;
  serial: string;
  type: CommittedTicket["ticket"]["type"];
  lines: string[][];
  structure: "box" | "formation" | "wheel";
  payload: NonNullable<CommittedTicket["ticket"]["structurePayload"]>;
  core: string[];
  mood: CommittedTicket["mood"];
  payoutBase: number;
}): CommittedTicket {
  return {
    id: p.id,
    serial: p.serial,
    ticket: {
      id: "rec-" + p.id,
      type: p.type,
      lines: p.lines.map(structLine),
      hitProb: 0,
      cost: p.lines.length * STRUCT_UNIT,
      expectedReturn: 0,
      avgPayout: p.payoutBase,
      bestCaseReturn: p.payoutBase,
      core: p.core,
      tag: "blend",
      unit: STRUCT_UNIT,
      variance: "high",
      rationaleKeys: [],
      structure: p.structure,
      structurePayload: p.payload,
      unitStake: STRUCT_UNIT,
    },
    unit: STRUCT_UNIT,
    mood: p.mood,
    state: "open",
    payoutBase: p.payoutBase,
    race: RACE_SNAPSHOT,
    owner: "you",
    claps: 0,
    createdAt: STRUCT_TS,
  };
}

/** Box / Formation / Wheel trifectas for the ticket-detail-UX mode snapshots. */
export const STRUCTURED_TICKETS: CommittedTicket[] = [
  structuredTicket({
    id: "kb-box-1",
    serial: "KB-BOX01",
    type: "trifecta",
    lines: permute(BOX_SET, 3),
    structure: "box",
    payload: { set: BOX_SET },
    core: BOX_SET,
    mood: "spicier",
    payoutBase: 18600,
  }),
  structuredTicket({
    id: "kb-form-1",
    serial: "KB-FORM1",
    type: "trifecta",
    lines: formationExpansion(FORM_POSITIONS),
    structure: "formation",
    payload: { positions: FORM_POSITIONS },
    core: ["1", "2", "3", "4", "5", "6"],
    mood: "balanced",
    payoutBase: 14200,
  }),
  structuredTicket({
    id: "kb-wheel-1",
    serial: "KB-WHL01",
    type: "trifecta",
    lines: permute(WHEEL_OPP, 2).map((tail) => [...WHEEL_AXIS, ...tail]),
    structure: "wheel",
    payload: { axis: WHEEL_AXIS, opponents: WHEEL_OPP, position: 1 },
    core: ["1", "2", "3", "4"],
    mood: "safer",
    payoutBase: 9800,
  }),
];

/**
 * ADR-0020 — a PUBLISHED weekend edition for the focused Japanese expanded-
 * Research visual snapshot. Realistic Japanese horse names + live odds + gates
 * + styles, so the JA report renders substantive market/pace/contender/trend/
 * ticket prose. edition_label + weekend_label are legacy English-only strings
 * on purpose, to exercise the JA structural fallback (date range + 土曜更新).
 * Override the empty /api/weekly-report mock per-test with this payload.
 */
export const FIXTURE_WEEKEND_PUBLISHED = {
  status: "published",
  inputs: [
    {
      edition_key: "2026-W26",
      edition_label: "Saturday refresh",
      weekend_label: "June 27–28, 2026",
      version: 2,
      published_at: "2026-06-27T00:30:00Z",
      odds_snapshot_at: "2026-06-27T00:15:00Z",
      gate_snapshot_at: "2026-06-26T08:00:00Z",
      card_snapshot_at: "2026-06-26T07:30:00Z",
      condition_snapshot_at: "2026-06-27T00:10:00Z",
      races: [
        {
          race_id: "jra-20260628-09-11",
          name: "Takarazuka Kinen",
          name_ja: "宝塚記念",
          grade: "G1",
          venue: "Hanshin",
          venue_ja: "阪神",
          surface: "turf",
          distance_m: 2200,
          post_time: "15:35",
          date: "2026-06-28",
          field_size: 8,
          going: "good",
          weather: "cloudy",
          runners: [
            { horse_number: 1, horse_name: "クロワデュノール", gate: 1, win_odds: 2.4, style_signal: "stalker" },
            { horse_number: 2, horse_name: "シンブリタニア", gate: 2, win_odds: 5.1, style_signal: "presser" },
            { horse_number: 3, horse_name: "ペガサスセイヤ", gate: 3, win_odds: 7.2, style_signal: "front" },
            { horse_number: 4, horse_name: "マイネルサファイア", gate: 4, win_odds: 12.0, style_signal: "closer" },
            { horse_number: 5, horse_name: "セキフ", gate: 5, win_odds: 18.5, style_signal: "stalker" },
            { horse_number: 6, horse_name: "ホウオウビスケー", gate: 6, win_odds: 6.3, style_signal: "presser", fragile: true },
            { horse_number: 7, horse_name: "ソーラーエイペックス", gate: 7, win_odds: 9.7, style_signal: "stalker", trend_signal: "firming" },
            { horse_number: 8, horse_name: "キタサンマジック", gate: 8, win_odds: 25.0, style_signal: "closer" },
          ],
        },
      ],
    },
  ],
};

/**
 * Registers page.route() handlers that intercept /api/live + social Worker
 * calls. Pass `tickets` to swap the feed/detail ticket set (used by the
 * ticket-detail-ux structured-mode snapshots); defaults to FIXTURE_TICKETS.
 */
export async function installApiMocks(
  page: import("@playwright/test").Page,
  tickets: CommittedTicket[] = FIXTURE_TICKETS,
): Promise<void> {
  // /api/live → deterministic open race
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
        body: JSON.stringify({ tickets }),
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
