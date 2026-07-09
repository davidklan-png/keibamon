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
  varianceLabel,
  wideTicketStats,
  type BetType,
  type Runner,
} from "./fairvalue";
import type { Ticket, TicketLine } from "./types";

export type ManualBuildMode = "box" | "formation";

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
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const out = priceBracketPair(arr[i], arr[j], byBracket, p, allUmas, unit);
        if (!out) continue;
        lines.push(out.line);
      }
    }
    if (lines.length === 0) return null;
    return finalizeTicket(type, lines, unit, p, allUmas);
  }

  const k = K_BY_TYPE[type];
  const arr = Array.from(pickedUma).sort((a, b) => Number(a) - Number(b));
  if (arr.length < k) return null;
  const ordered = type === "exacta" || type === "trifecta";
  const combos = ordered ? kPerms(arr, k) : kCombos(arr, k);
  const { lines } = priceLines(type, combos, p, allUmas, unit);
  if (lines.length === 0) return null;
  return finalizeTicket(type, lines, unit, p, allUmas);
}

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
 * Build an explicit ordered formation from per-place contender sets. This is
 * the manual equivalent of marking a track ticket by place:
 *   exacta:   1st / 2nd
 *   trifecta: 1st / 2nd / 3rd
 *
 * The generated `lines` are ordinary exacta/trifecta ordered combos, so the
 * existing resolver and Worker persistence do not need a separate settlement
 * branch. `structurePayload.positions` preserves the user's segregated columns
 * for FillGuide/share/edit round-trips.
 */
export function buildManualFormationTicket(
  type: BetType,
  positions: string[][],
  p: Record<string, number>,
  allUmas: string[],
  unit: number,
): Ticket | null {
  if (type !== "exacta" && type !== "trifecta") return null;
  const k = K_BY_TYPE[type];
  if (positions.length !== k) return null;

  const cleanPositions = positions.map((posSet) =>
    Array.from(new Set(posSet)).sort((a, b) => Number(a) - Number(b)),
  );
  if (cleanPositions.some((posSet) => posSet.length === 0)) return null;

  const combos = cartesianProduct(cleanPositions).filter(
    (combo) => new Set(combo).size === combo.length,
  );
  if (combos.length === 0) return null;

  const { lines } = priceLines(type, combos, p, allUmas, unit);
  if (lines.length === 0) return null;
  return {
    ...finalizeTicket(type, lines, unit, p, allUmas),
    structure: "formation",
    structurePayload: { positions: cleanPositions },
    unitStake: unit,
  };
}

/**
 * Price an EXPLICIT list of combos (not derived from a picked set). Each combo
 * is priced through the SAME `comboProb` + `RET[type]` + `rankClass` path as
 * `buildManualTicket`'s box expansion, so output is byte-identical for the same
 * combos. Returns the naive `Σ line.prob` as `hitProb` — correct as-is for the
 * five mutually-exclusive types, and an upper bound the wide caller overrides
 * (via `finalizeTicket`'s `wideTicketStats` path). Zero-probability combos
 * (scratched / unpriceable) are dropped, exactly as the box path does.
 *
 * Extracted so the edit/locked path (ManualTicketBuilder) can re-price a
 * ticket's ORIGINAL combos against CURRENT odds without re-deriving them from
 * a box expansion — that's what stops "open a curated ticket, change nothing,
 * Save" from silently regenerating the full box.
 */
export function priceLines(
  type: BetType,
  combos: string[][],
  p: Record<string, number>,
  allUmas: string[],
  unit: number,
): { lines: TicketLine[]; hitProb: number } {
  const ret = RET[type];
  const lines: TicketLine[] = [];
  let hitProb = 0;
  for (const combo of combos) {
    const prob = comboProb(type, combo, p, allUmas);
    if (!(prob > 0)) continue;
    const fairOdds = 1 / prob;
    const payout = (ret / prob) * unit;
    lines.push({ combo, prob, fairOdds, payout, tag: rankClass(combo, p, allUmas) });
    hitProb += prob;
  }
  return { lines, hitProb };
}

