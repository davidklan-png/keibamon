// ============================================================================
// Weekly report — locale prose + controlled-vocabulary token maps.
//
// This is the dedicated locale/template module for generated report copy
// (requirement: "Create a dedicated locale/template module for report prose,
// rather than putting dynamic narrative templates into i18n/en.ts and ja.ts").
// The i18n dictionaries hold STATIC UI labels (headings, chips, buttons); the
// DYNAMIC narrative the generator builds lives here, so the generator stays a
// thin, logic-only orchestrator and the prose is reviewable in one place.
//
// PURE: no React, no useI18n, no Date.now()/Math.random(). Every export is a
// deterministic function of its arguments. Same args → byte-identical string,
// in both locales. The generator (weeklyReport.ts) reads from PROSE[loc];
// HorseDrillView reuses the controlled-token helpers (surfaceLabel/styleLabel).
//
// Guardrails carry over identically in both languages: every string is
// recreational research framing, never betting advice. The English banned-phrase
// regexes (lib/guardrails) scan both locales — Japanese prose contains no
// English edge/advice wording, so it passes by construction, and the JA report
// is additionally scanned by weeklyReport.test.ts.
//
// No runtime dependency on weeklyReport.ts: only TYPE imports (ReportLocale,
// Surface, StyleSignal, TrendSignal), which are erased at compile time. The
// generator imports PROSE + the token helpers from here at runtime; this module
// never imports a value from weeklyReport, so there is no module cycle.
// ============================================================================

import type {
  ReportLocale,
  Surface,
  StyleSignal,
  TrendSignal,
} from "./weeklyReport";

// ---------------------------------------------------------------------------
// Bilingual editorial value — the free-text data contract (ADR-0020).
//
// Free-text editorial fields (notes, trend_tags, weekend_label, edition_label)
// and externally-supplied non-enum values (going, weather) may be EITHER:
//   - a legacy raw string (English-only, as published today), OR
//   - an explicit { en, ja } pair.
//
// `tx()` resolves a value for a locale under the documented legacy policy:
//   - { en, ja }  → the requested side (the bilingual source of truth).
//   - raw string  → returned as-is in EN; in JA it returns null so the caller
//                  can OMIT it (we never silently show English editorial prose
//                  in a Japanese report — see resolveTextOrNull callers). This
//                  is the "omit until a Japanese value exists" fallback.
//
// Callers that have a Japanese-safe structural fallback (a date range derived
// from race dates, a localized default label, a controlled-vocabulary map) compose
// `tx()` with that fallback rather than omitting. The exact fields and their
// fallbacks are listed in the task report.
// ---------------------------------------------------------------------------

export interface LocalizedPair {
  en: string;
  ja: string;
}
export type LocalizedText = string | LocalizedPair;

/** Resolve a localized value; null means "no value for this locale" (legacy
 *  English-only string in JA mode → caller omits or supplies a fallback). */
export function tx(value: LocalizedText | null | undefined, loc: ReportLocale): string | null {
  if (value == null) return null;
  if (typeof value === "string") return loc === "en" ? value : null;
  return value[loc] ?? null;
}

// ---------------------------------------------------------------------------
// Controlled-vocabulary token maps. These tokens ARE enums (Surface, StyleSignal,
// TrendSignal) or effectively-controlled JRA vocabulary (going/weather). For the
// controlled enums the JA side is fixed; for going/weather a small map covers the
// standard JRA condition tokens, and anything unknown resolves via tx() (legacy
// English-only → omit in JA, shown in EN). Names and numeric data are never
// altered — only these controlled tokens are translated.
// ---------------------------------------------------------------------------

const SURFACE: Record<Surface, LocalizedPair> = {
  turf: { en: "turf", ja: "芝" },
  dirt: { en: "dirt", ja: "ダート" },
};
export function surfaceLabel(s: Surface, loc: ReportLocale): string {
  return SURFACE[s][loc];
}

// Style tokens align with the bilingual glossary (data/glossary.ts): 逃げ/先行/
// 差し/追込. The "unknown" bucket is the not-yet-declared placeholder.
const STYLE: Record<StyleSignal, LocalizedPair> = {
  front: { en: "front-runner", ja: "逃げ" },
  presser: { en: "presser", ja: "先行" },
  stalker: { en: "stalker", ja: "差し" },
  closer: { en: "closer", ja: "追込" },
  unknown: { en: "style not yet declared", ja: "脚質未確定" },
};
export function styleToken(s: StyleSignal, loc: ReportLocale): string {
  return STYLE[s][loc];
}

