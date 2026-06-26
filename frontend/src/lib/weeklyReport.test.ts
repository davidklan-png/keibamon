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
    const rep = generateReport(saturdayInput, malicious);
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
    const b = generateReport(saturdayInput, deterministicNarrative);
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
