// ============================================================================
// Manual ticket builder — pricing helpers.
//
// The recommender (recommender.ts) AUTO-PICKS lines for a personality-driven
// ticket; this module is the corresponding "user picks every line" path used
// by ManualTicketBuilder.tsx. It shares the SAME fair-value engine (Henery γ
// + RET) and the SAME TicketLine shape so a manually-built ticket is
// indistinguishable from a recommender output downstream (commit, settle,
// FillGuide render, share card).
//
// Bet type → selection model:
//   quinella / wide / trio     → box of umas, expand C(n,k) unordered combos
//   exacta / trifecta          → box of umas, expand kPerms(set, k) ordered
//   bracket_quinella           → box of BRACKETS (1-8), expand C(n,2) bracket
//                                pairs; each pair is priced by enumerating the
//                                horse-pairs across the two brackets and
//                                summing comboProb("quinella", …). A bracket
//                                pair ["3","8"] is the LINE combo (bracket
//                                space); the resolver maps umabans→brackets
//                                via `gates` to check it. The two horses-per-
//                                bracket edge case (["3","3"]) is NOT
//                                buildable here — a multi-pick UI can't tell
//                                "pick 3 twice" from "pick 3 once", and the
//                                cross-bracket case covers the common JRA
//                                hit. Same-bracket combos remain settlable
//                                if they ever arrive via another path.
//
// Wide's multi-pay scenario (multiple winning lines on one race) is honored
// via wideTicketStats — the same helper the recommender uses, so cost /
// hitProb / bestCaseReturn match across paths.
// ============================================================================
import {
  RET,
  comboProb,
  kCombos,
  kPerms,
  rankClass,
  wideTicketStats,
  type BetType,
  type Runner,
  type ValueTag,
} from "./fairvalue";
import type { Ticket, TicketLine } from "./types";

/** Required picked-set size for each bet type's combos to be valid. */
export const K_BY_TYPE: Record<BetType, 2 | 3> = {
  quinella: 2,
  wide: 2,
  exacta: 2,
  trio: 3,
  trifecta: 3,
  bracket_quinella: 2,
};

/**
 * Group runners by their `gate` (bracket). Runners without a numeric gate are
 * excluded — they can't participate in a bracket_quinella line. Returns null
 * when no runner carries a gate (the live snapshot's draw hasn't published).
 */
export function runnersByBracket(
  runners: Runner[],
): Map<number, string[]> | null {
  const m = new Map<number, string[]>();
  let any = false;
  for (const r of runners) {
    if (typeof r.gate === "number" && Number.isFinite(r.gate)) {
      const list = m.get(r.gate) || [];
      list.push(r.uma);
      m.set(r.gate, list);
      any = true;
    }
  }
  return any ? m : null;
}

/**
 * Price one bracket-quinella line. Brackets are 1-8; the LINE's combo names
 * brackets (`["3","8"]`). To price it, enumerate every (h1 in b1, h2 in b2)
 * horse-pair and sum their quinella probabilities — same kernel
 * `bracketQuinellaAgg` uses in recommender.ts. Returns null when either
 * bracket has no runners in the field (can't price → drop the line).
 */
function priceBracketPair(
  b1: number,
  b2: number,
  byBracket: Map<number, string[]>,
  p: Record<string, number>,
  allUmas: string[],
  unit: number,
): { line: TicketLine; hitProb: number } | null {
  const horses1 = byBracket.get(b1);
  const horses2 = byBracket.get(b2);
  if (!horses1?.length || !horses2?.length) return null;
  let pairProb = 0;
  for (const h1 of horses1) {
    for (const h2 of horses2) {
      pairProb += comboProb("quinella", [h1, h2], p, allUmas);
    }
  }
  if (!(pairProb > 0)) return null;
  const ret = RET.bracket_quinella;
  const fairOdds = 1 / pairProb;
  const payout = (ret / pairProb) * unit;
  const tag = rankClass([...horses1, ...horses2], p, allUmas);
  return {
    line: {
      combo: [String(b1), String(b2)],
      prob: pairProb,
      fairOdds,
      payout,
      tag,
    },
    hitProb: pairProb,
  };
}

/**
 * Build a structural Ticket from the user's manual picks. Returns null when:
 *   - the picked set is too small for the bet type's k
 *   - bracket_quinella is requested but the field has no `gate` data
 *   - every line fails to price (all scratched, or p is empty)
 *
 * The returned Ticket's `lines` carry combos in the bet type's NUMBER SPACE
 * (umabans for the 5 exotic types, brackets for bracket_quinella) — the
 * resolver + FillGuide expect that and the manual ticket is fed through
 * the same downstream path as a recommender ticket.
 */