// Loose string-keyed lookups for backend-supplied tokens that arrive as raw
// strings (HorseDrillView's by_surface / style_profile / recent_finishes).
// Unlike surfaceLabel/styleToken (which take the controlled enum), these accept
// any string, match known EN or JA inputs bidirectionally, and PASS THROUGH
// anything unrecognized — names and numeric data are never altered, only the
// known controlled tokens are translated (requirement: "Localize controlled
// values such as surface and running-style tokens; preserve names and numeric
// data").
const SURFACE_TOKENS: Record<string, LocalizedPair> = {
  turf: SURFACE.turf,
  grass: SURFACE.turf,
  芝: SURFACE.turf,
  dirt: SURFACE.dirt,
  sand: SURFACE.dirt,
  ダート: SURFACE.dirt,
};
const STYLE_TOKENS: Record<string, LocalizedPair> = {
  front: STYLE.front,
  runner: STYLE.front,
  逃げ: STYLE.front,
  presser: STYLE.presser,
  先行: STYLE.presser,
  stalker: STYLE.stalker,
  差し: STYLE.stalker,
  closer: STYLE.closer,
  追込: STYLE.closer,
  追い込み: STYLE.closer,
};
export function surfaceToken(v: string | null | undefined, loc: ReportLocale): string {
  if (!v) return "";
  return SURFACE_TOKENS[v.toLowerCase()]?.[loc] ?? v;
}
export function styleTokenOf(v: string | null | undefined, loc: ReportLocale): string {
  if (!v) return "";
  return STYLE_TOKENS[v.toLowerCase()]?.[loc] ?? v;
}

const TREND_SIGNAL: Record<TrendSignal, LocalizedPair> = {
  firming: { en: "firming", ja: "人気上昇" },
  drifting: { en: "drifting", ja: "人気下降" },
  steady: { en: "steady", ja: "横ばい" },
  unknown: { en: "—", ja: "—" },
};
export function trendSignalLabel(s: TrendSignal, loc: ReportLocale): string {
  return TREND_SIGNAL[s][loc];
}

// JRA-standard going (馬場状態) + weather tokens. The publisher ships raw
// English strings ("good"/"firm"/"cloudy"/...); these are effectively a
// controlled vocabulary even though RaceInput.going is typed string. The map
// covers the standard set; an unrecognized token falls through to tx() so a
// legacy English-only value is shown in EN and omitted in JA.
const GOING: Record<string, LocalizedPair> = {
  firm: { en: "firm", ja: "良" },
  good: { en: "good", ja: "良" },
  "good to soft": { en: "good-to-soft", ja: "稍重" },
  yielding: { en: "yielding", ja: "稍重" },
  soft: { en: "soft", ja: "重" },
  heavy: { en: "heavy", ja: "不良" },
};
const WEATHER: Record<string, LocalizedPair> = {
  fine: { en: "fine", ja: "晴" },
  sunny: { en: "sunny", ja: "晴" },
  cloudy: { en: "cloudy", ja: "曇" },
  rain: { en: "rain", ja: "雨" },
  "light rain": { en: "light rain", ja: "小雨" },
  snow: { en: "snow", ja: "雪" },
};

/** A controlled going token, or null if the supplied value isn't recognized
 *  (caller then treats it as legacy free-text via tx). */
export function goingLabel(
  v: LocalizedText | null | undefined,
  loc: ReportLocale,
): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return v[loc] ?? null;
  const known = GOING[v.toLowerCase()];
  if (known) return known[loc];
  return loc === "en" ? v : null;
}
export function weatherLabel(
  v: LocalizedText | null | undefined,
  loc: ReportLocale,
): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return v[loc] ?? null;
  const known = WEATHER[v.toLowerCase()];
  if (known) return known[loc];
  return loc === "en" ? v : null;
}

// ---------------------------------------------------------------------------
// Name + odds formatters. Race/venue have an explicit {name, name_ja} pair on
// the input; horse names are proper nouns supplied as a single string (Japanese
// in real data) and are shown verbatim in both locales.
// ---------------------------------------------------------------------------

export function raceName(name: string, nameJa: string | undefined, loc: ReportLocale): string {
  return loc === "ja" ? nameJa || name : name;
}
export function venueName(venue: string, venueJa: string | undefined, loc: ReportLocale): string {
  return loc === "ja" ? venueJa || venue : venue;
}

/** Odds prefix: "~3.2" (en) / "約3.2倍" (ja). */
export function fmtOdds(o: number, loc: ReportLocale): string {
  return loc === "ja" ? `約${o.toFixed(1)}倍` : `~${o.toFixed(1)}`;
}

