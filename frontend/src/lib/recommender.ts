/**
 * Recommendation engine.
 *
 * Pipeline (matches app_plan §Recommendation Engine Direction):
 *   1. Contender pool: filtered + re-ranked by intuition + flavor.
 *   2. Bet-type candidates per personality + complexity.
 *   3. Per-combo scoring (hit rate, payout shape, crowd exposure, flavor,
 *      intuition bonuses/penalties).
 *   4. Group top combos of each type into a Ticket, with a dominance floor
 *      that drops lines which can't profit solo and rejects tickets whose
 *      best realistic hit can't cover the stake.
 *   5. Return up to 3 tickets, diversified by type.
 *
 * Produces honest, non-dominated recreational structure. The project's own
 * market-baseline research found no public-data edge — so the engine's job
 * is to surface ticket SHAPES that are coherent with the user's read and
 * mathematically able to pay back on their best day, not to promise profit.
 * Wide (multi-win) is handled with true P(≥1) via top-3 enumeration so
 * co-paying pairs aren't overcounted, and the dominance floor forbids the
 * "10-pick wide box that loses money even when it hits" failure mode.
 */

import {
  comboProb,
  evaluateCombos,
  kCombos,
  kPerms,
  rankClass,
  RET,
  wideTicketStats,
  type BetType,
  type Runner,
} from "./fairvalue";
import type {
  PersonalityId,
  RecommendInput,
  StyleState,
  Ticket,
  TicketLine,
  IntuitionState,
  BoxPayload,
  WheelPayload,
  FormationPayload,
} from "./types";
import { applyPersonality } from "./types";

const MAX_BUDGET_LINES = 120;

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function favOrder(p: Record<string, number>, allUmas: string[]): string[] {
  return allUmas
    .filter((u) => (p[u] || 0) > 0)
    .sort((a, b) => (p[b] || 0) - (p[a] || 0));
}

/**
 * Contender pool. Starts from the market's ranked list, slices by flavor,
 * then enforces intuition constraints:
 *   - avoid  → dropped
 *   - anchor → always included
 *   - like   → always included
 *   - priceHorse → always included
 *   - distrust → the favorite is demoted in the sort (not dropped; the user
 *                can still play them, just not as a chalk anchor)
 */
function contenderPool(input: RecommendInput): string[] {
  const { p, allUmas, style, intuition } = input;
  const order = favOrder(p, allUmas);
  const n = order.length;
  if (n === 0) return [];

  // Drop 'avoid' horses outright.
  let pool = order.filter((u) => intuition[u] !== "avoid");

  // Anchor and liked/price horses are forced in.
  const forced = pool.filter(
    (u) =>
      intuition[u] === "anchor" ||
      intuition[u] === "like" ||
      intuition[u] === "priceHorse",
  );

  // Distrust: demote the chalk end. Move any distrust-tagged horse to the
  // back of the contender ordering so they only appear if we need depth.
  const distrusted = new Set(
    Object.entries(intuition)
      .filter(([, v]) => v === "distrust")
      .map(([u]) => u),
  );
  pool = pool.sort((a, b) => {
    const da = distrusted.has(a) ? 1 : 0;
    const db = distrusted.has(b) ? 1 : 0;
    if (da !== db) return da - db;
    return (p[b] || 0) - (p[a] || 0); // stable secondary sort by win prob
  });

  // Flavor slicing on the market-ordered list (NOT the demoted pool).
  const fav = order.slice(0, Math.max(3, Math.ceil(n * 0.28)));
  const mid = order.slice(Math.max(2, Math.ceil(n * 0.2)), Math.max(5, Math.ceil(n * 0.68)));
  const price = order.slice(Math.max(3, Math.ceil(n * 0.42)));
  let flavorPool: string[];
  if (style.flavor === "chalk") {
    flavorPool = unique([...fav, ...mid.slice(0, 2)]).slice(0, 7);
  } else if (style.flavor === "value") {
    flavorPool = unique([...mid, ...price]).slice(0, 8);
  } else {
    flavorPool = unique([
      ...fav.slice(0, 4),
      ...mid.slice(0, 4),
      ...price.slice(0, 2),
    ]).slice(0, 8);
  }

  // Merge with forced, drop avoid (already done but be safe), dedup.
  const merged = unique([...forced, ...flavorPool]).filter(
    (u) => intuition[u] !== "avoid",
  );
  return merged.slice(0, 8);
}