/**
 * Assemble a `Ticket` from already-priced lines. Self-contained — derives
 * hitProb / bestCaseReturn / variance / tag from `lines` + the win market, so
 * both the box path (`buildManualTicket`) and the edit/locked re-price path
 * (`ManualTicketBuilder`) run through ONE assembly definition.
 *
 *   - hitProb + bestCaseReturn: wide is the one bet type where multiple lines
 *     can co-hit (up to C(3,2) pairs when covered horses fill the board), so
 *     it routes through `wideTicketStats` for the true P(≥1) + multi-pay best
 *     case. The other five types are mutually exclusive (at most one line wins
 *     per race) → Σ line.prob is the true hitProb, and the max single-line
 *     payout is the best case. Same kernel the recommender uses, so a manual
 *     ticket's numbers match a recommender ticket's for the same lines.
 *   - variance + tag use the SAME formulas as `recommend()` (`varianceLabel`
 *     and `rankClass(core, …)`), so a manually-built ticket lands on the same
 *     Safer/Balanced/Spicier mood pill as an equivalent-risk recommender ticket.
 *     Previously variance was a crude `ordered ? high : low` proxy and tag was
 *     a per-line majority vote, which could disagree with `rankClass(core)`.
 */
export function finalizeTicket(
  type: BetType,
  lines: TicketLine[],
  unit: number,
  p: Record<string, number>,
  allUmas: string[],
): Ticket {
  const cost = lines.length * unit;
  const expectedReturn = lines.reduce((s, l) => s + l.prob * l.payout, 0);
  const avgPayout = lines.reduce((s, l) => s + l.payout, 0) / lines.length;
  const core = Array.from(new Set(lines.flatMap((l) => l.combo)));

  let hitProb: number;
  let bestCaseReturn: number;
  if (type === "wide") {
    const stats = wideTicketStats(
      lines.map((l) => ({ combo: l.combo, payout: l.payout })),
      p,
      allUmas,
    );
    hitProb = stats.hitProb;
    bestCaseReturn = stats.bestCaseReturn;
  } else {
    hitProb = lines.reduce((s, l) => s + l.prob, 0);
    bestCaseReturn = Math.max(...lines.map((l) => l.payout));
  }

  const tag = rankClass(core, p, allUmas);
  const variance = varianceLabel(hitProb, avgPayout, unit);

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
    variance,
    rationaleKeys: [],
  };
}

/** n! for small n (the manual field is ≤ ~18, so no overflow concern). */
function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** C(n, k) — count of unordered k-combos over n elements. */
function combinations(n: number, k: number): number {
  return factorial(n) / (factorial(k) * factorial(n - k));
}

/** P(n, k) = n!/(n-k)! — count of ordered k-perms over n elements. */
function permutations(n: number, k: number): number {
  return factorial(n) / factorial(n - k);
}

/**
 * Does `combos` constitute the FULL combinatorial box over `core` for `type`,
 * or a curated subset? Count-based heuristic — NOT a combo-set diff: the
 * expected full count is C(core.length, k) for the unordered types
 * (quinella/wide/trio) and P(core.length, k) for the ordered ones
 * (exacta/trifecta); `combos.length >= expected` ⇒ full box.
 *
 * Why this exists: `recommend()` keeps only its top-scored, value-preserving
 * lines (often 6–14 of the 35–56 a full trio/trifecta box would have). Opening
 * such a curated ticket for edit must NOT silently regenerate the full box on
 * Save — the ManualTicketBuilder uses this to decide whether to lock onto the
 * original line set (re-price, don't regenerate) until the user actually
 * changes a pick.
 *
 * Takes raw combos (`string[][]`) rather than `TicketLine[]` so it can classify
 * a `ManualTicketInitial` (whose `lines` ARE `string[][]`) without pricing it;
 * for a priced `Ticket`, pass `ticket.lines.map((l) => l.combo)`. It only reads
 * the count.
 *
 * bracket_quinella always returns true: it expands every picked bracket-pair,
 * `recommend()` never produces that type, and the locked-mode path that
 * consumes this never applies to it.
 *
 * False-negative tolerance (safe direction): a genuinely-full box CAN carry
 * fewer combos than the raw count when some were unpriceable (zero probability
 * — a scratched horse; the builder drops them in `priceLines`). Such a box
 * reads as "curated" here → lock engages slightly more often than strictly
 * necessary, never less. Accepted over coupling this pure helper to a live
 * combo-set diff.
 */
export function isFullBox(
  type: BetType,
  combos: string[][],
  core: string[],
): boolean {
  if (type === "bracket_quinella") return true;
  const n = core.length;
  const k = K_BY_TYPE[type];
  if (n < k) return false; // can't be a full k-box with fewer than k in the core
  const expected = (type === "exacta" || type === "trifecta")
    ? permutations(n, k)
    : combinations(n, k);
  return combos.length >= expected;
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