/** JA-safe weekend-label fallback. Used when a weekend label is a legacy
 *  English-only string AND no race dates exist to derive a JA date range from.
 *  This is the last-resort JA value — it must NEVER be the English editorial
 *  string (the "never show English editorial prose in JA" rule). */
export const JA_WEEKEND_LABEL_FALLBACK = "今週末";

// ---------------------------------------------------------------------------
// ReportProse — every English-producing template in the generator, with an EN
// and a JA implementation. Functions take PRIMITIVE args (the generator does the
// logic; this module only turns results into copy), so the prose is reviewable
// without reading the generator's branching.
// ---------------------------------------------------------------------------

export interface ReportProse {
  // -- deterministic narrative (headline / why / themes) ------------------
  weekendHeadlineNoG1: (weekendLabel: string, featureCount: number) => string;
  weekendHeadlineG1: (
    weekendLabel: string,
    raceName: string,
    marketShape: string,
    favName: string | null,
    favNo: number | null,
  ) => string;
  raceWhy: (
    raceName: string,
    distanceM: number,
    surface: string,
    gradeTier: string,
  ) => string;
  gradeTier: (g: "G1" | "G2" | "G3") => string;
  themeFragile: (n: number) => string;
  themeBigField: (n: number) => string;
  themeDirt: (n: number) => string;
  themeBalanced: string;

  // -- market shape -------------------------------------------------------
  marketUnpriced: string;
  marketDominant: (favName: string, pct: string) => string;
  marketConcentrated: (pct: string) => string;
  marketOpen: (pct: string) => string;
  marketBalanced: (pct: string) => string;

  // -- pace map -----------------------------------------------------------
  paceNotDeclared: string;
  paceHot: (front: number, pressers: number, stalkers: number, closers: number) => string;
  paceSoft: (front: number) => string;
  paceEven: (front: number, pressers: number, stalkers: number, closers: number) => string;

  // -- gate / draw impact -------------------------------------------------
  gateNotPublished: string;
  gateDirtInside: (favs: string) => string;
  gateDirtBalanced: (favs: string) => string;
  gateBigWide: (favs: string, threshold: number) => string;
  gateTurfInside: (favs: string) => string;
  gateTurfEven: (favs: string) => string;
  /** One favorite in the gate-impact list: "Name (No.4, gate 5)". */
  gateFav: (name: string, horseNo: number, gate: number | null) => string;
  gateFavJoiner: string;
  gateNoFavs: string;

  // -- contender reasons --------------------------------------------------
  styleLabel: Record<StyleSignal, string>;
  trendLabel: Record<Exclude<TrendSignal, "unknown">, string>;
  drawClause: (gate: number, fieldSize: number) => string | null;
  coreLead: (o: number, rank: number) => string;
  priceLead: (o: number) => string;
  chaosLead: (o: number) => string;
  fragileCloserBit: string;
  fragileOutsideBit: string;
  fragileClassRiseBit: string;
  fragileLayoffBit: string;
  fragileDriftBit: string;
  fragileComposed: (bits: string[]) => string;
  fragileEmpty: string;
  fragileAlsoCore: string;
  unpricedLead: string;
  /** Compose a lead clause + detail clauses into one localized sentence. */
  joinClauses: (lead: string, clauses: Array<string | null>) => string;

  // -- ticket notes -------------------------------------------------------
  ticketSafeishShape: (names: string) => string;
  ticketSafeishShapeFallback: string;
  ticketSafeishCost: string;
  ticketSafeishRationale: string;
  ticketSafeishRisk: string;
  ticketBalancedShape: (core: string, price: string | null) => string;
  ticketBalancedShapeFallback: string;
  ticketBalancedCost: string;
  ticketBalancedRationale: string;
  ticketBalancedRisk: string;
  ticketSpicyShape: (core: string, mix: string) => string;
  ticketSpicyShapeFallback: string;
  ticketSpicyCost: string;
  ticketSpicyRationale: string;
  ticketSpicyRisk: string;

  // -- trend analysis -----------------------------------------------------
  trendTagLine: (tag: string, n: number) => string;
  editorNoteLine: (note: string) => string;
  fragilityLine: (n: number) => string;
  trendEmpty: string;

  // -- glance -------------------------------------------------------------
  glanceGoingWatch: (going: string | null, weather: string | null) => string;
  glanceGoingWatchEmpty: string;
  glanceDrawPending: string;
  glanceDrawSet: string;
  glanceDrawLine: (name: string, gate: number | null) => string;
  glanceDrawJoiner: string;