/**
 * Bet types to consider per (personality, complexity).
 * Faithful to helper.html's candidateTypes plus app_plan mapping.
 */
function candidateTypes(style: StyleState): BetType[] {
  const { complexity, personality } = style;
  if (complexity === "two") return ["wide", "quinella", "exacta"];
  if (complexity === "three") return ["trio", "trifecta"];
  if (complexity === "straight") return ["exacta", "trifecta"];
  // auto: personality-driven
  if (personality === "safe") return ["wide", "quinella", "trio"];
  if (personality === "longshot") return ["trio", "exacta", "trifecta"];
  if (personality === "fan") return ["quinella", "trio", "exacta"];
  if (personality === "antiChalk") return ["trio", "quinella", "wide"];
  return ["quinella", "wide", "trio", "exacta"]; // balanced
}

/** How many lines of each type to keep, by personality. */
function linesWanted(type: BetType, p: PersonalityId): number {
  if (type === "trifecta") return p === "longshot" ? 18 : p === "safe" ? 4 : 8;
  if (type === "trio")
    return p === "safe" ? 6 : p === "longshot" ? 14 : 10;
  if (type === "exacta") return p === "safe" ? 5 : 10;
  return p === "safe" ? 6 : 10; // quinella, wide
}

interface ScoredCombo {
  combo: string[];
  prob: number;
  fairOdds: number;
  payout: number; // per current unit
  tag: "chalk" | "value" | "blend";
  score: number;
}

function scoreCombo(
  combo: string[],
  type: BetType,
  prob: number,
  unit: number,
  input: RecommendInput,
): ScoredCombo {
  const { p, allUmas, style, intuition } = input;
  const tag = rankClass(combo, p, allUmas);
  const fairOdds = prob > 0 ? 1 / prob : Infinity;
  const payout = prob > 0 ? (RET[type] / prob) * unit : Infinity;

  // Personality base score.
  const personality = style.personality;
  let score = 0;
  const logFair = Math.log(Math.max(1, fairOdds));
  const longshotMix =
    combo.reduce((s, u) => s + (1 - (p[u] || 0)), 0) / combo.length;

  // Hit-probability weight: safe likes high hit, longshot tolerates low.
  const hitW = personality === "safe" ? 7 : personality === "longshot" ? 1.3 : 4;
  // Payout-shape weight: longshot likes bigger payouts.
  const payW = personality === "longshot" ? 0.95 : personality === "safe" ? 0.08 : 0.35;

  score += prob * hitW;
  score += logFair * payW;

  // Flavor bias.
  if (style.flavor === "value") score += longshotMix * 0.32;
  if (style.flavor === "chalk") score += (1 - longshotMix) * 0.32;

  // Anti-chalk penalizes all-favorite combos.
  if (personality === "antiChalk" && tag === "chalk") score -= 0.55;
  // Chalk penalty for non-safe personalities (helper.html behavior).
  if (tag === "chalk" && personality !== "safe") score -= 0.25;

  // Structural-mix reward for the balanced personality. The earlier scoring
  // (hitW × prob + payW × logFair) naturally bifurcates — high-prob combos
  // win on the hit term, low-prob combos win on the payout term — so the
  // balanced tier collapses to all-favorites (under hitW=4) or all-longshots
  // (under payW=0.35) depending on noise. Genuine balance is structural: a
  // combo that names at least one favorite AND at least one non-favorite
  // anchors the likely outcome while opening real upside. Rewarding that
  // mix at the combo level prevents the tier from drifting to either extreme.
  if (personality === "balanced") {
    const order = favOrder(p, allUmas);
    const favCut = order.slice(0, Math.max(2, Math.ceil(order.length / 3)));
    const favSet = new Set(favCut);
    const hasFav = combo.some((u) => favSet.has(u));
    const hasNonFav = combo.some((u) => !favSet.has(u));
    if (hasFav && hasNonFav) {
      score += 0.45; // reward structural mix
    } else {
      score -= 0.3; // pure chalk / pure value → non-preferred for balanced
    }
  }

  // Intuition bonuses.
  for (const u of combo) {
    const tag = intuition[u];
    if (tag === "like") score += 0.25;
    if (tag === "priceHorse") score += 0.3;
    if (tag === "anchor") score += 0.35;
    if (tag === "distrust") score -= 0.3;
  }
  // Anchor requirement is enforced at contender-pool level; combos that
  // contain the anchor get an extra nudge.
  const anchors = Object.entries(intuition)
    .filter(([, v]) => v === "anchor")
    .map(([u]) => u);
  for (const a of anchors) {
    if (combo.includes(a)) score += 0.15;
  }

  return { combo, prob, fairOdds, payout, tag, score };
}