export function buildManualTicket(
  type: BetType,
  pickedUma: Set<string>,
  pickedBrackets: Set<number>,
  runners: Runner[],
  p: Record<string, number>,
  allUmas: string[],
  unit: number,
): Ticket | null {
  if (type === "bracket_quinella") {
    const byBracket = runnersByBracket(runners);
    if (!byBracket) return null;
    const arr = Array.from(pickedBrackets).sort((a, b) => a - b);
    if (arr.length < 2) return null;
    const lines: TicketLine[] = [];
    let hitProb = 0;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const out = priceBracketPair(arr[i], arr[j], byBracket, p, allUmas, unit);
        if (!out) continue;
        lines.push(out.line);
        hitProb += out.hitProb;
      }
    }
    if (lines.length === 0) return null;
    return finalizeTicket(type, lines, hitProb, unit, false);
  }

  const k = K_BY_TYPE[type];
  const arr = Array.from(pickedUma).sort((a, b) => Number(a) - Number(b));
  if (arr.length < k) return null;
  const ordered = type === "exacta" || type === "trifecta";
  const combos = ordered ? kPerms(arr, k) : kCombos(arr, k);
  const ret = RET[type];
  const lines: TicketLine[] = [];
  let hitProb = 0;
  for (const combo of combos) {
    const prob = comboProb(type, combo, p, allUmas);
    if (!(prob > 0)) continue;
    const fairOdds = 1 / prob;
    const payout = (ret / prob) * unit;
    lines.push({ combo, prob, fairOdds, payout, tag: rankClass(combo, p, allUmas) });
    // For non-wide types, lines are mutually exclusive (at most one wins per
    // race) → hitProb = Σ line.prob. Wide is special-cased below.
    if (type !== "wide") hitProb += prob;
  }
  if (lines.length === 0) return null;

  // Wide: use the same multi-pay-aware stats as the recommender so a manual
  // wide ticket's hitProb / bestCaseReturn matches what a recommender wide
  // ticket would show for the same lines. (Σ line.prob would overcount.)
  if (type === "wide") {
    const stats = wideTicketStats(
      lines.map((l) => ({ combo: l.combo, payout: l.payout })),
      p,
      allUmas,
    );
    return finalizeTicket(type, lines, stats.hitProb, unit, true, stats.bestCaseReturn);
  }

  return finalizeTicket(type, lines, hitProb, unit, ordered);
}

/**
 * Assemble the final Ticket. `variance` is heuristic: ordered types (exacta,
 * trifecta) get "high" (one strict sequence to hit); unordered types get
 * "low". This feeds `moodKey()` so the existing mood-pill render on the
 * ticket card has a value to show — there's no personality behind a manual
 * ticket, but the UX wants a mood label and "balanced" / "safer" / "spicier"
 * are reasonable labels derived from the ticket's own properties.
 */
function finalizeTicket(
  type: BetType,
  lines: TicketLine[],
  hitProb: number,
  unit: number,
  ordered: boolean,
  bestCaseOverride?: number,
): Ticket {
  const cost = lines.length * unit;
  const expectedReturn = lines.reduce((s, l) => s + l.prob * l.payout, 0);
  const avgPayout = lines.reduce((s, l) => s + l.payout, 0) / lines.length;
  const bestCaseReturn =
    bestCaseOverride ?? Math.max(...lines.map((l) => l.payout));
  // Dominant tag = whichever ValueTag appears most often across lines. Ties
  // break by the order ["chalk", "blend", "value"] — matches the recommender's
  // "lowest variance wins" intuition.
  const tagCounts: Record<ValueTag, number> = { chalk: 0, blend: 0, value: 0 };
  for (const l of lines) tagCounts[l.tag]++;
  const tag: ValueTag =
    tagCounts.chalk >= tagCounts.blend && tagCounts.chalk >= tagCounts.value
      ? "chalk"
      : tagCounts.value >= tagCounts.blend
        ? "value"
        : "blend";
  const core = Array.from(new Set(lines.flatMap((l) => l.combo)));
  return {
    id: "manual",
    type,
    lines,
    hitProb: Math.min(0.99, hitProb),
    cost,
    expectedReturn,
    avgPayout,
    bestCaseReturn,
    core,
    tag,
    unit,
    variance: ordered ? "high" : "low",
    rationaleKeys: [],
  };
}

/** The 6 bet types the manual builder offers, in display order. */
export const MANUAL_BET_TYPES: BetType[] = [
  "quinella",
  "wide",
  "exacta",
  "trio",
  "trifecta",
  "bracket_quinella",
];
