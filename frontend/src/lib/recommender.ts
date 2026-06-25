/**
 * Recommendation engine.
 *
 * Pipeline (matches app_plan §Recommendation Engine Direction):
 *   1. Contender pool: filtered + re-ranked by intuition + flavor.
 *   2. Bet-type candidates per personality + complexity.
 *   3. Per-combo scoring (hit rate, payout shape, crowd exposure, flavor,
 *      intuition bonuses/penalties).
 *   4. Group top combos of each type into a Ticket.
 *   5. Return up to 3 tickets, diversified by type.
 *
 * Optimizes for coherent recreational structure, NOT expected profit.
 */

import {
  comboProb,
  evaluateCombos,
  kCombos,
  kPerms,
  rankClass,
  RET,
  type BetType,
} from "./fairvalue";
import type {
  PersonalityId,
  RecommendInput,
  StyleState,
  Ticket,
  TicketLine,
  IntuitionState,
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

/** Build a single Ticket for a bet type from its top-ranked combos. */
function buildTicket(
  type: BetType,
  ranked: ScoredCombo[],
  unit: number,
  input: RecommendInput,
  idSuffix: string,
): Ticket | null {
  if (ranked.length === 0) return null;
  const wanted = linesWanted(type, input.style.personality);
  const maxLines = Math.max(
    1,
    Math.min(MAX_BUDGET_LINES, Math.floor(input.style.budget / Math.max(1, unit))),
  );
  const lines = ranked.slice(0, Math.min(wanted, maxLines));
  if (lines.length === 0) return null;

  const hitProb = clamp(
    lines.reduce((s, x) => s + x.prob, 0),
    0,
    0.98,
  );
  const cost = lines.length * unit;
  const expectedReturn = lines.reduce((s, x) => s + x.prob * x.payout, 0);
  const avgPayout = lines.reduce((s, x) => s + x.payout, 0) / lines.length;
  const core = unique(lines.flatMap((x) => x.combo));
  const tag = rankClass(core, input.p, input.allUmas);
  // High-variance label: low hit rate OR very large avg payout relative to unit.
  const variance: "high" | "low" =
    hitProb < 0.15 || avgPayout / Math.max(1, unit) > 30 ? "high" : "low";

  const ticketLines: TicketLine[] = lines.map((x) => ({
    combo: x.combo,
    prob: x.prob,
    fairOdds: x.fairOdds,
    payout: x.payout,
    tag: x.tag,
  }));

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
  if (t.tag === "blend") s += 0.16;
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