/**
 * Filter combos by intuition hard constraints:
 *   - avoid  → combo contains an avoided horse: drop
 *   - anchor → if any anchor exists, every combo MUST include it
 *   - priceHorse → if any price slot tagged, at least one combo per ticket
 *                  should include them (enforced loosely via scoring; here
 *                  we just don't drop them)
 */
function satisfiesHardConstraints(
  combo: string[],
  intuition: Record<string, IntuitionState>,
): boolean {
  for (const u of combo) {
    if (intuition[u] === "avoid") return false;
  }
  const anchors = Object.entries(intuition)
    .filter(([, v]) => v === "anchor")
    .map(([u]) => u);
  if (anchors.length > 0) {
    for (const a of anchors) {
      if (!combo.includes(a)) return false;
    }
  }
  return true;
}

/**
 * Best realistic single-race return for a set of priced lines.
 *
 * Non-wide bet types (quinella / exacta / trio / trifecta) are mutually
 * exclusive: at most ONE line wins per race, so the best case is the top
 * single-line payout. Wide is the exception — multiple lines can co-hit
 * (up to C(3,2)=3 pairs when 3 covered horses fill the board) — so we
 * route through wideTicketStats to capture the multi-pay scenario.
 *
 * This is the dominance-floor quantity: a ticket whose best realistic
 * return ≤ cost is structurally doomed and should be rejected/trimmed.
 */
function bestRealisticReturn(
  type: BetType,
  lines: ScoredCombo[],
  p: Record<string, number>,
  allUmas: string[],
): number {
  if (lines.length === 0) return 0;
  if (type === "wide") {
    return wideTicketStats(
      lines.map((l) => ({ combo: l.combo, payout: l.payout })),
      p,
      allUmas,
    ).bestCaseReturn;
  }
  let max = 0;
  for (const l of lines) if (l.payout > max) max = l.payout;
  return max;
}

