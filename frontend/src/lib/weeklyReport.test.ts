import { describe, it, expect } from "vitest";
import {
  generateReport,
  deterministicNarrative,
  GENERATOR_VERSION,
  deviggedProbs,
  effectiveOdds,
  marketShape,
  topByOdds,
  type NarrativeProvider,
  type WeekendInput,
  type RaceInput,
} from "./weeklyReport";
import { BANNED_PHRASES as BANNED } from "./guardrails";
import { SAMPLE_FRIDAY, SAMPLE_SATURDAY } from "../data/sampleWeekend";

// ---------------------------------------------------------------------------
// Editorial guardrails — enforced against EVERY string the generator emits.
// The banned-phrase list is the shared runtime list (lib/guardrails.ts); this
// build-time scan and the runtime sanitizer can never drift apart because they
// read the same constant. Sample data cannot slip a banned word through.
// ---------------------------------------------------------------------------

function reportStrings(report: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(report);
  return out;
}

// Friday = gates drawn + estimates only; Saturday = live odds + trend signals.
const fridayInput: WeekendInput = SAMPLE_FRIDAY;
const saturdayInput: WeekendInput = SAMPLE_SATURDAY;

// ---------------------------------------------------------------------------

describe("weeklyReport.generateReport — structure & generation", () => {
  const fri = generateReport(fridayInput);

  it("produces a report for every graded race, G1 first", () => {
    expect(fri.deep_dives.length).toBe(3);
    expect(fri.deep_dives.map((d) => d.grade)).toEqual(["G1", "G2", "G3"]);
    expect(fri.glance.length).toBe(3);
  });

  it("fills every required deep-dive field (no empty strings)", () => {
    for (const d of fri.deep_dives) {
      expect(d.why_this_race_matters.length).toBeGreaterThan(0);
      expect(d.market_shape.length).toBeGreaterThan(0);
      expect(d.gate_draw_impact.length).toBeGreaterThan(0);
      expect(d.pace_map.length).toBeGreaterThan(0);
      expect(d.trend_analysis.length).toBeGreaterThan(0);
      expect(d.contender_groups).toBeTruthy();
      for (const key of ["safeish", "balanced", "spicy"] as const) {
        const n = d.ticket_notes[key];
        expect(n.shape.length).toBeGreaterThan(0);
        expect(n.rationale.length).toBeGreaterThan(0);
        expect(n.risk.length).toBeGreaterThan(0);
      }
    }
  });

  it("emits a weekend headline, themes, watchlist, and ticket lens", () => {
    expect(fri.weekend_headline.length).toBeGreaterThan(0);
    expect(fri.weekend_themes.length).toBeGreaterThan(0);
    expect(fri.not_advice_reminder.length).toBeGreaterThan(0);
    expect(fri.ticket_lens.best_for_safeish).not.toBeNull();
    expect(fri.ticket_lens.best_for_balanced).not.toBeNull();
    expect(fri.ticket_lens.best_for_longshot).not.toBeNull();
    expect(fri.ticket_lens.best_to_simplify).not.toBeNull();
  });

  it("carries the not-betting-advice reminder", () => {
    expect(fri.not_advice_reminder.toLowerCase()).toMatch(/not betting advice/);
  });

  it("stamps the generator version (PIT reproducibility key)", () => {
    // The archive stores raw WeekendInput and regenerates client-side, so a
    // future generator change would retroactively alter old editions' wording.
    // generator_version lets a reader tell a real data change from a generator
    // change. Must be present and match the exported constant.
    expect(fri.generator_version).toBe(GENERATOR_VERSION);
    expect(fri.generator_version.length).toBeGreaterThan(0);
    // Saturday edition stamps the same version (constant, not per-edition).
    expect(generateReport(saturdayInput).generator_version).toBe(GENERATOR_VERSION);
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — runtime narrative sanitization (provider guardrail)", () => {
  // A hostile / careless non-deterministic provider that injects banned phrases.
  // generateReport MUST route every provider return value through the runtime
  // sanitizer, so this never reaches the rendered report.
  const malicious: NarrativeProvider = {
    weekendHeadline: () =>
      "This is the best bet — a guaranteed lock that will beat the market.",
    raceWhy: () => "A positive EV sure thing; run an automated wager.",
    themes: () => [
      "Top pick is a guaranteed best bet.",
      "Steady pool, no edge claim needed.",
    ],
  };

  it("scrubs banned phrases from a non-deterministic provider's output", () => {
    const rep = generateReport(saturdayInput, { provider: malicious });
    // No banned phrase survives anywhere in the generated report.
    const offenders: string[] = [];
    for (const s of reportStrings(rep)) {
      for (const re of BANNED) {
        if (re.test(s)) offenders.push(`${re}  ⇐  ${s}`);
      }
    }
    expect(offenders).toEqual([]);
    // And the substitutes actually landed (sanitizer rewrote, not dropped).
    expect(rep.weekend_headline).toMatch(/top selection|projected|frontrunner/i);
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — missing odds / gates handling", () => {
  it("uses estimates + flags when live odds are absent (Friday)", () => {
    const fri = generateReport(fridayInput);
    expect(fri.freshness.has_live_odds).toBe(false);
    expect(fri.freshness.odds_snapshot_at).toBeNull();
    // Market shape still renders from estimates, labeled clearly.
    for (const d of fri.deep_dives) {
      expect(d.snapshot.has_live_odds).toBe(false);
      expect(d.market_shape.length).toBeGreaterThan(0);
    }
  });

  it("reports gates-pending when no draws are published", () => {
    const input: WeekendInput = {
      ...fridayInput,
      gate_snapshot_at: null,
      races: fridayInput.races.map((r) => ({
        ...r,
        runners: r.runners.map((rn) => ({ ...rn, gate: null })),
      })),
    };
    const rep = generateReport(input);
    expect(rep.freshness.has_gates).toBe(false);
    for (const d of rep.deep_dives) {
      expect(d.gate_draw_impact).toMatch(/draw not yet published|draw pending/i);
    }
  });

  it("flags data completeness honestly when conditions are missing", () => {
    const rep = generateReport(fridayInput); // Friday: no going/weather
    expect(rep.freshness.has_conditions).toBe(false);
    expect(rep.freshness.condition_snapshot_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — Friday publish vs Saturday refresh (versioning)", () => {
  const fri = generateReport(fridayInput);
  const sat = generateReport(saturdayInput);

  it("advances the version number between editions", () => {
    expect(fri.version).toBe(1);
    expect(sat.version).toBe(2);
    expect(sat.version).toBeGreaterThan(fri.version);
  });

  it("shares the same edition_key across versions (archive grouping)", () => {
    expect(fri.edition_key).toBe(sat.edition_key);
  });

  it("reflects the new data: Saturday has live odds, Friday did not", () => {
    expect(fri.freshness.has_live_odds).toBe(false);
    expect(sat.freshness.has_live_odds).toBe(true);
    expect(sat.freshness.odds_snapshot_at).not.toBeNull();
  });

  it("builds a watchlist only once trend signals arrive (Saturday)", () => {
    expect(fri.watchlist.length).toBe(0);
    expect(sat.watchlist.length).toBeGreaterThan(0);
    // Ordering: firming before drifting before steady.
    const order: Record<string, number> = { firming: 0, drifting: 1, steady: 2, unknown: 3 };
    const signals = sat.watchlist.map((w) => w.signal);
    const sorted = [...signals].sort((a, b) => order[a] - order[b]);
    expect(signals).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — snapshot timestamp preservation (PIT)", () => {
  const rep = generateReport(saturdayInput);

  it("carries every snapshot timestamp through verbatim", () => {
    const f = rep.freshness;
    expect(f.published_at).toBe(saturdayInput.published_at);
    expect(f.odds_snapshot_at).toBe(saturdayInput.odds_snapshot_at);
    expect(f.gate_snapshot_at).toBe(saturdayInput.gate_snapshot_at);
    expect(f.card_snapshot_at).toBe(saturdayInput.card_snapshot_at);
    expect(f.condition_snapshot_at).toBe(saturdayInput.condition_snapshot_at);
  });

  it("published_at never drifts forward of the data snapshots it frames", () => {
    // The publication instant must be >= every snapshot it reports (a report
    // can't be published before its odds snapshot existed).
    const pub = Date.parse(rep.freshness.published_at);
    for (const ts of [
      rep.freshness.odds_snapshot_at,
      rep.freshness.gate_snapshot_at,
      rep.freshness.card_snapshot_at,
      rep.freshness.condition_snapshot_at,
    ]) {
      if (ts != null) expect(pub).toBeGreaterThanOrEqual(Date.parse(ts));
    }
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — language guardrails (no betting-advice phrasing)", () => {
  const saturday = generateReport(saturdayInput);
  // Stress every string across BOTH editions.
  const allStrings = [
    ...reportStrings(generateReport(fridayInput)),
    ...reportStrings(saturday),
  ];

  it("emits no banned edge/advice phrases across the whole report", () => {
    const offenders: string[] = [];
    for (const s of allStrings) {
      for (const re of BANNED) {
        if (re.test(s)) offenders.push(`${re}  ⇐  ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ticket notes describe structure + risk, never instruct a wager", () => {
    for (const d of saturday.deep_dives) {
      for (const note of Object.values(d.ticket_notes)) {
        // Forbidden instructional verbs.
        expect(note.shape).not.toMatch(/\b(place|bet|wager)\b/i);
        expect(note.rationale).not.toMatch(/\b(place|bet|wager)\b/i);
        // Required risk acknowledgement.
        expect(note.risk.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses the analytical framing vocabulary the glossary teaches", () => {
    const blob = allStrings.join("  ").toLowerCase();
    expect(blob).toMatch(/market signal|market shape/);
    expect(blob).toMatch(/fragile/);
    expect(blob).toMatch(/variance/);
    expect(blob).toMatch(/draw|gate/);
    expect(blob).toMatch(/takeout/);
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — determinism", () => {
  it("same input + default provider → byte-identical output", () => {
    const a = generateReport(saturdayInput);
    const b = generateReport(saturdayInput);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("explicit deterministic provider matches the default path", () => {
    const a = generateReport(saturdayInput);
    const b = generateReport(saturdayInput, { provider: deterministicNarrative });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------

describe("weeklyReport — pure helpers", () => {
  it("effectiveOdds falls back to estimate then null", () => {
    expect(
      effectiveOdds({ horse_number: 1, horse_name: "x", gate: 1, win_odds: 3.0 }),
    ).toBe(3.0);
    expect(
      effectiveOdds({
        horse_number: 1,
        horse_name: "x",
        gate: 1,
        win_odds: null,
        win_odds_est: 5.5,
      }),
    ).toBe(5.5);
    expect(
      effectiveOdds({
        horse_number: 1,
        horse_name: "x",
        gate: 1,
        win_odds: null,
        win_odds_est: null,
      }),
    ).toBeNull();
  });

  it("deviggedProbs sum to ~1 across the priced set", () => {
    const runners = SAMPLE_SATURDAY.races[0].runners;
    const probs = deviggedProbs(runners);
    const sum = [...probs.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
    // Favorite carries the largest share.
    const fav = topByOdds(runners)[0];
    const biggest = Math.max(...probs.values());
    expect(probs.get(fav.horse_number)).toBeCloseTo(biggest, 5);
  });

  it("marketShape handles a fully unpriced race without throwing", () => {
    const r: RaceInput = {
      race_id: "x",
      name: "Unpriced",
      grade: "G3",
      venue: "X",
      surface: "turf",
      distance_m: 1600,
      post_time: "10:00",
      date: "2026-06-28",
      runners: [
        { horse_number: 1, horse_name: "a", gate: null, win_odds: null },
        { horse_number: 2, horse_name: "b", gate: null, win_odds: null },
      ],
    };
    const s = marketShape(r);
    expect(s.top3_concentration).toBe(0);
    expect(s.label.toLowerCase()).toMatch(/estimate|not yet priced/);
  });

  it("ignores a degenerate empty weekend cleanly", () => {
    const rep = generateReport({
      edition_key: "2026-W0",
      weekend_label: "empty",
      version: 1,
      published_at: "2026-06-26T09:00:00Z",
      odds_snapshot_at: null,
      gate_snapshot_at: null,
      card_snapshot_at: null,
      condition_snapshot_at: null,
      races: [],
    });
    expect(rep.deep_dives).toEqual([]);
    expect(rep.ticket_lens.best_for_safeish).toBeNull();
    expect(rep.ticket_lens.most_fragile_favorite).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADR-0020 — Japanese locale. The SAME fixture generated in EN and JA; assert
// the JA report carries Japanese prose across every generated block and that NO
// English TEMPLATE prose leaks through. Proper names (English in this fixture)
// and grade chips (G1/G2/G3) are DATA, not generated prose — a horse named
// "Starlight Vow" stays "Starlight Vow" in JA (no verified Japanese counterpart),
// which is correct, not a leak.
// ---------------------------------------------------------------------------

// Matches at least one hiragana, katakana, or kanji — proves a string is JA.
const JA_CHAR = /[぀-ゟ゠-ヿ一-鿿]/;

// English template fragments that must NEVER appear in the JA report. These are
// generated-prose substrings (not names/numbers), so presence in JA is a leak.
const EN_TEMPLATE_FRAGMENTS = [
  "anchors the weekend",
  "research framing, not a recommendation",
  "Hot pace read",
  "Soft pace read",
  "Even pace read",
  "Dominant favorite shape",
  "Concentrated at the top",
  "Open, wide-open shape",
  "Balanced shape — a clear favorite",
  "Quinella/wide on the top 2",
  "Trio boxed around",
  "Trifecta keying",
  "Chalkiest shape of the weekend",
  "Biggest field (",
  "Smallest field (",
  "Fragile-favorite watch",
  "Big-field variance",
  "Dirt draw in play",
  "Friday edition",
  "Saturday refresh",
  "Recreational research only. Not betting advice",
  "the market's clear top choice",
  "Market not yet priced",
  "Draw not yet published",
  "Shortening", // watch note (EN)
  "Lengthening",
];

describe("weeklyReport — Japanese locale (ADR-0020)", () => {
  const en = generateReport(saturdayInput);
  const ja = generateReport(saturdayInput, { locale: "ja" });
  const jaStrings = reportStrings(ja);

  it("locale reaches generation: EN and JA differ on the same input", () => {
    expect(ja.weekend_headline).not.toBe(en.weekend_headline);
    expect(ja.not_advice_reminder).not.toBe(en.not_advice_reminder);
    // And JA is deterministic (reproducible).
    expect(JSON.stringify(ja)).toBe(
      JSON.stringify(generateReport(saturdayInput, { locale: "ja" })),
    );
  });

  it("defaults to English when no locale option is given (backward compat)", () => {
    expect(en.weekend_headline).toMatch(/anchors the weekend/);
    expect(en.not_advice_reminder).toMatch(/Not betting advice/);
  });

  it("stamps the same generator version in both locales", () => {
    expect(ja.generator_version).toBe(GENERATOR_VERSION);
    expect(ja.generator_version).toBe(en.generator_version);
  });

  it("edition + weekend labels: legacy English-only → JA structural fallback", () => {
    // weekend_label is English-only ("June 27–28, 2026"); JA falls back to a
    // date range derived from the race dates (never shown as English editorial
    // prose in JA). EN stays verbatim.
    expect(en.weekend_label).toBe("June 27–28, 2026");
    expect(ja.weekend_label).toBe("2026年6月27–28日");
    // edition_label "Saturday refresh" (English-only) → JA localized default.
    expect(en.edition_label).toBe("Saturday refresh");
    expect(ja.edition_label).toBe("土曜更新（v2）");
  });

  it("JA weekend label falls back to a Japanese-safe label when NO race dates exist (never English)", () => {
    // A legacy English-only weekend_label with no races to derive a date range
    // from must NOT leak the English editorial string into the JA report — it
    // falls back to the JA-safe label (「今週末」). EN still shows the raw label.
    const input: WeekendInput = {
      edition_key: "2026-W0",
      weekend_label: "Some English Weekend",
      version: 1,
      published_at: "2026-06-26T09:00:00Z",
      odds_snapshot_at: null,
      gate_snapshot_at: null,
      card_snapshot_at: null,
      condition_snapshot_at: null,
      races: [],
    };
    expect(generateReport(input, { locale: "ja" }).weekend_label).toBe("今週末");
    expect(generateReport(input, { locale: "en" }).weekend_label).toBe(
      "Some English Weekend",
    );
  });

  it("EN report renders only the English race name (single-language Research)", () => {
    // Research is single-language now (the glossary is the sole bilingual
    // surface). The former "English / 日本語" name pair is gone from every
    // RENDERED field — the EN report shows the English name only. (The raw
    // name_ja value is still carried in the output for archive/PIT, but it is
    // not rendered; this asserts the display fields, not the raw data.)
    const g1 = en.deep_dives.find((d) => d.race_id.endsWith("-09-11"))!;
    const g1Glance = en.glance.find((g) => g.race_id.endsWith("-09-11"))!;
    expect(en.weekend_headline).toContain("Takarazuka Kinen");
    expect(en.weekend_headline).not.toContain("宝塚記念");
    expect(g1.name).toBe("Takarazuka Kinen");
    expect(g1.why_this_race_matters).toContain("Takarazuka Kinen");
    expect(g1.why_this_race_matters).not.toContain("宝塚記念");
    expect(g1Glance.name).toBe("Takarazuka Kinen");
  });

  it("weekend headline uses the JA race name (宝塚記念) + JA prose", () => {
    expect(ja.weekend_headline).toContain("宝塚記念");
    expect(ja.weekend_headline).toContain("軸");
    // And does NOT carry the English name + pair form.
    expect(ja.weekend_headline).not.toContain("Takarazuka Kinen");
    expect(ja.weekend_headline).not.toContain("/");
  });

  it("each deep dive is Japanese across every generated block", () => {
    for (const d of ja.deep_dives) {
      expect(d.why_this_race_matters).toMatch(JA_CHAR);
      expect(d.market_shape).toMatch(JA_CHAR);
      expect(d.gate_draw_impact).toMatch(JA_CHAR);
      expect(d.pace_map).toMatch(JA_CHAR);
      for (const line of d.trend_analysis) expect(line).toMatch(JA_CHAR);
      // Contender reasons carry JA odds formatting (約X倍) for priced runners.
      const pricedReasons = [
        ...d.contender_groups.core_contenders,
        ...d.contender_groups.price_horses,
      ]
        .filter((c) => c.win_odds != null)
        .map((c) => c.reason);
      expect(pricedReasons.some((r) => /約\d+(\.\d+)?倍/.test(r))).toBe(true);
      // Ticket notes — shape, rationale, risk all JA.
      for (const n of Object.values(d.ticket_notes)) {
        expect(n.shape).toMatch(JA_CHAR);
        expect(n.rationale).toMatch(JA_CHAR);
        expect(n.risk).toMatch(JA_CHAR);
      }
    }
  });

  it("race + venue names localize in glance, watchlist, and ticket lens", () => {
    expect(ja.glance.map((g) => g.name)).toEqual(
      expect.arrayContaining([
        "宝塚記念",
        "阪神牝馬ステークス",
        "ルナプロローグステークス",
      ]),
    );
    // G3 dirt venue 中山 (Nakayama).
    const dirt = ja.glance.find((g) => g.name === "ルナプロローグステークス");
    expect(dirt?.venue).toBe("中山");
    // Ticket-lens picks carry JA reasons.
    expect(ja.ticket_lens.best_for_safeish?.reason).toMatch(JA_CHAR);
    expect(ja.ticket_lens.best_for_safeish?.reason).toContain("堅い形");
  });

  it("pace map reads JA for the sample's lone-front-runner shapes", () => {
    // Every sample race has ≤1 declared front-runner → JA soft-pace read.
    for (const d of ja.deep_dives) {
      expect(d.pace_map).toContain("ペースの読み");
    }
  });

  it("emits NO banned edge/advice phrases in the JA report", () => {
    const offenders: string[] = [];
    for (const s of jaStrings) {
      for (const re of BANNED) {
        if (re.test(s)) offenders.push(`${re}  ⇐  ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("carries the not-betting-advice reminder in JA", () => {
    expect(ja.not_advice_reminder).toMatch(/投資助言ではなく/);
    expect(ja.not_advice_reminder).toMatch(/控除率/);
  });

  it("ticket notes never instruct a wager in JA either", () => {
    for (const d of ja.deep_dives) {
      for (const note of Object.values(d.ticket_notes)) {
        // Forbidden instructional verbs (English) must not appear.
        expect(note.shape).not.toMatch(/\b(place|bet|wager)\b/i);
        expect(note.rationale).not.toMatch(/\b(place|bet|wager)\b/i);
        expect(note.risk.length).toBeGreaterThan(0);
      }
    }
  });

  it("no English generated-prose fragments leak into the JA report", () => {
    const leaks = EN_TEMPLATE_FRAGMENTS.filter((frag) =>
      jaStrings.some((s) => s.includes(frag)),
    );
    expect(leaks).toEqual([]);
  });

  it("legacy English-only editorial free-text is OMITTED in JA (not shown as English)", () => {
    // The G1 sample race carries an English editor note + an English trend tag
    // ("course-and-distance winner"). In JA these are omitted (no JA value yet
    // — the documented free-text legacy fallback); in EN they appear.
    const g1En = en.deep_dives.find((d) => d.race_id.endsWith("-09-11"))!;
    const g1Ja = ja.deep_dives.find((d) => d.race_id.endsWith("-09-11"))!;
    expect(g1En.trend_analysis.some((l) => l.includes("Inside course used"))).toBe(true);
    expect(g1Ja.trend_analysis.some((l) => l.includes("Inside course used"))).toBe(false);
    expect(
      g1En.trend_analysis.some((l) => l.includes("course-and-distance winner")),
    ).toBe(true);
    expect(
      g1Ja.trend_analysis.some((l) => l.includes("course-and-distance winner")),
    ).toBe(false);
  });
});
