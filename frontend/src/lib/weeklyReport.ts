// ============================================================================
// Weekly graded-stakes report — deterministic generator.
//
// This is the research/report engine for the "Weekend Roundup" Reference tab.
// It is a PURE function: generateReport(input) -> WeeklyReport. No network, no
// Date.now(), no randomness. Same input always yields byte-identical output, so
// reports are testable and reproducible (requirement: "Keep generation
// deterministic where possible so reports are testable").
//
// FRAMING — Keibamon is a recreational keiba companion for research and
// exotic-ticket construction. Output is analytical framing only (market signal,
// pace risk, draw impact, trend fit, ticket-shape context, fragility, variance).
// It is NOT betting advice. BANNED in all generated copy (asserted by tests):
//   "guaranteed", "sure thing", "lock" (standalone), "beat the market",
//   "best bet", "positive EV", "profit" (as a promise).
// Ticket sections describe structure and risk; they never instruct a wager.
//
// NARRATIVE — generation is deterministic by default. An optional
// NarrativeProvider interface is exposed so a future AI/drafting pass can
// rewrite the `headline`, per-race `why`, and `themes` strings; until one is
// supplied the deterministic provider is used. AI is never on by default.
// Every provider return value passes through sanitizeNarrative (lib/guardrails)
// before it lands in the report, so a non-deterministic provider cannot slip a
// banned edge/advice phrase through at runtime.
// ============================================================================

import { sanitizeNarrative } from "./guardrails";

/**
 * Generator version — the reproducibility key for a generated report.
 *
 * The D1 archive stores RAW WeekendInput (the PIT input of record), and the
 * report is regenerated client-side on read. That means a change to this
 * generator would retroactively alter what an old edition "said". To preserve
 * point-in-time reproducibility, every report is stamped with the generator
 * version that produced it. Bump this constant whenever generated copy
 * SEMANTICS change (new fields, reworded framing, altered contender logic); a
 * reader comparing two editions can then tell whether a wording difference is a
 * real data change or a generator-version change. See docs/adr/0008.
 */
export const GENERATOR_VERSION = "1.1.0";

export type Grade = "G1" | "G2" | "G3";
export type Surface = "turf" | "dirt";
export type StyleSignal = "front" | "presser" | "stalker" | "closer" | "unknown";
export type TrendSignal =
  | "firming"
  | "drifting"
  | "steady"
  | "unknown";

// ---------------------------------------------------------------------------
// INPUT TYPES — what a Friday/Saturday publish supplies.
// ---------------------------------------------------------------------------

export interface RunnerInput {
  horse_number: number;
  horse_name: string;
  /** Post position / gate draw. null until the draw is published. */
  gate: number | null;
  /** Live pari-mutuel win odds; null until the pool opens. */
  win_odds: number | null;
  /** Estimated odds shown pre-pool (Friday edition). */
  win_odds_est?: number | null;
  /** Popularity rank (1 = favorite) if available. */
  popularity?: number | null;
  style_signal?: StyleSignal;
  /** Editor flag: low-odds horse carrying a known weakness. */
  fragile?: boolean;
  /** Optional trend tags feeding trend analysis (e.g. "class drop"). */
  trend_tags?: string[];
  /** Observed odds-direction signal for the watchlist. */
  trend_signal?: TrendSignal;
}

export interface RaceInput {
  race_id: string;
  name: string;
  name_ja?: string;
  grade: Grade;
  venue: string;
  venue_ja?: string;
  surface: Surface;
  distance_m: number;
  /** JST post time "HH:MM". */
  post_time: string;
  /** Race date "YYYY-MM-DD". */
  date: string;
  /** Declared field size (runners list may be partial before the roster firms). */
  field_size?: number;
  going?: string | null;
  weather?: string | null;
  /** Optional editorial notes feeding trend analysis. */
  notes?: string[];
  runners: RunnerInput[];
}

export interface WeekendInput {
  /** Edition key, e.g. "2026-W26". Stable across Friday/Saturday versions. */
  edition_key: string;
  /** Human label, e.g. "Friday edition" / "Saturday refresh". */
  edition_label?: string;
  /** Human weekend label, e.g. "June 27–28, 2026". */
  weekend_label: string;
  /** Monotonic version: 1 = Friday initial, 2 = Saturday refresh, ... */
  version: number;
  /** Publication timestamp (ISO, UTC). When this report was generated/published. */
  published_at: string;
  /** Snapshot timestamps (ISO, UTC). null when that data isn't available yet. */
  odds_snapshot_at: string | null;
  gate_snapshot_at: string | null;
  card_snapshot_at: string | null;
  condition_snapshot_at: string | null;
  races: RaceInput[];
}