/** Build a single Ticket for a bet type from its top-ranked combos. */
function buildTicket(
  type: BetType,
  ranked: ScoredCombo[],
  unit: number,
  input: RecommendInput,
  idSuffix: string,
): Ticket | null {
  if (ranked.length === 0) return null;

  // ---- Dominance floor --------------------------------------------------
  // 1. Drop any line whose payout ≤ unit: it can't profit even on a solo
  //    win, so it's dominated by "don't bet that combo at all". This is a
  //    per-line filter, applied before any tier/personality shaping — no
  //    personality wants structurally valueless lines.
  const profitable = ranked.filter((x) => x.payout > unit);
  if (profitable.length === 0) return null;

  // 2. Greedy keep-by-score: stop adding lines the moment they become
  //    value-destroying rather than padding to a fixed count. For wide,
  //    adding a line can grow bestCaseReturn (multi-pay), so the test is
  //    bestCaseReturn(after add) > cost(after add). For non-wide, the best
  //    case is fixed at the max single-line payout, so this naturally caps
  //    the kept set at floor(maxPayout / unit).
  const wanted = linesWanted(type, input.style.personality);
  const maxLines = Math.max(
    1,
    Math.min(MAX_BUDGET_LINES, Math.floor(input.style.budget / Math.max(1, unit))),
  );
  const kept: ScoredCombo[] = [];
  for (const sc of profitable) {
    if (kept.length >= wanted || kept.length >= maxLines) break;
    const tentative = [...kept, sc];
    const tentativeCost = tentative.length * unit;
    const tentativeBest = bestRealisticReturn(
      type,
      tentative,
      input.p,
      input.allUmas,
    );
    if (tentativeBest <= tentativeCost) break; // value-destroying — stop here
    kept.push(sc);
  }
  if (kept.length === 0) return null;

  // 3. Final non-dominated check on the trimmed set. Defensively recompute
  //    in case the greedy walk stopped early on a score-order artifact.
  const cost = kept.length * unit;
  const bestCase = bestRealisticReturn(type, kept, input.p, input.allUmas);
  if (bestCase <= cost) return null;

  // ---- Probabilities + payouts -----------------------------------------
  // hitProb: wide routes through wideTicketStats (true P(≥1 covered pair
  // finishes top-3)); the naive Σ overcounts because wide pairs overlap.
  // Non-wide types keep the existing mutually-exclusive Σ (at most one
  // quinella/exacta/trio/trifecta combo wins per race → Σ IS the true hit
  // probability for those types).
  const ticketLines: TicketLine[] = kept.map((x) => ({
    combo: x.combo,
    prob: x.prob,
    fairOdds: x.fairOdds,
    payout: x.payout,
    tag: x.tag,
  }));
  const wideStats =
    type === "wide"
      ? wideTicketStats(
          ticketLines.map((l) => ({ combo: l.combo, payout: l.payout })),
          input.p,
          input.allUmas,
        )
      : null;
  const hitProb = type === "wide"
    ? clamp(wideStats!.hitProb, 0, 0.98)
    : clamp(kept.reduce((s, x) => s + x.prob, 0), 0, 0.98);

  // expectedReturn is correct by linearity for ALL bet types — the
  // multi-pay scenario for wide is already encoded in Σ p_line × payout_line
  // (each line's contribution to EV is its hit probability × its payout,
  // independent of what other lines do). Keep it unchanged.
  const expectedReturn = kept.reduce((s, x) => s + x.prob * x.payout, 0);
  const avgPayout = kept.reduce((s, x) => s + x.payout, 0) / kept.length;
  const core = unique(kept.flatMap((x) => x.combo));
  const tag = rankClass(core, input.p, input.allUmas);
  // High-variance label: low hit rate OR very large avg payout relative to unit.
  const variance: "high" | "low" =
    hitProb < 0.15 || avgPayout / Math.max(1, unit) > 30 ? "high" : "low";

  // Rationale keys are i18n lookups used by the Explain screen.
  const rationaleKeys: string[] = [];
  rationaleKeys.push(`explain.coverage`);
  rationaleKeys.push(`personality.${input.style.personality}.desc`);
  rationaleKeys.push(
    type === "trifecta" || type === "trio"
      ? "intuition.title"
      : "intuition.like",
  );
  if (tag === "chalk") rationaleKeys.push("valueTag.chalk");
  if (tag === "value") rationaleKeys.push("valueTag.value");

  return {
    id: `${type}-${idSuffix}`,
    type,
    lines: ticketLines,
    hitProb,
    cost,
    expectedReturn,
    avgPayout,
    bestCaseReturn: bestCase,
    core,
    tag,
    unit,
    variance,
    rationaleKeys,
  };
}

/**
 * Generate up to 3 diverse ticket recommendations.
 * Guarantees: returns at most one ticket per bet type, sorted by overall
 * coherence score. Empty list if nothing viable.
 */
export function recommend(input: RecommendInput): Ticket[] {
  const pool = contenderPool(input);
  if (pool.length < 2) return [];

  const types = candidateTypes(input.style);
  const tickets: Ticket[] = [];

  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    const need = type === "trio" || type === "trifecta" ? 3 : 2;
    if (pool.length < need) continue;

    // Generate all combos of this type over the pool, evaluate, filter
    // by hard constraints, score, sort.
    const ordered = type === "exacta" || type === "trifecta";
    const rawCombos = ordered ? kPerms(pool, need) : kCombos(pool, need);
    const scored: ScoredCombo[] = [];
    for (const combo of rawCombos) {
      if (!satisfiesHardConstraints(combo, input.intuition)) continue;
      const prob = comboProb(type, combo, input.p, input.allUmas);
      if (!(prob > 0)) continue;
      scored.push(scoreCombo(combo, type, prob, input.style.unit, input));
    }
    scored.sort((a, b) => b.score - a.score);
    const ticket = buildTicket(
      type,
      scored,
      input.style.unit,
      input,
      String(i),
    );
    if (ticket) tickets.push(ticket);
  }

  // Coherence ranking across tickets (separates the safe wide-net from the
  // spicy trifecta so the user sees a real range).
  tickets.sort((a, b) => {
    const sa = ticketCoherenceScore(a, input);
    const sb = ticketCoherenceScore(b, input);
    return sb - sa;
  });

  // De-duplicate by type (keep strongest of each type), take 3.
  const seenTypes = new Set<BetType>();
  const out: Ticket[] = [];
  for (const t of tickets) {
    if (seenTypes.has(t.type)) continue;
    seenTypes.add(t.type);
    out.push(t);
    if (out.length >= 3) break;
  }

  // Label top ticket.
  if (out.length > 0) out[0].id = out[0].id.replace(/-\d+$/, "-top");

  return out;
}

