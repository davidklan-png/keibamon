// ============================================================================
// Weekly graded-stakes report — deterministic generator.
//
// This is the research/report engine for the "Weekend Roundup" Reference tab.
// It is a PURE function: generateReport(input, opts) -> WeeklyReport. No network,
// no Date.now(), no randomness. Same input + opts always yields byte-identical
// output, so reports are testable and reproducible (requirement: "Keep
// generation deterministic where possible so reports are testable").
//
// LOCALE-AWARE (ADR-0020) — generation is locale-aware via an options object
// (defaulting to English — the pre-locale default locale). All dynamic prose is sourced
// from a dedicated locale/template module (lib/weeklyReport.locale.ts); this
// file holds only the logic that decides WHICH template applies. Free-text
// editorial inputs (notes, trend_tags, weekend_label, edition_label, going,
// weather) carry an explicit bilingual {en,ja} representation with a documented
// legacy fallback (lib/weeklyReport.locale.ts:tx). The generator never silently
// shows English editorial prose in a Japanese report.
//
// FRAMING — Keibamon is a recreational keiba companion for research and
// exotic-ticket construction. Output is analytical framing only (market signal,
// pace risk, draw impact, trend fit, ticket-shape context, fragility, variance).
// It is NOT betting advice. BANNED in all generated copy (asserted by tests):
//   "guaranteed", "sure thing", "lock" (standalone), "beat the market",
//   "best bet", "positive EV", "profit" (as a promise).
// Ticket sections describe structure and risk; they never instruct a wager.
// The guardrail applies identically in both locales (the JA pack contains no
// English edge/advice wording; both editions are scanned by the test suite).
//
// NARRATIVE — generation is deterministic by default. An optional
// NarrativeProvider interface is exposed so a future AI/drafting pass can
// rewrite the `headline`, per-race `why`, and `themes` strings; until one is
// supplied the deterministic provider (locale-aware) is used. AI is never on by
// default. Every provider return value passes through sanitizeNarrative
// (lib/guardrails) before it lands in the report, so a non-deterministic
// provider cannot slip a banned edge/advice phrase through at runtime.
// ============================================================================

import { sanitizeNarrative } from "./guardrails";
import {
  PROSE,
  tx,
  goingLabel,
  weatherLabel,
  surfaceLabel,
  raceName,
  venueName,
  JA_WEEKEND_LABEL_FALLBACK,
  type LocalizedText,
} from "./weeklyReport.locale";

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
 *
 * 1.2.0 — locale-aware generation (ADR-0020). The deterministic prose templates
 * (market/pace/gate/contender/ticket/watchlist/lens copy) and the not-advice
 * reminder are unchanged in English; a Japanese prose pack was added and the
 * free-text inputs gained an explicit {en,ja} representation. ONE deliberate
 * English change: Research is now single-language (the glossary is the sole
 * bilingual comparison surface), so the headline + per-race "why" no longer
 * append the former "English / 日本語" name pair — English shows the English
 * name only. English output is therefore NOT byte-identical to 1.1.0; the pair
 * removal is the sole retroactive wording change for existing English editions.
 */
export const GENERATOR_VERSION = "1.2.0";

/** Report output locale. Defaults to "en" everywhere (English is the default). */
export type ReportLocale = "en" | "ja";

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
//
// Free-text editorial fields (notes, trend_tags, weekend_label, edition_label)
// and externally-supplied non-enum values (going, weather) accept an explicit
// bilingual representation (LocalizedText = string | {en, ja}). A plain string
// is the legacy English-only form and is resolved under the documented policy
// in weeklyReport.locale.ts:tx (shown in EN; omitted or structurally fallback'd
// in JA — never silently displayed as English editorial prose).
// ---------------------------------------------------------------------------