// ---------------------------------------------------------------------------
// OUTPUT TYPES — the structured report.
// ---------------------------------------------------------------------------

export interface DataFreshness {
  published_at: string;
  odds_snapshot_at: string | null;
  gate_snapshot_at: string | null;
  card_snapshot_at: string | null;
  condition_snapshot_at: string | null;
  has_live_odds: boolean;
  has_gates: boolean;
  has_conditions: boolean;
}

export interface ContenderRef {
  horse_number: number;
  horse_name: string;
  win_odds: number | null;
  gate: number | null;
  reason: string;
}

export interface ContenderGroups {
  core_contenders: ContenderRef[];
  price_horses: ContenderRef[];
  fragile_favorites: ContenderRef[];
  chaos_slots: ContenderRef[];
}

export interface TicketNote {
  shape: string;
  cost_window: string;
  rationale: string;
  risk: string;
}

export interface RaceSnapshotMeta {
  field_size: number;
  post_time: string;
  surface: Surface;
  distance_m: number;
  going: string | null;
  weather: string | null;
  has_live_odds: boolean;
  has_gates: boolean;
}

export interface RaceDeepDive {
  race_id: string;
  name: string;
  name_ja: string;
  grade: Grade;
  snapshot: RaceSnapshotMeta;
  why_this_race_matters: string;
  market_shape: string;
  gate_draw_impact: string;
  pace_map: string;
  contender_groups: ContenderGroups;
  trend_analysis: string[];
  ticket_notes: {
    safeish: TicketNote;
    balanced: TicketNote;
    spicy: TicketNote;
  };
}

export interface GlanceRace {
  race_id: string;
  name: string;
  grade: Grade;
  venue: string;
  surface: Surface;
  distance_m: number;
  post_time: string;
  date: string;
  field_size: number;
  top_favorites: string[];
  notable_draws: string;
  going_watch: string;
}

export interface WatchlistEntry {
  race_id: string;
  race_name: string;
  horse_number: number;
  horse_name: string;
  signal: TrendSignal;
  note: string;
}

export interface RacePick {
  race_id: string;
  name: string;
  grade: Grade;
  reason: string;
}

export interface TicketLens {
  best_for_safeish: RacePick | null;
  best_for_balanced: RacePick | null;
  best_for_longshot: RacePick | null;
  most_fragile_favorite: RacePick | null;
  best_to_simplify: RacePick | null;
}

export interface WeeklyReport {
  /** Generator version that produced this report (reproducibility key). */
  generator_version: string;
  edition_key: string;
  version: number;
  edition_label: string;
  weekend_label: string;
  freshness: DataFreshness;
  glance: GlanceRace[];
  weekend_headline: string;
  deep_dives: RaceDeepDive[];
  weekend_themes: string[];
  watchlist: WatchlistEntry[];
  ticket_lens: TicketLens;
  not_advice_reminder: string;
}

// ---------------------------------------------------------------------------
// Narrative provider — isolated AI hook with a deterministic default.
// ---------------------------------------------------------------------------

export interface NarrativeProvider {
  weekendHeadline(
    input: WeekendInput,
    report: Omit<
      WeeklyReport,
      "generator_version" | "weekend_headline" | "weekend_themes" | "not_advice_reminder"
    >,
  ): string;
  raceWhy(race: RaceInput, dive: Omit<RaceDeepDive, "why_this_race_matters">): string;
  themes(
    input: WeekendInput,
    report: Omit<
      WeeklyReport,
      "generator_version" | "weekend_headline" | "weekend_themes" | "not_advice_reminder"
    >,
  ): string[];
}