  // -- watchlist ----------------------------------------------------------
  watchFirming: (priced: string) => string;
  watchDrifting: (priced: string) => string;
  watchSteady: (priced: string) => string;
  watchPriced: (o: number) => string;

  // -- ticket lens --------------------------------------------------------
  lensSafeish: (pct: string) => string;
  lensBalanced: (pct: string) => string;
  lensLongshot: (field: number) => string;
  lensFragile: string;
  lensSimplify: (field: number) => string;

  // -- edition + disclaimer ----------------------------------------------
  editionLabelFriday: string;
  editionLabelSaturday: (version: number) => string;
  notAdvice: string;
}

// ---------------------------------------------------------------------------
// ENGLISH pack — the historical prose templates (market/pace/gate/contender/
// ticket/watchlist/lens), unchanged from the pre-locale generator so the
// existing EN assertions stay green. NOTE: English OUTPUT is not byte-identical
// to pre-locale — Research is single-language now, so weekendHeadline + raceWhy
// no longer append the "English / 日本語" name pair (English shows the English
// name only). The pair removal is the sole EN wording change.
// ---------------------------------------------------------------------------

const EN: ReportProse = {
  weekendHeadlineNoG1: (wl, n) =>
    `${wl}: a graded-stakes weekend with ${n} feature races.`,
  weekendHeadlineG1: (wl, name, shape, favName, favNo) =>
    `${wl}: the ${name} anchors the weekend. ${shape}${favName && favNo != null ? ` Early market attention centers on ${favName} (No.${favNo}).` : ""}`,
  raceWhy: (name, dist, surface, tier) =>
    `${name} is a ${dist} m ${surface} ${tier} contest. This section frames the market signal, draw, pace, and ticket-shape context — research framing, not a recommendation.`,
  gradeTier: (g) =>
    g === "G1"
      ? "championship-tier"
      : g === "G2"
        ? "prestige tier just below the championship"
        : "graded stakes, a wide-open shape",
  themeFragile: (n) =>
    `Fragile-favorite watch: ${n} feature ${n === 1 ? "race has" : "races have"} a short-priced runner carrying a question mark — a pace or draw angle that could reshape the exotic shape.`,
  themeBigField: (n) =>
    `Big-field variance: ${n} ${n === 1 ? "race" : "races"} with 16+ runners widens the trifecta space and raises variance.`,
  themeDirt: (n) =>
    `Dirt draw in play: ${n} ${n === 1 ? "dirt race is" : "dirt races are"} on the card — inside draws tend to matter more on the sand.`,
  themeBalanced:
    "Balanced weekend: no single theme dominates — read each race on its own market and shape.",

  marketUnpriced: "Market not yet priced — estimates only.",
  marketDominant: (name, pct) =>
    `Dominant favorite shape — ${name} carries ~${pct} of the devigged win chance; the rest fight for place money.`,
  marketConcentrated: (pct) =>
    `Concentrated at the top — the first three absorb ~${pct} of the devigged chance; a chalky exotic base.`,
  marketOpen: (pct) =>
    `Open, wide-open shape — the market spreads the chance out (top three ~${pct}); higher variance, richer exotics possible.`,
  marketBalanced: (pct) =>
    `Balanced shape — a clear favorite with real depth behind (top three ~${pct}); workable for several ticket shapes.`,

  paceNotDeclared:
    "Running styles not yet declared — pace read opens up once the roster firms.",
  paceHot: (front, pressers, stalkers, closers) =>
    `Hot pace read: ${front} confirmed front-runners + ${pressers} pressers should cook the early fractions — a setup that can favor a stalker/closer (${stalkers}/${closers} on the card).`,
  paceSoft: (front) =>
    `Soft pace read: ${front} lone front-runner candidate — an unchallenged leader could steal it cheaply, compressing the exotic.`,
  paceEven: (front, pressers, stalkers, closers) =>
    `Even pace read: ${front} front-runner(s), ${pressers} presser(s), ${stalkers} stalker(s), ${closers} closer(s) — fractions look genuinely contested.`,

  gateNotPublished:
    "Draw not yet published — gate-impact read opens Friday once post positions are set.",
  gateDirtInside: (favs) =>
    `Dirt draw leans inside — ${favs} drawn 1–3, where the sand tends to travel. Favors racing on the rail.`,
  gateDirtBalanced: (favs) =>
    `Dirt draw looks balanced — no heavy inside concentration among the favorites (${favs}).`,
  gateBigWide: (favs, threshold) =>
    `Big-field turf draw watch — ${favs} are drawn wide (≥${threshold}); losing ground into the first bend is a real cost on the swing for home.`,
  gateTurfInside: (favs) =>
    `Turf draw favors the inner posts here — ${favs} drawn 1–3, saving ground into the first turn.`,
  gateTurfEven: (favs) =>
    `Turf draw looks even-handed — the favorites (${favs}) land in the middle of the gate, no obvious draw tax.`,
  gateFav: (name, no, gate) => `${name} (No.${no}, gate ${gate ?? "—"})`,
  gateFavJoiner: "; ",
  gateNoFavs: "no favorites priced",

  styleLabel: {
    front: "front-running profile",
    presser: "rides close to the pace",
    stalker: "stalks mid-pack",
    closer: "needs a setup to close",
    unknown: "style not yet declared",
  },
  trendLabel: {
    firming: "odds firming through the week — market support building",
    drifting: "drifting out in the betting — support has been thin",
    steady: "price has held steady since first quoted",
  },
  drawClause: (gate, fieldSize) => {
    if (gate <= 2) return `drawn ${gate}, on the rail`;
    if (gate <= 4) return `drawn ${gate}, an inside post`;
    if (fieldSize > 0 && gate >= fieldSize - 1)
      return `drawn ${gate}, the widest post in the field`;
    if (fieldSize > 0 && gate >= fieldSize - 3) return `drawn ${gate}, out wide`;
    return null;
  },
  coreLead: (o, rank) =>
    rank === 0
      ? `~${o.toFixed(1)} — the market's clear top choice here`
      : rank === 1
        ? `~${o.toFixed(1)} — sits right with the leader, not far off at the top of the market`
        : `~${o.toFixed(1)} — still inside the market's top tier`,
  priceLead: (o) =>
    o <= 10
      ? `~${o.toFixed(1)} — just off the core tier, the first price angle worth a look`
      : o <= 15
        ? `~${o.toFixed(1)} — a mid-price runner, squarely in exotic-spicing territory`
        : `~${o.toFixed(1)} — near the top of the double-digit range, the last price step before chaos territory`,
  chaosLead: (o) =>
    o < 30
      ? `~${o.toFixed(1)} — a longshot, live enough to matter in a wide exotic`
      : o < 60
        ? `~${o.toFixed(1)} — a deep outsider, mostly here to widen the combinations`
        : `~${o.toFixed(1)} — about as long as they come, a rank outsider`,
  fragileCloserBit: "needs pace to close into",
  fragileOutsideBit: "drawn outside",
  fragileClassRiseBit: "rising in class",
  fragileLayoffBit: "coming off a layoff",
  fragileDriftBit: "drifting out in the betting despite the short price",
  fragileComposed: (bits) =>
    `Short-priced but ${bits.join(", ")} — a question mark on the bridge.`,
  fragileEmpty:
    "Short-priced with a flagged weakness — fragile at the head of the market.",
  fragileAlsoCore: " Also a core price.",
  unpricedLead: "Unpriced — pool not open or no estimate yet",
  joinClauses: (lead, clauses) => {
    const present = clauses.filter((c): c is string => !!c);
    return present.length ? `${lead}; ${present.join("; ")}.` : `${lead}.`;
  },

  ticketSafeishShape: (names) => `Quinella/wide on the top 2 (${names}).`,
  ticketSafeishShapeFallback: "Quinella on the clear favorites once priced.",
  ticketSafeishCost: "Low combo count — smaller outlay.",
  ticketSafeishRationale:
    "Tightest shape: concentrates on the market leaders, fewer combinations.",
  ticketSafeishRisk:
    "Low hit-rate variance, modest payout — the takeout is still in the pool.",
  ticketBalancedShape: (core, price) =>
    `Trio boxed around ${core}${price ? ` + ${price} as a price` : ""}.`,
  ticketBalancedShapeFallback: "Trio around the leading three once the field firms.",
  ticketBalancedCost: "Medium combo count.",
  ticketBalancedRationale:
    "Keeps the leaders and adds a price angle — a real shot with fun upside.",
  ticketBalancedRisk: "Misses when a complete outsider runs into the frame.",
  ticketSpicyShape: (core, mix) =>
    `Trifecta keying ${core} up front, weaving in ${mix} underneath.`,
  ticketSpicyShapeFallback: "Trifecta weaving in the longshots underneath.",
  ticketSpicyCost: "High combo count — larger outlay to cover the spread.",
  ticketSpicyRationale:
    "Embraces chaos — leans into the variance a big exotic payout needs.",
  ticketSpicyRisk:
    "High variance — misses often, pays well when the shape breaks open.",

  trendTagLine: (tag, n) =>
    `Trend — "${tag}": appears on ${n} runner${n === 1 ? "" : "s"} in this field.`,
  editorNoteLine: (note) => `Editor note — ${note}`,
  fragilityLine: (n) =>
    `Fragility flag — ${n} short-priced runner${n === 1 ? "" : "s"} carrying a structural question (see fragile-favorites group).`,
  trendEmpty:
    "No notable trend tags this round — read the race on market and shape alone.",

  glanceGoingWatch: (going, weather) =>
    [going && `going ${going}`, weather && `${weather}`].filter(Boolean).join(", "),
  glanceGoingWatchEmpty: "Going/weather not yet posted.",
  glanceDrawPending: "Draw pending.",
  glanceDrawSet: "Draw set.",
  glanceDrawLine: (name, gate) => `${name} gate ${gate ?? "—"}`,
  glanceDrawJoiner: "; ",

  watchFirming: (priced) =>
    `Shortening${priced} — money coming for this runner across the snapshots.`,
  watchDrifting: (priced) =>
    `Lengthening${priced} — easing away across the snapshots.`,
  watchSteady: (priced) => `Steady${priced} — holding in line across the snapshots.`,
  watchPriced: (o) => ` ~${o.toFixed(1)}`,

  lensSafeish: (pct) =>
    `Chalkiest shape of the weekend (top-three ~${pct} of the devigged chance) — the lowest-variance exotic base.`,
  lensBalanced: (pct) =>
    `Clear favorite with real depth behind — a workable trio/trifecta shape (~${pct} on the top three).`,
  lensLongshot: (field) =>
    `Biggest field (${field}) with the widest spread — the variance a longshot hunter wants.`,
  lensFragile:
    "Carries the most flagged fragile-favorite weight this weekend — the bridge most worth questioning.",
  lensSimplify: (field) =>
    `Smallest field (${field}) and tightest shape — least moving parts if you want to keep a ticket simple.`,

  editionLabelFriday: "Friday edition",
  editionLabelSaturday: (version) => `Saturday refresh (v${version})`,
  notAdvice:
    "Recreational research only. Not betting advice, not a winning method, not a profit guarantee. Pool takeout applies to every ticket.",
};