export interface RunnerInput {
  horse_number: number;
  /** Horse name. In real data this is already Japanese (カタカナ); it is a proper
   *  noun shown verbatim in both locales (no separate JA variant). */
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
  /** Optional trend tags feeding trend analysis (e.g. "class drop"). Bilingual:
   *  a legacy English-only tag is omitted from a JA report until a JA value exists. */
  trend_tags?: LocalizedText[];
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
  /** Track condition. A controlled JRA vocabulary where recognized (good/firm/
   *  soft/...); an unrecognized or {en,ja} value resolves via locale.ts. */
  going?: LocalizedText | null;
  /** Weather. Controlled JRA vocabulary where recognized; else bilingual/legacy. */
  weather?: LocalizedText | null;
  /** Optional editorial notes feeding trend analysis. Bilingual: a legacy
   *  English-only note is omitted from a JA report until a JA value exists. */
  notes?: LocalizedText[];
  runners: RunnerInput[];
}

export interface WeekendInput {
  /** Edition key, e.g. "2026-W26". Stable across Friday/Saturday versions. */
  edition_key: string;
  /** Human label, e.g. "Friday edition" / "Saturday refresh". Bilingual. */
  edition_label?: LocalizedText;
  /** Human weekend label, e.g. "June 27–28, 2026". Bilingual; a legacy
   *  English-only label falls back to a JA date range derived from the race
   *  dates (never shown as English editorial prose in JA mode). */
  weekend_label: LocalizedText;
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

// Re-export the bilingual editorial type so consumers import it from the
// generator barrel (the data contract lives next to the types that use it).
export type { LocalizedText } from "./weeklyReport.locale";

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

/** Build the deterministic, copy-safe, LOCALE-AWARE provider. Used unless an AI
 *  provider is supplied. English by default. */
export function deterministicNarrativeFor(loc: ReportLocale): NarrativeProvider {
  const P = PROSE[loc];
  return {
    weekendHeadline(_input, report) {
      // report.weekend_label is already locale-resolved by generateReport.
      const wl = report.weekend_label;
      const g1 = _input.races.find((r) => r.grade === "G1");
      if (!g1) {
        return P.weekendHeadlineNoG1(wl, report.glance.length);
      }
      const shape = marketShape(g1, loc);
      const fav = topByOdds(g1.runners)[0];
      return P.weekendHeadlineG1(
        wl,
        raceName(g1.name, g1.name_ja, loc),
        shape.label,
        fav ? fav.horse_name : null,
        fav ? fav.horse_number : null,
      );
    },
    raceWhy(race) {
      return P.raceWhy(
        raceName(race.name, race.name_ja, loc),
        race.distance_m,
        surfaceLabel(race.surface, loc),
        P.gradeTier(race.grade),
      );
    },
    themes(_input, report) {
      const out: string[] = [];
      const fragile = report.deep_dives.filter((d) =>
        d.contender_groups.fragile_favorites.length > 0,
      );
      if (fragile.length > 0) {
        out.push(P.themeFragile(fragile.length));
      }
      const bigFields = report.deep_dives.filter((d) => d.snapshot.field_size >= 16);
      if (bigFields.length > 0) {
        out.push(P.themeBigField(bigFields.length));
      }
      const dirt = report.deep_dives.filter((d) => d.snapshot.surface === "dirt");
      if (dirt.length > 0) {
        out.push(P.themeDirt(dirt.length));
      }
      if (out.length === 0) {
        out.push(P.themeBalanced);
      }
      return out;
    },
  };
}

/** English deterministic provider — the historical default (backward-compat name). */
export const deterministicNarrative: NarrativeProvider = deterministicNarrativeFor("en");

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

export function marketShape(race: RaceInput, loc: ReportLocale = "en"): MarketShape {
  const P = PROSE[loc];
  const probs = deviggedProbs(race.runners);
  const ranked = topByOdds(race.runners).filter((r) =>
    probs.has(r.horse_number),
  );
  if (ranked.length === 0) {
    return { label: P.marketUnpriced, top3_concentration: 0 };
  }
  const top3 = ranked.slice(0, 3);
  const conc = top3.reduce((a, r) => a + (probs.get(r.horse_number) ?? 0), 0);
  const fav = ranked[0];
  const favProb = probs.get(fav.horse_number) ?? 0;
  let label: string;
  if (favProb >= 0.5) {
    label = P.marketDominant(fav.horse_name, pct(favProb));
  } else if (conc >= 0.55) {
    label = P.marketConcentrated(pct(conc));
  } else if (conc <= 0.33) {
    label = P.marketOpen(pct(conc));
  } else {
    label = P.marketBalanced(pct(conc));
  }
  return { label, top3_concentration: conc };
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Pace shape from running-style distribution. */
export function paceMap(race: RaceInput, loc: ReportLocale = "en"): string {
  const P = PROSE[loc];
  const styles = race.runners.map((r) => r.style_signal ?? "unknown");
  const front = styles.filter((s) => s === "front").length;
  const pressers = styles.filter((s) => s === "presser").length;
  const closers = styles.filter((s) => s === "closer").length;
  const stalkers = styles.filter((s) => s === "stalker").length;
  if (front + pressers === 0 && closers === 0) {
    return P.paceNotDeclared;
  }
  if (front >= 3) {
    return P.paceHot(front, pressers, stalkers, closers);
  }
  if (front <= 1) {
    return P.paceSoft(front);
  }
  return P.paceEven(front, pressers, stalkers, closers);
}

/** Gate/draw impact from the favorites' post positions + surface. */
export function gateDrawImpact(race: RaceInput, loc: ReportLocale = "en"): string {
  const P = PROSE[loc];
  if (!race.runners.some((r) => r.gate != null)) {
    return P.gateNotPublished;
  }
  const favs = topByOdds(race.runners)
    .filter((r) => effectiveOdds(r) != null)
    .slice(0, 3);
  const inside = favs.filter((r) => r.gate != null && r.gate <= 3);
  const outside = favs.filter((r) => r.gate != null && r.gate >= race.runners.length - 2);
  const n = race.runners.length;
  if (race.surface === "dirt") {
    if (inside.length >= 2) {
      return P.gateDirtInside(listFavs(inside, loc));
    }
    return P.gateDirtBalanced(listFavs(favs, loc));
  }
  if (n >= 16 && outside.length >= 2) {
    return P.gateBigWide(listFavs(outside, loc), n - 2);
  }
  if (inside.length >= 2) {
    return P.gateTurfInside(listFavs(inside, loc));
  }
  return P.gateTurfEven(listFavs(favs, loc));
}

function listFavs(rs: RunnerInput[], loc: ReportLocale): string {
  const P = PROSE[loc];
  if (rs.length === 0) return P.gateNoFavs;
  return rs
    .map((r) => P.gateFav(r.horse_name, r.horse_number, r.gate))
    .join(P.gateFavJoiner);
}

/** Group runners into contender buckets. Deterministic given the inputs. */
export function contenderGroups(race: RaceInput, loc: ReportLocale = "en"): ContenderGroups {
  const P = PROSE[loc];
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
      fragile.push(ref(fragileReason(r, P)));
      continue;
    }
    if (o == null) {
      chaos.push(
        ref(
          P.joinClauses(P.unpricedLead, [
            tagsClause(r.trend_tags, loc),
          ]),
        ),
      );
      continue;
    }
    if (o <= 6.0) {
      core.push(ref(coreReason(r, o, core.length, fieldSize, loc)));
    } else if (o <= 20.0) {
      price.push(ref(priceReason(r, o, fieldSize, loc)));
    } else {
      chaos.push(ref(chaosReason(r, o, fieldSize, loc)));
    }
  }
  // Fragile-favorite also stays visible in core so the reader still sees it.
  for (const f of fragile) {
    const r = race.runners.find((x) => x.horse_number === f.horse_number);
    if (r) {
      const o = effectiveOdds(r);
      if (o != null && o <= 6.0) {
        core.push({ ...f, reason: f.reason + P.fragileAlsoCore });
      }
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
// All vocabulary is locale-sourced (PROSE[loc]).
// ---------------------------------------------------------------------------

function joinNames(arr: string[], loc: ReportLocale): string {
  return arr.join(loc === "ja" ? "・" : ", ");
}

/** Stable identity for a (possibly bilingual) trend tag, for counting. */
function tagKey(t: LocalizedText): string {
  return typeof t === "string" ? t : `${t.en}||${t.ja}`;
}

/** Does the runner carry a trend tag matching the EN or JA needle? */
function hasTag(
  tags: LocalizedText[] | undefined,
  enNeedle: string,
  jaNeedle: string,
): boolean {
  return !!tags?.some((t) =>
    typeof t === "string"
      ? t === enNeedle || t === jaNeedle
      : t.en === enNeedle || t.ja === jaNeedle,
  );
}

function drawClause(gate: number | null, fieldSize: number, loc: ReportLocale): string | null {
  if (gate == null) return null;
  return PROSE[loc].drawClause(gate, fieldSize);
}

function trendClause(signal: TrendSignal | undefined, loc: ReportLocale): string | null {
  if (!signal || signal === "unknown") return null;
  return PROSE[loc].trendLabel[signal];
}

function tagsClause(tags: LocalizedText[] | undefined, loc: ReportLocale): string | null {
  if (!tags || tags.length === 0) return null;
  const parts = tags.map((t) => tx(t, loc)).filter((x): x is string => !!x);
  return parts.length ? joinNames(parts, loc) : null;
}

function coreReason(
  r: RunnerInput,
  o: number,
  rank: number,
  fieldSize: number,
  loc: ReportLocale,
): string {
  const P = PROSE[loc];
  return P.joinClauses(P.coreLead(o, rank), [
    P.styleLabel[r.style_signal ?? "unknown"],
    drawClause(r.gate, fieldSize, loc),
    tagsClause(r.trend_tags, loc),
    trendClause(r.trend_signal, loc),
  ]);
}
function priceReason(
  r: RunnerInput,
  o: number,
  fieldSize: number,
  loc: ReportLocale,
): string {
  const P = PROSE[loc];
  return P.joinClauses(P.priceLead(o), [
    P.styleLabel[r.style_signal ?? "unknown"],
    drawClause(r.gate, fieldSize, loc),
    tagsClause(r.trend_tags, loc),
    trendClause(r.trend_signal, loc),
  ]);
}
function chaosReason(
  r: RunnerInput,
  o: number,
  fieldSize: number,
  loc: ReportLocale,
): string {
  const P = PROSE[loc];
  return P.joinClauses(P.chaosLead(o), [
    drawClause(r.gate, fieldSize, loc),
    tagsClause(r.trend_tags, loc),
    trendClause(r.trend_signal, loc),
  ]);
}
function fragileReason(r: RunnerInput, P: (typeof PROSE)[ReportLocale]): string {
  const bits: string[] = [];
  if (r.style_signal === "closer") bits.push(P.fragileCloserBit);
  if (r.gate != null && r.gate >= 14) bits.push(P.fragileOutsideBit);
  if (hasTag(r.trend_tags, "class rise", "クラス昇級")) bits.push(P.fragileClassRiseBit);
  if (hasTag(r.trend_tags, "layoff", "久々")) bits.push(P.fragileLayoffBit);
  if (r.trend_signal === "drifting") bits.push(P.fragileDriftBit);
  return bits.length ? P.fragileComposed(bits) : P.fragileEmpty;
}

// ---------------------------------------------------------------------------
// Ticket-shape notes — describe structure + risk, never instruct a wager.
// ---------------------------------------------------------------------------

export function ticketNotes(
  race: RaceInput,
  loc: ReportLocale = "en",
): {
  safeish: TicketNote;
  balanced: TicketNote;
  spicy: TicketNote;
} {
  const P = PROSE[loc];
  const g = contenderGroups(race, loc);
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
          ? P.ticketSafeishShape(joinNames(safeishCore, loc))
          : P.ticketSafeishShapeFallback,
      cost_window: P.ticketSafeishCost,
      rationale: P.ticketSafeishRationale,
      risk: P.ticketSafeishRisk,
    },
    balanced: {
      shape:
        balancedCore.length >= 3
          ? P.ticketBalancedShape(
              joinNames(balancedCore, loc),
              balancedPrice.length ? balancedPrice[0] : null,
            )
          : P.ticketBalancedShapeFallback,
      cost_window: P.ticketBalancedCost,
      rationale: P.ticketBalancedRationale,
      risk: P.ticketBalancedRisk,
    },
    spicy: {
      shape:
        spicyCore.length >= 2 && spicyMix.length
          ? P.ticketSpicyShape(joinNames(spicyCore, loc), joinNames(spicyMix, loc))
          : P.ticketSpicyShapeFallback,
      cost_window: P.ticketSpicyCost,
      rationale: P.ticketSpicyRationale,
      risk: P.ticketSpicyRisk,
    },
  };
}

// ---------------------------------------------------------------------------
// Trend analysis — derives readable lines from notes + runner tags.
// ---------------------------------------------------------------------------

export function trendAnalysis(race: RaceInput, loc: ReportLocale = "en"): string[] {
  const P = PROSE[loc];
  const out: string[] = [];
  const tagged = race.runners.filter((r) => (r.trend_tags ?? []).length > 0);
  const tagCounts = new Map<string, { display: string | null; n: number }>();
  for (const r of tagged) {
    for (const tag of r.trend_tags ?? []) {
      const key = tagKey(tag);
      const display = tx(tag, loc);
      const cur = tagCounts.get(key);
      if (cur) {
        cur.n += 1;
        if (cur.display == null && display != null) cur.display = display;
      } else {
        tagCounts.set(key, { display, n: 1 });
      }
    }
  }
  for (const [, { display, n }] of [...tagCounts.entries()].sort(
    (a, b) => b[1].n - a[1].n,
  )) {
    // Legacy English-only tag in JA → display null → omit (documented fallback).
    if (display == null) continue;
    out.push(P.trendTagLine(display, n));
  }
  for (const note of race.notes ?? []) {
    const resolved = tx(note, loc);
    if (resolved != null) out.push(P.editorNoteLine(resolved));
  }
  const fragile = race.runners.filter((r) => r.fragile);
  if (fragile.length > 0) {
    out.push(P.fragilityLine(fragile.length));
  }
  if (out.length === 0) {
    out.push(P.trendEmpty);
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

export function glanceRow(race: RaceInput, loc: ReportLocale = "en"): GlanceRace {
  const P = PROSE[loc];
  const ranked = topByOdds(race.runners).filter(
    (r) => effectiveOdds(r) != null,
  );
  const topFavs = ranked.slice(0, 3).map((r) => r.horse_name);
  const going = goingLabel(race.going, loc);
  const weather = weatherLabel(race.weather, loc);
  return {
    race_id: race.race_id,
    name: raceName(race.name, race.name_ja, loc),
    grade: race.grade,
    venue: venueName(race.venue, race.venue_ja, loc),
    surface: race.surface,
    distance_m: race.distance_m,
    post_time: race.post_time,
    date: race.date,
    field_size: race.field_size ?? race.runners.length,
    top_favorites: topFavs,
    notable_draws: glanceDraws(race, loc),
    going_watch:
      going != null || weather != null
        ? P.glanceGoingWatch(going, weather)
        : P.glanceGoingWatchEmpty,
  };
}

function glanceDraws(race: RaceInput, loc: ReportLocale): string {
  const P = PROSE[loc];
  if (!race.runners.some((r) => r.gate != null)) return P.glanceDrawPending;
  const favs = topByOdds(race.runners)
    .filter((r) => effectiveOdds(r) != null)
    .slice(0, 2);
  const lines = favs.map((r) => P.glanceDrawLine(r.horse_name, r.gate));
  return lines.length ? lines.join(P.glanceDrawJoiner) : P.glanceDrawSet;
}

export function buildWatchlist(
  input: WeekendInput,
  loc: ReportLocale = "en",
): WatchlistEntry[] {
  const out: WatchlistEntry[] = [];
  for (const race of input.races) {
    for (const r of race.runners) {
      if (r.trend_signal && r.trend_signal !== "unknown") {
        out.push({
          race_id: race.race_id,
          race_name: raceName(race.name, race.name_ja, loc),
          horse_number: r.horse_number,
          horse_name: r.horse_name,
          signal: r.trend_signal,
          note: watchNote(r, loc),
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

function watchNote(r: RunnerInput, loc: ReportLocale): string {
  const P = PROSE[loc];
  const o = effectiveOdds(r);
  const priced = o != null ? P.watchPriced(o) : "";
  if (r.trend_signal === "firming") return P.watchFirming(priced);
  if (r.trend_signal === "drifting") return P.watchDrifting(priced);
  return P.watchSteady(priced);
}

// ---------------------------------------------------------------------------
// Ticket lens — cross-race deterministic picks.
// ---------------------------------------------------------------------------

export function buildTicketLens(
  input: WeekendInput,
  dives: RaceDeepDive[],
  loc: ReportLocale = "en",
): TicketLens {
  const P = PROSE[loc];
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
    const shape = marketShape(r, loc);
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
    name: raceName(s.race.name, s.race.name_ja, loc),
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
    best_for_safeish: pick(safeish, P.lensSafeish(pct(safeish.concentration))),
    best_for_balanced: pick(balanced, P.lensBalanced(pct(balanced.concentration))),
    best_for_longshot: pick(longshot, P.lensLongshot(longshot.field)),
    most_fragile_favorite:
      frag.fragileCount > 0 ? pick(frag, P.lensFragile) : null,
    best_to_simplify: pick(simplify, P.lensSimplify(simplify.field)),
  };
}

// ---------------------------------------------------------------------------
// Edition + weekend label resolution (free-text / legacy fallback policy).
// ---------------------------------------------------------------------------

export function defaultEditionLabel(version: number, loc: ReportLocale = "en"): string {
  const P = PROSE[loc];
  return version <= 1 ? P.editionLabelFriday : P.editionLabelSaturday(version);
}

/** Resolve the weekend label for a locale. EN always returns the English side.
 *  JA never returns an English editorial string: a {en,ja} value uses the JA
 *  side; a legacy English-only string falls back to a date range derived from
 *  the race dates; and when no dates are available, the JA-safe fallback
 *  (「今週末」) — never the raw English label. */
export function resolveWeekendLabel(input: WeekendInput, loc: ReportLocale): string {
  const v = input.weekend_label;
  if (typeof v !== "string") {
    if (loc === "en") return v.en;
    return v.ja ?? JA_WEEKEND_LABEL_FALLBACK;
  }
  if (loc === "en") return v;
  return jaWeekendRange(input.races) ?? JA_WEEKEND_LABEL_FALLBACK;
}

/** Resolve the edition label for a locale. A {en,ja} value picks the side; a
 *  legacy English-only string is shown in EN, and in JA falls back to the
 *  localized default edition label (金曜版 / 土曜更新). */
export function resolveEditionLabel(input: WeekendInput, loc: ReportLocale): string {
  const v = input.edition_label;
  if (v != null && typeof v !== "string") return v[loc] ?? defaultEditionLabel(input.version, loc);
  if (v != null && loc === "en") return v;
  return defaultEditionLabel(input.version, loc);
}

/** Derive a JA date-range label ("2026年6月27–28日") from the race dates.
 *  Null when there are no usable dates (caller falls back to the raw label). */
function jaWeekendRange(races: RaceInput[]): string | null {
  const days = races
    .map((r) => r.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  if (days.length === 0) return null;
  const min = days[0];
  const max = days[days.length - 1];
  const [yyMin, mmMin, ddMin] = min.split("-");
  const [yyMax, mmMax, ddMax] = max.split("-");
  const n = (s: string) => Number(s);
  if (min === max) return `${yyMin}年${n(mmMin)}月${n(ddMin)}日`;
  if (yyMin === yyMax && mmMin === mmMax) {
    return `${yyMin}年${n(mmMin)}月${n(ddMin)}–${n(ddMax)}日`;
  }
  return `${yyMin}年${n(mmMin)}月${n(ddMin)}日–${yyMax}年${n(mmMax)}月${n(ddMax)}日`;
}

// ---------------------------------------------------------------------------
// The generator itself.
// ---------------------------------------------------------------------------

export interface GenerateReportOptions {
  /** Output locale. Defaults to "en". English prose templates are unchanged
   *  from pre-locale, except Research is single-language now (no "English /
   *  日本語" name pair) — so EN output is NOT byte-identical to the pre-locale
   *  generator. */
  locale?: ReportLocale;
  /** Optional narrative provider (AI seam). Defaults to the locale's
   *  deterministic provider. */
  provider?: NarrativeProvider;
}

export function generateReport(
  input: WeekendInput,
  opts: GenerateReportOptions = {},
): WeeklyReport {
  const loc = opts.locale ?? "en";
  const provider = opts.provider ?? deterministicNarrativeFor(loc);
  const P = PROSE[loc];
  const fr = freshness(input);
  const ordered = [...input.races].sort(gradeOrder);
  const deep_dives: RaceDeepDive[] = ordered.map((race) => {
    const groups = contenderGroups(race, loc);
    const tickets = ticketNotes(race, loc);
    const diveSansWhy: Omit<RaceDeepDive, "why_this_race_matters"> = {
      race_id: race.race_id,
      name: raceName(race.name, race.name_ja, loc),
      name_ja: race.name_ja ?? "",
      grade: race.grade,
      snapshot: {
        field_size: race.field_size ?? race.runners.length,
        post_time: race.post_time,
        surface: race.surface,
        distance_m: race.distance_m,
        going: goingLabel(race.going, loc),
        weather: weatherLabel(race.weather, loc),
        has_live_odds: race.runners.some((r) => r.win_odds != null && r.win_odds > 0),
        has_gates: race.runners.some((r) => r.gate != null),
      },
      market_shape: marketShape(race, loc).label,
      gate_draw_impact: gateDrawImpact(race, loc),
      pace_map: paceMap(race, loc),
      contender_groups: groups,
      trend_analysis: trendAnalysis(race, loc),
      ticket_notes: tickets,
    };
    return {
      ...diveSansWhy,
      why_this_race_matters: sanitizeNarrative(provider.raceWhy(race, diveSansWhy)),
    };
  });

  const glance = ordered.map((r) => glanceRow(r, loc));
  const watchlist = buildWatchlist(input, loc);
  const lens = buildTicketLens(input, deep_dives, loc);

  const sansHeadline = {
    edition_key: input.edition_key,
    version: input.version,
    edition_label: resolveEditionLabel(input, loc),
    weekend_label: resolveWeekendLabel(input, loc),
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
    not_advice_reminder: P.notAdvice,
  };
}

/** Grade ordering for display: G1 first, then G2, then G3. */
export function gradeOrder(a: RaceInput, b: RaceInput): number {
  const rank: Record<Grade, number> = { G1: 0, G2: 1, G3: 2 };
  const d = rank[a.grade] - rank[b.grade];
  if (d !== 0) return d;
  return (a.date || "").localeCompare(b.date || "") || a.post_time.localeCompare(b.post_time);
}