/**
 * Default diverse set — one top ticket for each of safe / balanced / longshot.
 *
 * Surfaced on the beginner path (DEFAULT_STYLE + no intuition) so a brand-new
 * user reaches a risk-tier spread — safer / balanced / spicier — in ≤2
 * decisions. The moment the user picks a personality on Style OR marks any
 * intuition, App.regenerate() switches to the single-personality recommend().
 *
 * Each returned ticket keeps its own `moodKey()`, so the set spans
 * safer→spicier. Reuses recommend() unchanged — no scoring math is forked.
 * Deduped by ticket `core` (the distinct umas) and capped at 3.
 */
export function recommendDiverse(input: RecommendInput): Ticket[] {
  const personalities: PersonalityId[] = ["safe", "balanced", "longshot"];
  const picks: Ticket[] = [];
  const seenCores = new Set<string>();
  for (const pid of personalities) {
    const forced = applyPersonality(input.style, pid);
    const out = recommend({ ...input, style: forced });
    const top = out[0];
    if (!top) continue;
    const coreKey = top.core.slice().sort().join(",");
    if (seenCores.has(coreKey)) continue;
    seenCores.add(coreKey);
    picks.push(top);
    if (picks.length >= 3) break;
  }
  return picks;
}

function ticketCoherenceScore(t: Ticket, input: RecommendInput): number {
  // Preference-aware ranking across tickets.
  const p = input.style.personality;
  const fairReturnRatio = t.expectedReturn / Math.max(1, t.cost);
  const hit = t.hitProb;
  const avgPrice = Math.log(Math.max(1, t.avgPayout / Math.max(100, t.unit)));
  let s = 0;
  if (p === "safe") {
    s = hit * 7 + fairReturnRatio * 1.5 - avgPrice * 0.08;
  } else if (p === "longshot") {
    s = avgPrice * 0.95 + hit * 1.8;
    if (t.tag === "chalk") s -= 0.25;
  } else if (p === "antiChalk") {
    s = hit * 4 + avgPrice * 0.4 + fairReturnRatio * 1.4;
    if (t.tag === "chalk") s -= 0.6;
  } else if (p === "fan") {
    // Favor tickets that include the anchor (more lines is better, but cost
    // must respect budget).
    s = hit * 4 + fairReturnRatio * 1.4 + (t.lines.length / 10);
  } else {
    // balanced
    s = hit * 4 + avgPrice * 0.35 + fairReturnRatio * 1.6;
  }
  if (t.tag === "blend") s += 0.5;
  return s;
}

/** Convenience: returns the ALL-runner evaluation for the scratchpad-style
 *  "fair odds table" view (used by the Race screen). */
export function allCombosForType(
  type: BetType,
  umas: string[],
  p: Record<string, number>,
  allUmas: string[],
) {
  return evaluateCombos(type, umas, p, allUmas).sort(
    (a, b) => a.fairOdds - b.fairOdds,
  );
}

// ===========================================================================
// ADR-0011 Phase 3a — structural ticket builders (presentation layer).
//
// These do NOT change the pricing engine. `buildBoxTicket` expands a user's
// marked set into the SAME combos `evaluateCombos` would produce over that set
// (unordered kCombos for quinella/wide/trio), prices each line via the SAME
// `comboProb` + `RET[type]` path, and tags the result `structure:"box"` so the
// SetFamilyView renders the set as ONE box instead of C(n,k) flat rows.
//
// Wide routes `hitProb` + `bestCaseReturn` through `wideTicketStats` (true
// P(≥1), multi-pay best case) — never the naive Σ that overcounts overlapping
// pairs. Quinella/trio keep the mutually-exclusive Σ (at most one line wins).
// Round-trip: for the same type + set + market, buildBoxTicket's line
// probs/payouts are byte-identical to evaluateCombos → no pricing drift.
// ===========================================================================