// ---------------------------------------------------------------------------
// JAPANESE pack. Natural keiba-research prose; controlled tokens align with the
// bilingual glossary. Research-only framing preserved (推奨ではない / 投資助言ではない
// / 控除率). Horse + jockey proper names and all numeric data pass through
// verbatim; only controlled vocabulary and sentence templates are translated.
// ---------------------------------------------------------------------------

const JA: ReportProse = {
  weekendHeadlineNoG1: (wl, n) =>
    `${wl}：重賞ウィークエンド、注目レース${n}戦。`,
  weekendHeadlineG1: (wl, name, shape, favName, favNo) =>
    `${wl}：${name}が今週末の軸。${shape}${favName && favNo != null ? ` 市場の関心は早々に${favName}（${favNo}番）に集まっている。` : ""}`,
  raceWhy: (name, dist, surface, tier) =>
    `${name}は${dist}m・${surface}の${tier}一戦。ここでは市場シグナル・枠順・ペース・馬券の形の文脈を整理する — リサーチのための視座であり、推奨ではない。`,
  gradeTier: (g) =>
    g === "G1"
      ? "チャンピオン級"
      : g === "G2"
        ? "チャンピオンの一つ下の格付け"
        : "重賞・大混戦の傾向",
  themeFragile: (n) =>
    `脆い人気馬ウォッチ：注目${n}戦に、低オッズながら不安を抱える馬がいる — ペースや枠順が馬券の形を変える余地になる。`,
  themeBigField: (n) =>
    `大頭数の分散：16頭以上のレースが${n}戦あり、3連単の組み合わせ空間が広がり分散が高まる。`,
  themeDirt: (n) =>
    `ダートの枠順が効く：カードにダート戦が${n}戦ある — 砂の馬場では内枠がより有利になる傾向がある。`,
  themeBalanced:
    "均衡のとれたウィークエンド：ひとつのテーマが独占しない — 各レースはそれぞれの市場と形で読んでください。",

  marketUnpriced: "市場はまだ未発売 — 想定オッズのみ。",
  marketDominant: (name, pct) =>
    `${name}が還元勝率の〜${pct}を占める圧倒的人気の形 — 残りは着内争い。`,
  marketConcentrated: (pct) =>
    `上位集中 — 上位3頭で還元率の〜${pct}を占める — 堅く組みやすい馬券の地盤。`,
  marketOpen: (pct) =>
    `広く分散した形 — 市場は勝率を散らしている（上位3頭で〜${pct}） — 分散が高く、馬券の上振れが見込める。`,
  marketBalanced: (pct) =>
    `均衡した形 — 明確な本命とその後ろの厚み（上位3頭で〜${pct}） — 複数の馬券の形に対応できる。`,

  paceNotDeclared: "脚質はまだ確定していません — 出走馬が固まればペース読みが立ちます。",
  paceHot: (front, pressers, stalkers, closers) =>
    `速いペースの読み：逃げ${front}頭＋先行${pressers}頭が前半のペースを引き上げそう — 差し・追込（差し${stalkers}・追込${closers}）に向く展開になる余地がある。`,
  paceSoft: (front) =>
    `遅いペースの読み：逃げ馬は${front}頭のみ — 無理なく先頭に立てば安く逃げ切り、馬券を圧縮しかねない。`,
  paceEven: (front, pressers, stalkers, closers) =>
    `均衡ペースの読み：逃げ${front}・先行${pressers}・差し${stalkers}・追込${closers} — ペースは真正面から争われそう。`,

  gateNotPublished: "枠順はまだ発表されていません — 確定次第、枠順の影響読みが立ちます。",
  gateDirtInside: (favs) =>
    `ダートは内枠寄り — ${favs}が1〜3番に入っており、砂の馬場は内を回るのが有利。`,
  gateDirtBalanced: (favs) =>
    `ダートの枠順は均衡 — 人気馬（${favs}）に内寄りの偏りはない。`,
  gateBigWide: (favs, threshold) =>
    `大頭数の芝・外枠警戒 — ${favs}が外枠（${threshold}番以降） — 第1コーナーまでのロスは直線の勝負で響く。`,
  gateTurfInside: (favs) =>
    `芝は内枠有利 — ${favs}が1〜3番に入っており、第1コーナーまでの距離を稼げる。`,
  gateTurfEven: (favs) =>
    `芝の枠順は平坦 — 人気馬（${favs}）は中枠に収まり、明確な枠順のハンデはない。`,
  gateFav: (name, no, gate) => `${name}（${no}番・${gate ?? "—"}番手）`,
  gateFavJoiner: "／",
  gateNoFavs: "オッズ成立の人気馬なし",

  styleLabel: {
    front: "逃げ脚質",
    presser: "先行",
    stalker: "差し",
    closer: "追込",
    unknown: "脚質未確定",
  },
  trendLabel: {
    firming: "オッズは週間で締まっている — 支持が集まっている",
    drifting: "オッズは流れている — 支持が薄い",
    steady: "初回提示から安定",
  },
  drawClause: (gate, fieldSize) => {
    if (gate <= 2) return `${gate}番・最内`;
    if (gate <= 4) return `${gate}番・内枠`;
    if (fieldSize > 0 && gate >= fieldSize - 1) return `${gate}番・大外`;
    if (fieldSize > 0 && gate >= fieldSize - 3) return `${gate}番・外枠`;
    return null;
  },
  coreLead: (o, rank) =>
    rank === 0
      ? `約${o.toFixed(1)}倍 — 市場の明確な筆頭`
      : rank === 1
        ? `約${o.toFixed(1)}倍 — 筆頭に肉薄、市場の最上位のすぐそば`
        : `約${o.toFixed(1)}倍 — 市場の最上位圏内`,
  priceLead: (o) =>
    o <= 10
      ? `約${o.toFixed(1)}倍 — 中心勢のすぐ外、まずは一つの穴として見どころ`
      : o <= 15
        ? `約${o.toFixed(1)}倍 — 中穴、馬券を厚くする絶好の位置`
        : `約${o.toFixed(1)}倍 — 二桁の上振れ、カオス手前の最後の段`,
  chaosLead: (o) =>
    o < 30
      ? `約${o.toFixed(1)}倍 — 大穴、広い馬券に絡む余地はある`
      : o < 60
        ? `約${o.toFixed(1)}倍 — 深い人気薄、主に組み合わせを広げる役`
        : `約${o.toFixed(1)}倍 — これ以上ないほどの人気薄、完全なアウトサイダー`,
  fragileCloserBit: "追込で展開が必要",
  fragileOutsideBit: "外枠",
  fragileClassRiseBit: "クラス昇級",
  fragileLayoffBit: "久々",
  fragileDriftBit: "低オッズながらオッズは流れている",
  fragileComposed: (bits) => `低オッズだが${bits.join("・")} — 橋の上の疑問符。`,
  fragileEmpty: "低オッズで不安フラグあり — 人気の先頭で脆い。",
  fragileAlsoCore: " 中心勢でもある。",
  unpricedLead: "未発売 — プール未開設または想定なし",
  joinClauses: (lead, clauses) => {
    const present = clauses.filter((c): c is string => !!c);
    return present.length ? `${lead}。${present.join("。")}。` : `${lead}。`;
  },

  ticketSafeishShape: (names) => `上位2頭（${names}）の馬連／ワイド。`,
  ticketSafeishShapeFallback: "オッズ確定後、明確な人気馬で馬連。",
  ticketSafeishCost: "組み合わせ少なめ — 投資は小さく。",
  ticketSafeishRationale: "最も堅い形 — 人気層に集中し、組み合わせを減らす。",
  ticketSafeishRisk: "的中率の分散は低く配当も控えめ — 控除率はプールに残る。",
  ticketBalancedShape: (core, price) =>
    `${core}を軸に3連複ボックス${price ? ` ＋穴${price}` : ""}。`,
  ticketBalancedShapeFallback: "出走馬が固まれば、上位3頭で3連複。",
  ticketBalancedCost: "組み合わせは中程度。",
  ticketBalancedRationale: "本命層を残しつつ穴を一枚 — 現実ラインと楽しさ。",
  ticketBalancedRisk: "完全な人気薄が紛れ込むと崩れる。",
  ticketSpicyShape: (core, mix) => `${core}を表に、${mix}を裏に織り込む3連単。`,
  ticketSpicyShapeFallback: "大穴を裏に織り込む3連単。",
  ticketSpicyCost: "組み合わせ多め — 上振れを覆うため投資は大きく。",
  ticketSpicyRationale: "カオスを受け入れる — 大きな配当に必要な分散に寄せる。",
  ticketSpicyRisk: "高分散 — よく外れるが、形が開けば大きく戻る。",

  trendTagLine: (tag, n) => `傾向 —「${tag}」：このフィールドの${n}頭に見られる。`,
  editorNoteLine: (note) => `編集メモ — ${note}`,
  fragilityLine: (n) =>
    `脆さフラグ — 低オッズの馬${n}頭が構造的な疑問を抱える（脆い人気馬グループを参照）。`,
  trendEmpty: "今節は目立った傾向タグなし — 市場と形だけで読んでください。",

  glanceGoingWatch: (going, weather) =>
    [going && `馬場${going}`, weather && `${weather}`].filter(Boolean).join("・"),
  glanceGoingWatchEmpty: "馬場・天候は未発表。",
  glanceDrawPending: "枠順確定前。",
  glanceDrawSet: "枠順確定。",
  glanceDrawLine: (name, gate) => `${name}・枠${gate ?? "—"}`,
  glanceDrawJoiner: "；",

  watchFirming: (priced) => `締まっている${priced} — スナップショット間で支持が集まっている。`,
  watchDrifting: (priced) => `流れている${priced} — スナップショット間で支持が薄れている。`,
  watchSteady: (priced) => `安定${priced} — スナップショット間で横ばい。`,
  watchPriced: (o) => ` 約${o.toFixed(1)}倍`,

  lensSafeish: (pct) =>
    `今週末で最も堅い形（上位3頭で還元率の〜${pct}） — 最も分散の低い馬券の地盤。`,
  lensBalanced: (pct) =>
    `明確な本命と後ろの厚み — 扱いやすい3連複／3連単の形（上位3頭で〜${pct}）。`,
  lensLongshot: (field) => `最大の頭数（${field}頭）で最も広い分散 — 大穴狙いが求める分散。`,
  lensFragile: "今週末で最も脆い人気馬フラグが集中 — 一番疑うべき橋。",
  lensSimplify: (field) =>
    `最小の頭数（${field}頭）で最も堅い形 — 馬券をシンプルに保つなら、動く部品が最も少ない。`,

  editionLabelFriday: "金曜版",
  editionLabelSaturday: (version) => `土曜更新（v${version}）`,
  notAdvice:
    "娯楽目的のリサーチのみ。投資助言ではなく、必勝法でも利益の保証でもありません。すべての馬券に控除率が適用されます。",
};

export const PROSE: Record<ReportLocale, ReportProse> = { en: EN, ja: JA };