/** Deterministic, copy-safe default. Used unless an AI provider is supplied. */
export const deterministicNarrative: NarrativeProvider = {
  weekendHeadline(input, report) {
    const g1 = input.races.find((r) => r.grade === "G1");
    if (!g1) {
      return `${input.weekend_label}: a graded-stakes weekend with ${report.glance.length} feature races.`;
    }
    const shape = marketShape(g1);
    const fav = topByOdds(g1.runners)[0];
    const favClause = fav
      ? ` Early market attention centers on ${fav.horse_name} (No.${fav.horse_number}).`
      : "";
    return `${input.weekend_label}: the ${g1.name}${g1.name_ja ? ` / ${g1.name_ja}` : ""} anchors the weekend. ${shape.label}${favClause}`;
  },
  raceWhy(race) {
    const gradeTier: Record<Grade, string> = {
      G1: "championship-tier",
      G2: "prestige tier just below the championship",
      G3: "graded stakes, a wide-open shape",
    };
    return `${race.name}${race.name_ja ? ` / ${race.name_ja}` : ""} is a ${race.distance_m} m ${race.surface} ${gradeTier[race.grade]} contest. This section frames the market signal, draw, pace, and ticket-shape context — research framing, not a recommendation.`;
  },
  themes(_input, report) {
    const out: string[] = [];
    const fragile = report.deep_dives.filter((d) =>
      d.contender_groups.fragile_favorites.length > 0,
    );
    if (fragile.length > 0) {
      out.push(
        `Fragile-favorite watch: ${fragile.length} feature ${fragile.length === 1 ? "race has" : "races have"} a short-priced runner carrying a question mark — a pace or draw angle that could reshape the exotic shape.`,
      );
    }
    const bigFields = report.deep_dives.filter((d) => d.snapshot.field_size >= 16);
    if (bigFields.length > 0) {
      out.push(
        `Big-field variance: ${bigFields.length} ${bigFields.length === 1 ? "race" : "races"} with 16+ runners widens the trifecta space and raises variance.`,
      );
    }
    const dirt = report.deep_dives.filter((d) => d.snapshot.surface === "dirt");
    if (dirt.length > 0) {
      out.push(
        `Dirt draw in play: ${dirt.length} ${dirt.length === 1 ? "dirt race is" : "dirt races are"} on the card — inside draws tend to matter more on the sand.`,
      );
    }
    if (out.length === 0) {
      out.push(
        "Balanced weekend: no single theme dominates — read each race on its own market and shape.",
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Helpers — pure, exported for targeted unit tests.
// ---------------------------------------------------------------------------

/** Effective odds for a runner: live odds if open, else estimate, else null. */
export function effectiveOdds(r: RunnerInput): number | null {
  if (r.win_odds != null && r.win_odds > 0) return r.win_odds;
  if (r.win_odds_est != null && r.win_odds_est > 0) return r.win_odds_est;
  return null;
}

/** Runners sorted by effective odds ascending; null-odds runners last. */
export function topByOdds(runners: RunnerInput[]): RunnerInput[] {
  return [...runners].sort((a, b) => {
    const oa = effectiveOdds(a);
    const ob = effectiveOdds(b);
    if (oa == null && ob == null) return a.horse_number - b.horse_number;
    if (oa == null) return 1;
    if (ob == null) return -1;
    return oa - ob;
  });
}

/** Devigged win probability for each runner (sums to 1 across the priced set). */
export function deviggedProbs(runners: RunnerInput[]): Map<number, number> {
  const priced = runners
    .map((r) => ({ n: r.horse_number, o: effectiveOdds(r) }))
    .filter((x): x is { n: number; o: number } => x.o != null && x.o > 0);
  const inv = priced.map((x) => 1 / x.o);
  const sum = inv.reduce((a, b) => a + b, 0) || 1;
  const m = new Map<number, number>();
  for (let i = 0; i < priced.length; i++) m.set(priced[i].n, inv[i] / sum);
  return m;
}

export interface MarketShape {
  label: string;
  /** Sum of devigged probability on the top 3 by odds. 0 when no odds. */
  top3_concentration: number;
}

export function marketShape(race: RaceInput): MarketShape {
  const probs = deviggedProbs(race.runners);
  const ranked = topByOdds(race.runners).filter((r) =>
    probs.has(r.horse_number),
  );
  if (ranked.length === 0) {
    return { label: "Market not yet priced — estimates only.", top3_concentration: 0 };
  }
  const top3 = ranked.slice(0, 3);
  const conc = top3.reduce((a, r) => a + (probs.get(r.horse_number) ?? 0), 0);
  const fav = ranked[0];
  const favProb = probs.get(fav.horse_number) ?? 0;
  let label: string;
  if (favProb >= 0.5) {
    label = `Dominant favorite shape — ${fav.horse_name} carries ~${pct(favProb)} of the devigged win chance; the rest fight for place money.`;
  } else if (conc >= 0.55) {
    label = `Concentrated at the top — the first three absorb ~${pct(conc)} of the devigged chance; a chalky exotic base.`;
  } else if (conc <= 0.33) {
    label = `Open, wide-open shape — the market spreads the chance out (top three ~${pct(conc)}); higher variance, richer exotics possible.`;
  } else {
    label = `Balanced shape — a clear favorite with real depth behind (top three ~${pct(conc)}); workable for several ticket shapes.`;
  }
  return { label, top3_concentration: conc };
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Pace shape from running-style distribution. */
export function paceMap(race: RaceInput): string {
  const styles = race.runners.map((r) => r.style_signal ?? "unknown");
  const front = styles.filter((s) => s === "front").length;
  const pressers = styles.filter((s) => s === "presser").length;
  const closers = styles.filter((s) => s === "closer").length;
  const stalkers = styles.filter((s) => s === "stalker").length;
  if (front + pressers === 0 && closers === 0) {
    return "Running styles not yet declared — pace read opens up once the roster firms.";
  }
  if (front >= 3) {
    return `Hot pace read: ${front} confirmed front-runners + ${pressers} pressers should cook the early fractions — a setup that can favor a stalker/closer (${stalkers}/${closers} on the card).`;
  }
  if (front <= 1) {
    return `Soft pace read: ${front} lone front-runner candidate — an unchallenged leader could steal it cheaply, compressing the exotic.`;
  }
  return `Even pace read: ${front} front-runner(s), ${pressers} presser(s), ${stalkers} stalker(s), ${closers} closer(s) — fractions look genuinely contested.`;
}

/** Gate/draw impact from the favorites' post positions + surface. */
export function gateDrawImpact(race: RaceInput): string {
  if (!race.runners.some((r) => r.gate != null)) {
    return "Draw not yet published — gate-impact read opens Friday once post positions are set.";
  }
  const favs = topByOdds(race.runners)
    .filter((r) => effectiveOdds(r) != null)
    .slice(0, 3);
  const inside = favs.filter((r) => r.gate != null && r.gate <= 3);
  const outside = favs.filter((r) => r.gate != null && r.gate >= race.runners.length - 2);
  const n = race.runners.length;
  if (race.surface === "dirt") {
    if (inside.length >= 2) {
      return `Dirt draw leans inside — ${listFavs(inside)} drawn 1–3, where the sand tends to travel. Favors racing on the rail.`;
    }
    return `Dirt draw looks balanced — no heavy inside concentration among the favorites (${listFavs(favs)}).`;
  }
  if (n >= 16 && outside.length >= 2) {
    return `Big-field turf draw watch — ${listFavs(outside)} are drawn wide (≥${n - 2}); losing ground into the first bend is a real cost on the swing for home.`;
  }
  if (inside.length >= 2) {
    return `Turf draw favors the inner posts here — ${listFavs(inside)} drawn 1–3, saving ground into the first turn.`;
  }
  return `Turf draw looks even-handed — the favorites (${listFavs(favs)}) land in the middle of the gate, no obvious draw tax.`;
}

function listFavs(rs: RunnerInput[]): string {
  if (rs.length === 0) return "no favorites priced";
  return rs
    .map((r) => `${r.horse_name} (No.${r.horse_number}, gate ${r.gate ?? "—"})`)
    .join("; ");
}

/** Group runners into contender buckets. Deterministic given the inputs. */
export function contenderGroups(race: RaceInput): ContenderGroups {
  const ranked = topByOdds(race.runners);
  const fieldSize = race.runners.length;
  const core: ContenderRef[] = [];
  const price: ContenderRef[] = [];
  const fragile: ContenderRef[] = [];
  const chaos: ContenderRef[] = [];
  for (const r of ranked) {
    const o = effectiveOdds(r);
    const ref = (reason: string): ContenderRef => ({
      horse_number: r.horse_number,
      horse_name: r.horse_name,
      win_odds: o,
      gate: r.gate,
      reason,
    });
    if (r.fragile && (o ?? Infinity) <= 5.0) {
      fragile.push(ref(fragileReason(r)));
      continue;
    }
    if (o == null) {
      chaos.push(
        ref(
          joinClauses("Unpriced — pool not open or no estimate yet", [
            tagsClause(r.trend_tags),
          ]),
        ),
      );
      continue;
    }
    if (o <= 6.0) {
      core.push(ref(coreReason(r, o, core.length, fieldSize)));
    } else if (o <= 20.0) {
      price.push(ref(priceReason(r, o, fieldSize)));
    } else {
      chaos.push(ref(chaosReason(r, o, fieldSize)));
    }
  }
  // Fragile-favorite also stays visible in core so the reader still sees it.
  for (const f of fragile) {
    const r = race.runners.find((x) => x.horse_number === f.horse_number);
    if (r) {
      const o = effectiveOdds(r);
      if (o != null && o <= 6.0) core.push({ ...f, reason: f.reason + " Also a core price." });
    }
  }
  return {
    core_contenders: core.slice(0, 5),
    price_horses: price.slice(0, 5),
    fragile_favorites: fragile,
    chaos_slots: chaos.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Contender-group narrative helpers — shared vocabulary so each tier's
// per-horse reason draws on style, draw, trend tags, and market movement
// instead of one templated sentence repeated across every horse in the
// group (only the odds figure used to vary). gateDrawImpact() covers the
// race-level draw read; drawClause() is the per-horse echo of the same idea.
// ---------------------------------------------------------------------------

const STYLE_LABEL: Record<StyleSignal, string> = {
  front: "front-running profile",
  presser: "rides close to the pace",
  stalker: "stalks mid-pack",
  closer: "needs a setup to close",
  unknown: "style not yet declared",
};

const TREND_LABEL: Record<Exclude<TrendSignal, "unknown">, string> = {
  firming: "odds firming through the week — market support building",
  drifting: "drifting out in the betting — support has been thin",
  steady: "price has held steady since first quoted",
};

function drawClause(gate: number | null, fieldSize: number): string | null {
  if (gate == null) return null;
  if (gate <= 2) return `drawn ${gate}, on the rail`;
  if (gate <= 4) return `drawn ${gate}, an inside post`;
  if (fieldSize > 0 && gate >= fieldSize - 1) return `drawn ${gate}, the widest post in the field`;
  if (fieldSize > 0 && gate >= fieldSize - 3) return `drawn ${gate}, out wide`;
  return null; // mid-gate is unremarkable; don't manufacture a clause
}

function trendClause(signal: TrendSignal | undefined): string | null {
  if (!signal || signal === "unknown") return null;
  return TREND_LABEL[signal];
}

function tagsClause(tags: string[] | undefined): string | null {
  if (!tags || tags.length === 0) return null;
  return tags.join(", ");
}

/** Compose a lead clause + optional detail clauses into one sentence, skipping any that are null. */
function joinClauses(lead: string, clauses: Array<string | null>): string {
  const present = clauses.filter((c): c is string => !!c);
  return present.length ? `${lead}; ${present.join("; ")}.` : `${lead}.`;
}

function coreReason(r: RunnerInput, o: number, rank: number, fieldSize: number): string {
  const lead =
    rank === 0
      ? `~${o.toFixed(1)} — the market's clear top choice here`
      : rank === 1
        ? `~${o.toFixed(1)} — sits right with the leader, not far off at the top of the market`
        : `~${o.toFixed(1)} — still inside the market's top tier`;
  return joinClauses(lead, [
    STYLE_LABEL[r.style_signal ?? "unknown"],
    drawClause(r.gate, fieldSize),
    tagsClause(r.trend_tags),
    trendClause(r.trend_signal),
  ]);
}
function priceReason(r: RunnerInput, o: number, fieldSize: number): string {
  const lead =
    o <= 10
      ? `~${o.toFixed(1)} — just off the core tier, the first price angle worth a look`
      : o <= 15
        ? `~${o.toFixed(1)} — a mid-price runner, squarely in exotic-spicing territory`
        : `~${o.toFixed(1)} — near the top of the double-digit range, the last price step before chaos territory`;
  return joinClauses(lead, [
    STYLE_LABEL[r.style_signal ?? "unknown"],
    drawClause(r.gate, fieldSize),
    tagsClause(r.trend_tags),
    trendClause(r.trend_signal),
  ]);
}
function chaosReason(r: RunnerInput, o: number, fieldSize: number): string {
  const lead =
    o < 30
      ? `~${o.toFixed(1)} — a longshot, live enough to matter in a wide exotic`
      : o < 60
        ? `~${o.toFixed(1)} — a deep outsider, mostly here to widen the combinations`
        : `~${o.toFixed(1)} — about as long as they come, a rank outsider`;
  return joinClauses(lead, [
    drawClause(r.gate, fieldSize),
    tagsClause(r.trend_tags),
    trendClause(r.trend_signal),
  ]);
}
function fragileReason(r: RunnerInput): string {
  const bits: string[] = [];
  if (r.style_signal === "closer") bits.push("needs pace to close into");
  if (r.gate != null && r.gate >= 14) bits.push("drawn outside");
  if (r.trend_tags?.includes("class rise")) bits.push("rising in class");
  if (r.trend_tags?.includes("layoff")) bits.push("coming off a layoff");
  if (r.trend_signal === "drifting") bits.push("drifting out in the betting despite the short price");
  return bits.length
    ? `Short-priced but ${bits.join(", ")} — a question mark on the bridge.`
    : "Short-priced with a flagged weakness — fragile at the head of the market.";
}

// ---------------------------------------------------------------------------
// Ticket-shape notes — describe structure + risk, never instruct a wager.
// ---------------------------------------------------------------------------

export function ticketNotes(race: RaceInput): {
  safeish: TicketNote;
  balanced: TicketNote;
  spicy: TicketNote;
} {
  const g = contenderGroups(race);
  const core = g.core_contenders;
  const price = g.price_horses;
  const chaos = g.chaos_slots;
  const safeishCore = core.slice(0, 2).map((c) => c.horse_name);
  const balancedCore = core.slice(0, 3).map((c) => c.horse_name);
  const balancedPrice = price.slice(0, 1).map((c) => c.horse_name);
  const spicyCore = core.slice(0, 2).map((c) => c.horse_name);
  const spicyMix = [...price.slice(0, 2), ...chaos.slice(0, 1)].map(
    (c) => c.horse_name,
  );

  return {
    safeish: {
      shape:
        safeishCore.length >= 2
          ? `Quinella/wide on the top 2 (${safeishCore.join(", ")}).`
          : "Quinella on the clear favorites once priced.",
      cost_window: "Low combo count — smaller outlay.",
      rationale:
        "Tightest shape: concentrates on the market leaders, fewer combinations.",
      risk: "Low hit-rate variance, modest payout — the takeout is still in the pool.",
    },
    balanced: {
      shape:
        balancedCore.length >= 3
          ? `Trio boxed around ${balancedCore.join(", ")}${balancedPrice.length ? ` + ${balancedPrice[0]} as a price` : ""}.`
          : "Trio around the leading three once the field firms.",
      cost_window: "Medium combo count.",
      rationale:
        "Keeps the leaders and adds a price angle — a real shot with fun upside.",
      risk: "Misses when a complete outsider runs into the frame.",
    },
    spicy: {
      shape:
        spicyCore.length >= 2 && spicyMix.length
          ? `Trifecta keying ${spicyCore.join(", ")} up front, weaving in ${spicyMix.join(", ")} underneath.`
          : "Trifecta weaving in the longshots underneath.",
      cost_window: "High combo count — larger outlay to cover the spread.",
      rationale:
        "Embraces chaos — leans into the variance a big exotic payout needs.",
      risk: "High variance — misses often, pays well when the shape breaks open.",
    },
  };
}

// ---------------------------------------------------------------------------
// Trend analysis — derives readable lines from notes + runner tags.
// ---------------------------------------------------------------------------

export function trendAnalysis(race: RaceInput): string[] {
  const out: string[] = [];
  const tagged = race.runners.filter((r) => (r.trend_tags ?? []).length > 0);
  const tagCounts = new Map<string, number>();
  for (const r of tagged)
    for (const tag of r.trend_tags ?? [])
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  for (const [tag, n] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`Trend — "${tag}": appears on ${n} runner${n === 1 ? "" : "s"} in this field.`);
  }
  for (const note of race.notes ?? []) out.push(`Editor note — ${note}`);
  const fragile = race.runners.filter((r) => r.fragile);
  if (fragile.length > 0) {
    out.push(
      `Fragility flag — ${fragile.length} short-priced runner${fragile.length === 1 ? "" : "s"} carrying a structural question (see fragile-favorites group).`,
    );
  }
  if (out.length === 0) {
    out.push("No notable trend tags this round — read the race on market and shape alone.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data freshness + completeness.
// ---------------------------------------------------------------------------

export function freshness(input: WeekendInput): DataFreshness {
  const races = input.races;
  const has_live_odds = races.some((r) =>
    r.runners.some((rn) => rn.win_odds != null && rn.win_odds > 0),
  );
  const has_gates = races.some((r) =>
    r.runners.some((rn) => rn.gate != null),
  );
  const has_conditions = races.some(
    (r) => (r.going ?? null) != null || (r.weather ?? null) != null,
  );
  return {
    published_at: input.published_at,
    odds_snapshot_at: input.odds_snapshot_at,
    gate_snapshot_at: input.gate_snapshot_at,
    card_snapshot_at: input.card_snapshot_at,
    condition_snapshot_at: input.condition_snapshot_at,
    has_live_odds,
    has_gates,
    has_conditions,
  };
}

// ---------------------------------------------------------------------------
// Glance row + watchlist.
// ---------------------------------------------------------------------------

export function glanceRow(race: RaceInput): GlanceRace {
  const ranked = topByOdds(race.runners).filter(
    (r) => effectiveOdds(r) != null,
  );
  const topFavs = ranked.slice(0, 3).map((r) => r.horse_name);
  return {
    race_id: race.race_id,
    name: race.name,
    grade: race.grade,
    venue: race.venue,
    surface: race.surface,
    distance_m: race.distance_m,
    post_time: race.post_time,
    date: race.date,
    field_size: race.field_size ?? race.runners.length,
    top_favorites: topFavs,
    notable_draws: glanceDraws(race),
    going_watch:
      race.going != null || race.weather != null
        ? `${[race.going && `going ${race.going}`, race.weather && `${race.weather}`].filter(Boolean).join(", ")}`
        : "Going/weather not yet posted.",
  };
}

function glanceDraws(race: RaceInput): string {
  if (!race.runners.some((r) => r.gate != null)) return "Draw pending.";
  const favs = topByOdds(race.runners)
    .filter((r) => effectiveOdds(r) != null)
    .slice(0, 2);
  return favs
    .map((r) => `${r.horse_name} gate ${r.gate ?? "—"}`)
    .join("; ") || "Draw set.";
}

export function buildWatchlist(input: WeekendInput): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const race of input.races) {
    for (const r of race.runners) {
      if (r.trend_signal && r.trend_signal !== "unknown") {
        out.push({
          race_id: race.race_id,
          race_name: race.name,
          horse_number: r.horse_number,
          horse_name: r.horse_name,
          signal: r.trend_signal,
          note: watchNote(r),
        });
      }
    }
  }
  // Stable ordering: firming first, then drifting, then steady.
  const order: Record<TrendSignal, number> = {
    firming: 0,
    drifting: 1,
    steady: 2,
    unknown: 3,
  };
  return out.sort((a, b) => {
    const d = order[a.signal] - order[b.signal];
    if (d !== 0) return d;
    return a.horse_name.localeCompare(b.horse_name);
  });
}

function watchNote(r: RunnerInput): string {
  const o = effectiveOdds(r);
  const priced = o != null ? ` ~${o.toFixed(1)}` : "";
  if (r.trend_signal === "firming")
    return `Shortening${priced} — money coming for this runner across the snapshots.`;
  if (r.trend_signal === "drifting")
    return `Lengthening${priced} — easing away across the snapshots.`;
  return `Steady${priced} — holding in line across the snapshots.`;
}

// ---------------------------------------------------------------------------
// Ticket lens — cross-race deterministic picks.
// ---------------------------------------------------------------------------

export function buildTicketLens(input: WeekendInput, dives: RaceDeepDive[]): TicketLens {
  if (input.races.length === 0) {
    return {
      best_for_safeish: null,
      best_for_balanced: null,
      best_for_longshot: null,
      most_fragile_favorite: null,
      best_to_simplify: null,
    };
  }
  // Map race_id -> supporting data.
  const byRace = new Map(input.races.map((r) => [r.race_id, r]));
  const diveByRace = new Map(dives.map((d) => [d.race_id, d]));

  const scored = input.races.map((r) => {
    const shape = marketShape(r);
    const probs = deviggedProbs(r.runners);
    const ranked = topByOdds(r.runners).filter((x) => probs.has(x.horse_number));
    const favProb = ranked.length ? probs.get(ranked[0].horse_number) ?? 0 : 0;
    const field = r.field_size ?? r.runners.length;
    const fragileCount =
      diveByRace.get(r.race_id)?.contender_groups.fragile_favorites.length ?? 0;
    return {
      race: r,
      field,
      concentration: shape.top3_concentration,
      favProb,
      fragileCount,
    };
  });

  const pick = (
    s: { race: RaceInput; field: number; concentration: number; favProb: number; fragileCount: number },
    reason: string,
  ): RacePick => ({
    race_id: s.race.race_id,
    name: s.race.name,
    grade: s.race.grade,
    reason,
  });

  // Safe-ish: highest top-3 concentration (chalkiest, lowest-variance shape).
  const safeish = [...scored].sort(
    (a, b) => b.concentration - a.concentration || a.field - b.field,
  )[0];
  // Balanced: medium field, a clear but not dominant favorite (favProb ~0.3–0.45).
  const balanced = [...scored].sort(
    (a, b) =>
      Math.abs(a.favProb - 0.36) - Math.abs(b.favProb - 0.36) ||
      b.concentration - a.concentration,
  )[0];
  // Longshot: largest field + lowest concentration.
  const longshot = [...scored].sort(
    (a, b) => b.field - a.field || a.concentration - b.concentration,
  )[0];
  // Simplify: smallest field + highest concentration.
  const simplify = [...scored].sort(
    (a, b) => a.field - b.field || b.concentration - a.concentration,
  )[0];
  // Most fragile favorite: most fragile flags, tie-break shortest favorite odds.
  const frag = [...scored].sort(
    (a, b) => b.fragileCount - a.fragileCount || b.favProb - a.favProb,
  )[0];

  return {
    best_for_safeish: pick(
      safeish,
      `Chalkiest shape of the weekend (top-three ~${pct(safeish.concentration)} of the devigged chance) — the lowest-variance exotic base.`,
    ),
    best_for_balanced: pick(
      balanced,
      `Clear favorite with real depth behind — a workable trio/trifecta shape (~${pct(balanced.concentration)} on the top three).`,
    ),
    best_for_longshot: pick(
      longshot,
      `Biggest field (${longshot.field}) with the widest spread — the variance a longshot hunter wants.`,
    ),
    most_fragile_favorite:
      frag.fragileCount > 0
        ? pick(
            frag,
            `Carries the most flagged fragile-favorite weight this weekend — the bridge most worth questioning.`,
          )
        : null,
    best_to_simplify: pick(
      simplify,
      `Smallest field (${simplify.field}) and tightest shape — least moving parts if you want to keep a ticket simple.`,
    ),
  };
}

// ---------------------------------------------------------------------------
// The generator itself.
// ---------------------------------------------------------------------------

export function generateReport(
  input: WeekendInput,
  provider: NarrativeProvider = deterministicNarrative,
): WeeklyReport {
  const fr = freshness(input);
  const ordered = [...input.races].sort(gradeOrder);
  const deep_dives: RaceDeepDive[] = ordered.map((race) => {
    const groups = contenderGroups(race);
    const tickets = ticketNotes(race);
    const diveSansWhy: Omit<RaceDeepDive, "why_this_race_matters"> = {
      race_id: race.race_id,
      name: race.name,
      name_ja: race.name_ja ?? "",
      grade: race.grade,
      snapshot: {
        field_size: race.field_size ?? race.runners.length,
        post_time: race.post_time,
        surface: race.surface,
        distance_m: race.distance_m,
        going: race.going ?? null,
        weather: race.weather ?? null,
        has_live_odds: race.runners.some((r) => r.win_odds != null && r.win_odds > 0),
        has_gates: race.runners.some((r) => r.gate != null),
      },
      market_shape: marketShape(race).label,
      gate_draw_impact: gateDrawImpact(race),
      pace_map: paceMap(race),
      contender_groups: groups,
      trend_analysis: trendAnalysis(race),
      ticket_notes: tickets,
    };
    return {
      ...diveSansWhy,
      why_this_race_matters: sanitizeNarrative(provider.raceWhy(race, diveSansWhy)),
    };
  });

  const glance = ordered.map(glanceRow);
  const watchlist = buildWatchlist(input);
  const lens = buildTicketLens(input, deep_dives);

  const sansHeadline = {
    edition_key: input.edition_key,
    version: input.version,
    edition_label: input.edition_label ?? defaultEditionLabel(input.version),
    weekend_label: input.weekend_label,
    freshness: fr,
    glance,
    deep_dives,
    watchlist,
    ticket_lens: lens,
  };

  const headline = sanitizeNarrative(provider.weekendHeadline(input, sansHeadline));
  const themes = provider.themes(input, sansHeadline).map(sanitizeNarrative);

  return {
    ...sansHeadline,
    generator_version: GENERATOR_VERSION,
    weekend_headline: headline,
    weekend_themes: themes,
    not_advice_reminder:
      "Recreational research only. Not betting advice, not a winning method, not a profit guarantee. Pool takeout applies to every ticket.",
  };
}

function defaultEditionLabel(version: number): string {
  if (version <= 1) return "Friday edition";
  return `Saturday refresh (v${version})`;
}

/** Grade ordering for display: G1 first, then G2, then G3. */
export function gradeOrder(a: RaceInput, b: RaceInput): number {
  const rank: Record<Grade, number> = { G1: 0, G2: 1, G3: 2 };
  const d = rank[a.grade] - rank[b.grade];
  if (d !== 0) return d;
  return (a.date || "").localeCompare(b.date || "") || a.post_time.localeCompare(b.post_time);
}