/**
 * Build a structural "box" Ticket over a user's selected set. The set is
 * expanded into unordered k-combos (k=2 for quinella/wide, k=3 for trio) and
 * priced exactly as `evaluateCombos` would price them. Returns null when the
 * set is too small for the bet type or any selected horse is scratched (p===0).
 *
 * Only the unordered bet types (quinella / wide / trio) are supported — an
 * exacta/trifecta "box" is conventionally ordered and is out of scope for 3a.
 */
export function buildBoxTicket(
  type: BetType,
  set: string[],
  p: Record<string, number>,
  allUmas: string[],
  unitStake: number,
  idSuffix: string,
): Ticket | null {
  // Only unordered box types are supported in 3a.
  if (type !== "quinella" && type !== "wide" && type !== "trio") return null;
  const k = type === "trio" ? 3 : 2;
  if (set.length < k) return null;
  // Any scratched horse (p===0) → can't price the box.
  for (const u of set) {
    if (!(p[u] > 0)) return null;
  }

  const combos = kCombos(set, k);
  const ret = RET[type];
  const lines: TicketLine[] = [];
  for (const combo of combos) {
    const prob = comboProb(type, combo, p, allUmas);
    if (!(prob > 0)) continue;
    const payout = (ret / prob) * unitStake;
    lines.push({
      combo,
      prob,
      fairOdds: 1 / prob,
      payout,
      tag: rankClass(combo, p, allUmas),
    });
  }
  if (lines.length === 0) return null;

  // hitProb + bestCaseReturn: wide routes through wideTicketStats (true P(≥1),
  // multi-pay); quinella/trio keep the mutually-exclusive Σ + max line payout.
  const wideStats =
    type === "wide"
      ? wideTicketStats(
          lines.map((l) => ({ combo: l.combo, payout: l.payout })),
          p,
          allUmas,
        )
      : null;
  const hitProb =
    type === "wide"
      ? clamp(wideStats!.hitProb, 0, 0.98)
      : clamp(lines.reduce((s, x) => s + x.prob, 0), 0, 0.98);
  const bestCaseReturn =
    type === "wide"
      ? wideStats!.bestCaseReturn
      : lines.reduce((m, x) => (x.payout > m ? x.payout : m), 0);

  const cost = lines.length * unitStake;
  const expectedReturn = lines.reduce((s, x) => s + x.prob * x.payout, 0);
  const avgPayout = lines.reduce((s, x) => s + x.payout, 0) / lines.length;
  const core = unique(lines.flatMap((x) => x.combo));
  const tag = rankClass(core, p, allUmas);
  const variance: "high" | "low" =
    hitProb < 0.15 || avgPayout / Math.max(1, unitStake) > 30 ? "high" : "low";

  const payload: BoxPayload = { set: set.slice() };

  return {
    id: `box-${type}-${idSuffix}`,
    type,
    lines,
    hitProb,
    cost,
    expectedReturn,
    avgPayout,
    bestCaseReturn,
    core,
    tag,
    unit: unitStake,
    variance,
    rationaleKeys: [],
    structure: "box",
    structurePayload: payload,
    unitStake,
  };
}

// ---------------------------------------------------------------------------
// 枠連 (bracket quinella) — aggregation over the quinella kernel, NO new
// BetType. A 枠連 point is a bracket-PAIR; the probability of a bracket-pair
// filling 1st-2nd is the sum of quinella probabilities over every horse-pair
// that crosses the two brackets. Bracket-pairs are mutually exclusive (exactly
// one bracket-pair fills 1st-2st in a race) → hitProb = Σ pairProb, same
// exclusion logic as quinella. bestCaseReturn = the single highest-paying
// bracket-pair (only one can win).
//
// Returns null when ANY selected runner lacks a numeric gate — SetFamilyView
// then omits the 枠連 row rather than guessing brackets.
// ---------------------------------------------------------------------------

/** Result of a 枠連 aggregation over a selected set. */
export interface BracketQuinellaAgg {
  points: number;
  cost: number;
  hitProb: number;
  bestCaseReturn: number;
  /** Distinct bracket numbers present in the selected set, sorted ascending. */
  brackets: number[];
}

/**
 * Aggregate a 枠連 (bracket quinella) over the selected runners. Each runner
 * carries a `gate` (bracket 1-8). Returns null when any selected runner lacks a
 * numeric gate so the view omits the row cleanly.
 */
export function bracketQuinellaAgg(
  selected: Runner[],
  p: Record<string, number>,
  allUmas: string[],
  unitStake: number,
): BracketQuinellaAgg | null {
  if (selected.length < 2) return null;
  // Any runner without a numeric gate → omit rather than guess.
  for (const r of selected) {
    if (typeof r.gate !== "number" || !Number.isFinite(r.gate)) return null;
  }
  const brackets = Array.from(
    new Set(selected.map((r) => r.gate as number)),
  ).sort((a, b) => a - b);
  if (brackets.length < 2) return null; // all in one bracket → no pair

  // Group runners by bracket.
  const byBracket = new Map<number, string[]>();
  for (const r of selected) {
    const g = r.gate as number;
    const list = byBracket.get(g) || [];
    list.push(r.uma);
    byBracket.set(g, list);
  }

  const ret = RET.quinella;
  let hitProb = 0;
  let bestCaseReturn = 0;
  let points = 0;
  // Enumerate bracket-pairs (B1 < B2) — unordered, like quinella.
  for (let i = 0; i < brackets.length; i++) {
    for (let j = i + 1; j < brackets.length; j++) {
      const horsesA = byBracket.get(brackets[i])!;
      const horsesB = byBracket.get(brackets[j])!;
      let pairProb = 0;
      for (const h1 of horsesA) {
        for (const h2 of horsesB) {
          pairProb += comboProb("quinella", [h1, h2], p, allUmas);
        }
      }
      if (!(pairProb > 0)) continue;
      points += 1;
      hitProb += pairProb;
      const pairPayout = (ret / pairProb) * unitStake;
      if (pairPayout > bestCaseReturn) bestCaseReturn = pairPayout;
    }
  }
  if (points === 0) return null;

  return {
    points,
    cost: points * unitStake,
    hitProb: clamp(hitProb, 0, 0.98),
    bestCaseReturn,
    brackets,
  };
}

// ===========================================================================
// ADR-0011 Phase 3b — ordered structural tickets (formation + wheel).
//
// Like `buildBoxTicket`, these do NOT change the pricing engine. They expand
// the user's per-position contender sets into the SAME ordered tuples
// `evaluateCombos` would produce (the cartesian product, filtered by no-repeat)
// and price each line through the SAME `comboProb` + `RET[type]` path
// (orderProb under the hood for exacta/trifecta). Ordered bet types are
// mutually exclusive (at most one ordered sequence wins per race) →
// hitProb = Σ line.prob, bestCaseReturn = max single-line payout.
//
// Round-trip: for positions where every position set is the same `set`,
// buildFormationTicket produces the same tuples + probs + payouts as
// evaluateCombos(type, set) → no pricing drift (verified in
// recommender.formation.test.ts).
//
// A wheel is a formation with `positions[i] = axis if i+1 === position else
// opponents`; buildWheelTicket delegates to buildFormationTicket and re-tags
// the result so the FillGuide renders the axis-labeled card.
// ===========================================================================

/** Cartesian product of arrays (positions[i] → contender set for (i+1)th place). */
function cartesianProduct<T>(arrays: T[][]): T[][] {
  const out: T[][] = [];
  (function rec(i: number, acc: T[]) {
    if (i === arrays.length) {
      out.push(acc.slice());
      return;
    }
    for (const item of arrays[i]) {
      acc.push(item);
      rec(i + 1, acc);
      acc.pop();
    }
  })(0, []);
  return out;
}

/**
 * Build an ordered structural Ticket over per-position contender sets. Each
 * ordered tuple in the cartesian product is kept only when no horse repeats
 * across positions (a horse can't finish twice). Returns null when:
 *   - `type` is not an ordered bet type (exacta / trifecta)
 *   - `positions.length` doesn't match the bet type's depth
 *   - any position set is empty
 *   - any contender is scratched (p===0)
 *   - the no-repeat filter leaves zero viable tuples
 *
 * When every `positions[i]` is the same `set`, the expansion degenerates to
 * an ordered box (kPerms(set, k)) and round-trips to evaluateCombos.
 */
export function buildFormationTicket(
  type: BetType,
  positions: string[][],
  p: Record<string, number>,
  allUmas: string[],
  unitStake: number,
  idSuffix: string,
): Ticket | null {
  // Only ordered bet types are supported.
  if (type !== "exacta" && type !== "trifecta") return null;
  const k = type === "trifecta" ? 3 : 2;
  if (positions.length !== k) return null;
  // Validate each position set: non-empty, all contenders present in the market.
  for (const posSet of positions) {
    if (posSet.length === 0) return null;
    for (const u of posSet) {
      if (!(p[u] > 0)) return null;
    }
  }

  // Cartesian product, filtered by no-repeat (a horse can't finish twice).
  const tuples = cartesianProduct(positions).filter(
    (t) => new Set(t).size === t.length,
  );
  if (tuples.length === 0) return null;

  const ret = RET[type];
  const lines: TicketLine[] = [];
  for (const combo of tuples) {
    const prob = comboProb(type, combo, p, allUmas); // orderProb under the hood
    if (!(prob > 0)) continue;
    const payout = (ret / prob) * unitStake;
    lines.push({
      combo,
      prob,
      fairOdds: 1 / prob,
      payout,
      tag: rankClass(combo, p, allUmas),
    });
  }
  if (lines.length === 0) return null;

  // Ordered bet types are mutually exclusive (at most one ordered sequence
  // wins per race) → Σ line.prob is the true hitProb; max line.payout is the
  // best single-race return. No wide-style overlap correction needed.
  const hitProb = clamp(lines.reduce((s, x) => s + x.prob, 0), 0, 0.98);
  const bestCaseReturn = lines.reduce(
    (m, x) => (x.payout > m ? x.payout : m),
    0,
  );

  const cost = lines.length * unitStake;
  const expectedReturn = lines.reduce((s, x) => s + x.prob * x.payout, 0);
  const avgPayout = lines.reduce((s, x) => s + x.payout, 0) / lines.length;
  const core = unique(lines.flatMap((x) => x.combo));
  const tag = rankClass(core, p, allUmas);
  const variance: "high" | "low" =
    hitProb < 0.15 || avgPayout / Math.max(1, unitStake) > 30 ? "high" : "low";

  const payload: FormationPayload = {
    positions: positions.map((s) => s.slice()),
  };

  return {
    id: `formation-${type}-${idSuffix}`,
    type,
    lines,
    hitProb,
    cost,
    expectedReturn,
    avgPayout,
    bestCaseReturn,
    core,
    tag,
    unit: unitStake,
    variance,
    rationaleKeys: [],
    structure: "formation",
    structurePayload: payload,
    unitStake,
  };
}

/**
 * Build a wheel Ticket: the `axis` horse(s) are pinned to a fixed finishing
 * `position`; the `opponents` are permuted across the remaining positions.
 * Delegates to `buildFormationTicket` (positions[i] = axis if i+1 === position
 * else opponents) and re-tags the result `structure: "wheel"` with a
 * `WheelPayload` so the FillGuide renders the axis-labeled card.
 *
 * Returns null for the same reasons as `buildFormationTicket`, plus when the
 * axis is empty or `position` is out of range for the bet type's depth.
 */
export function buildWheelTicket(
  type: BetType,
  axis: string[],
  opponents: string[],
  position: 1 | 2 | 3,
  p: Record<string, number>,
  allUmas: string[],
  unitStake: number,
  idSuffix: string,
): Ticket | null {
  // Only ordered bet types are supported.
  if (type !== "exacta" && type !== "trifecta") return null;
  const k = type === "trifecta" ? 3 : 2;
  if (position < 1 || position > k) return null;
  if (axis.length === 0) return null;

  // Construct the positions array: axis at `position`, opponents elsewhere.
  const positions: string[][] = [];
  for (let i = 1; i <= k; i++) {
    positions.push(i === position ? axis.slice() : opponents.slice());
  }

  const ticket = buildFormationTicket(
    type,
    positions,
    p,
    allUmas,
    unitStake,
    idSuffix,
  );
  if (!ticket) return null;

  // Re-tag as wheel with the axis/opponents/position payload.
  const payload: WheelPayload = {
    axis: axis.slice(),
    opponents: opponents.slice(),
    position,
  };

  return {
    ...ticket,
    id: `wheel-${type}-${idSuffix}`,
    structure: "wheel",
    structurePayload: payload,
  };
}
