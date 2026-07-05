/**
 * Fair-value exotic-pricing engine — TypeScript port of the verified
 * implementation that powered splash/helper.html (Henery γ = 0.856).
 *
 * Method (frozen — do not drift from the validated form):
 *   1. De-vig win odds: p_i = (1/odds_i) / Σ (1/odds_j)            within race
 *   2. Henery ordering model with γ = 0.856:
 *        P(1st = i)                                = p_i
 *        P(kth = i | prior places)                 = p_i^γ / Σ_{j remaining} p_j^γ
 *      i.e. 1st place uses the raw win prob; every later place re-weights
 *      the remaining runners by p^γ and renormalizes.
 *   3. Bet types aggregate orderings:
 *        exacta / trifecta  = single ordered sequence
 *        quinella            = Σ over (i,j) and (j,i)
 *        trio                = Σ over the 6 orderings of (i,j,k)
 *        wide                = Σ over all orderings where both named horses
 *                              finish in the top 3 (one of them can be 1st)
 *   4. Fair odds = 1 / P. Estimated payout = RET / P with the JRA pool
 *      return ratios:
 *        quinella .775, wide .775, exacta .75, trio .75, trifecta .725
 *
 * Distribution sums (asserted in fairvalue.test.ts):
 *   exacta   Σ over all ordered pairs    = 1
 *   quinella Σ over all unordered pairs  = 1     (collapses exacta pairs)
 *   trifecta Σ over all ordered triples  = 1
 *   trio     Σ over all unordered triples = 1    (collapses trifecta triples)
 *   wide     Σ over all unordered pairs  = 3     (C(top3, 2) per race — a wide
 *                                                  ticket pays on any pair of
 *                                                  top-3 finishers, so a single
 *                                                  race produces 3 winning pairs)
 */

export const GAMMA = 0.856;

export const RET: Record<BetType, number> = {
  quinella: 0.775,
  wide: 0.775,
  exacta: 0.75,
  trio: 0.75,
  trifecta: 0.725,
  // 枠連 (bracket quinella) — JRA's takeout matches quinella's, and the
  // existing display-only `bracketQuinellaAgg` in recommender.ts already
  // uses `RET.quinella` for the same purpose. The two-horse-per-line
  // structure is identical to quinella, just collapsed into bracket space.
  bracket_quinella: 0.775,
};

export type BetType =
  | "quinella"
  | "wide"
  | "exacta"
  | "trio"
  | "trifecta"
  | "bracket_quinella";

export interface Runner {
  /** Saddle number as a string key (kept stable across re-renders). */
  uma: string;
  /** Display name, optional. */
  name?: string | null;
  /** Decimal win odds (>= 1.0). Runners with odds <= 0 are treated as scratched. */
  odds: number;
  /**
   * Milestone 4 form panel (jockey-gap option a): passthrough from the live
   * snapshot so the FormPanel can fetch jockey context. Absent on manual /
   * legacy runners. The recommender ignores these — only fairvalue + form use.
   */
  jockey_id?: string | null;
  jockey_name?: string | null;
  /**
   * ADR-0011 Phase 3a: bracket (枠) number, 1-8. Absent on the live path
   * (LiveRunner doesn't carry it yet) → SetFamilyView omits the 枠連 row via
   * bracketQuinellaAgg returning null. Present on the roundup/weekly path.
   * The pricing engine ignores this; only the structural aggregation reads it.
   */
  gate?: number | null;
}

/** A de-vigged win-probability map plus the raw book sum (overround). */
export interface WinProbResult {
  p: Record<string, number>;
  overround: number;
}

const powGamma = (x: number) => Math.pow(x, GAMMA);

/**
 * De-vig the win market. Runners with odds <= 0 are excluded (scratched);
 * their probability mass is zero and they will not appear in `p`.
 */
export function winProbs(runners: Runner[]): WinProbResult {
  const inv: Record<string, number> = {};
  let s = 0;
  for (const r of runners) {
    if (r.odds > 0) {
      inv[r.uma] = 1 / r.odds;
      s += inv[r.uma];
    }
  }
  const p: Record<string, number> = {};
  if (s > 0) {
    for (const k in inv) p[k] = inv[k] / s;
  }
  return { p, overround: s };
}

/**
 * Probability of a specific ordered finishing sequence (e.g. [i, j, k] = i
 * wins, j 2nd, k 3rd) under the Henery γ model.
 *
 *   seq[0]    → raw p_i
 *   seq[k>0]  → p_i^γ / Σ_{remaining} p^γ
 */
export function orderProb(
  seq: string[],
  p: Record<string, number>,
  allUmas: string[],
): number {
  const used = new Set<string>();
  let prob = 1;
  for (let i = 0; i < seq.length; i++) {
    const h = seq[i];
    if (i === 0) {
      prob *= p[h] || 0;
    } else {
      let denom = 0;
      for (const u of allUmas) {
        if (!used.has(u)) denom += powGamma(p[u] || 0);
      }
      prob *= denom > 0 ? powGamma(p[h] || 0) / denom : 0;
    }
    used.add(h);
  }
  return prob;
}

const perms2 = (a: string, b: string): string[][] => [
  [a, b],
  [b, a],
];
const perms3 = (a: string, b: string, c: string): string[][] => [
  [a, b, c],
  [a, c, b],
  [b, a, c],
  [b, c, a],
  [c, a, b],
  [c, b, a],
];

/**
 * Probability that a specific combination (unordered for quinella/trio/wide,
 * ordered for exacta/trifecta) is a winning ticket.
 */
export function comboProb(
  type: BetType,
  combo: string[],
  p: Record<string, number>,
  allUmas: string[],
): number {
  if (type === "exacta" || type === "trifecta") {
    return orderProb(combo, p, allUmas);
  }
  if (type === "quinella") {
    return perms2(combo[0], combo[1]).reduce(
      (s, o) => s + orderProb(o, p, allUmas),
      0,
    );
  }
  if (type === "trio") {
    return perms3(combo[0], combo[1], combo[2]).reduce(
      (s, o) => s + orderProb(o, p, allUmas),
      0,
    );
  }
  if (type === "wide") {
    // Wide pays when BOTH named horses finish in the top 3. Enumerate the
    // third-place finisher c over all other runners, summing trio-style
    // orderings of {combo[0], combo[1], c}.
    let s = 0;
    for (const u of allUmas) {
      if (u === combo[0] || u === combo[1]) continue;
      s += perms3(combo[0], combo[1], u).reduce(
        (a, o) => a + orderProb(o, p, allUmas),
        0,
      );
    }
    return s;
  }
  return 0;
}

/** All k-combinations of arr (unordered). */
export function kCombos<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  (function rec(st: number, acc: T[]) {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = st; i < arr.length; i++) {
      acc.push(arr[i]);
      rec(i + 1, acc);
      acc.pop();
    }
  })(0, []);
  return out;
}

/** All k-permutations of arr (ordered). */
export function kPerms<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  (function rec(rem: T[], acc: T[]) {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = 0; i < rem.length; i++) {
      const next = rem.slice();
      const [x] = next.splice(i, 1);
      acc.push(x);
      rec(next, acc);
      acc.pop();
    }
  })(arr, []);
  return out;
}

/** Umas sorted by descending de-vigged win probability. */
export function favOrder(
  p: Record<string, number>,
  allUmas: string[],
): string[] {
  return allUmas
    .filter((u) => (p[u] || 0) > 0)
    .sort((a, b) => (p[b] || 0) - (p[a] || 0));
}

export type ValueTag = "chalk" | "value" | "blend";

/**
 * Heuristic value-tag for a combo:
 *   chalk  — every runner is in the top third of the market (overbet)
 *   value  — no runner is in the top third (price-horse combo)
 *   blend  — mixed
 */
export function rankClass(
  combo: string[],
  p: Record<string, number>,
  allUmas: string[],
): ValueTag {
  const order = favOrder(p, allUmas);
  const favCut = order.slice(0, Math.max(2, Math.ceil(order.length / 3)));
  const favs = combo.filter((u) => favCut.includes(u)).length;
  if (favs === combo.length) return "chalk";
  if (favs === 0) return "value";
  return "blend";
}

export interface ComboEval {
  combo: string[];
  prob: number;
  fairOdds: number;
  estPayoutPerUnit: number; // RET[type] / prob * unit (if unit=1, this is RET/prob)
  tag: ValueTag;
}

/** Evaluate every combo of a given bet type over a pool of contenders. */
export function evaluateCombos(
  type: BetType,
  pool: string[],
  p: Record<string, number>,
  allUmas: string[],
): ComboEval[] {
  const need = type === "trio" || type === "trifecta" ? 3 : 2;
  if (pool.length < need) return [];
  const ordered = type === "exacta" || type === "trifecta";
  const combos = ordered ? kPerms(pool, need) : kCombos(pool, need);
  const ret = RET[type];
  return combos
    .map((c) => {
      const prob = comboProb(type, c, p, allUmas);
      const fairOdds = prob > 0 ? 1 / prob : Infinity;
      const estPayoutPerUnit = prob > 0 ? ret / prob : Infinity;
      const tag = rankClass(c, p, allUmas);
      return { combo: c, prob, fairOdds, estPayoutPerUnit, tag };
    })
    .filter((x) => isFinite(x.fairOdds) && x.prob > 0);
}

// ---------------------------------------------------------------------------
// WIDE multi-win statistics.
//
// Wide is the ONLY JRA bet type where multiple lines can win in a single
// race: if k of a ticket's selected horses finish top-3, the number of
// winning wide pairs is C(k,2) → 0, 0, 1, 3 for k = 0, 1, 2, 3. The naive
// `Σ line.prob` overcounts because those pair-probabilities OVERLAP — the
// events "pair (a,b) ⊆ top3" and "pair (a,c) ⊆ top3" are not disjoint
// (both happen whenever {a,b,c} ⊆ top3). True hit probability is
// P(at least one selected wide line is a subset of the top-3).
//
// Method: enumerate the C(n,3) possible top-3 sets, compute each set's
// probability via the trio kernel (P(this exact set is the top-3 in any
// order) = comboProb("trio", set, ...)). For each set, count how many
// ticket lines hit. Field sizes are ≤18 → C(18,3) = 816 enumerations max,
// each O(lines.length) — cheap and exact.
//
// `bestCaseReturn` is the payout sum on the single most lucrative top-3
// outcome (the "all covered horses fill the board" multi-pay scenario).
// This is the user-facing "what you'd get back on the best realistic hit"
// — required so wide tickets can't display an impossible "net loss on
// win" when their average line pays less than the stake but their 3-way
// co-hit pays well above it.
//
// Non-wide bet types do NOT route through this helper: their lines are
// genuinely mutually exclusive (at most one quinella/exacta/trio/trifecta
// line wins per race), so Σ line.prob stays the correct hitProb.
// ---------------------------------------------------------------------------
export interface WideTicketStats {
  /** True P(at least one selected wide line finishes in the top-3). */
  hitProb: number;
  /** E[number of winning lines on the day] = Σ_top3 P(top3) × winningLines. */
  expWinningLines: number;
  /** Max over top-3 outcomes of Σ(line.payout for lines hitting that outcome).
   *  The "all-covered-horses-fill-the-board" multi-pay scenario. */
  bestCaseReturn: number;
}

/**
 * Compute true wide-aware hit probability + the multi-pay best-case return.
 *
 * Caller passes the ticket's already-priced lines (each line carries its
 * `combo` and `payout`). `p` + `allUmas` are the de-vigged market the lines
 * were priced against — used to enumerate top-3 outcomes and weight them.
 */
export function wideTicketStats(
  lines: { combo: string[]; payout: number }[],
  p: Record<string, number>,
  allUmas: string[],
): WideTicketStats {
  if (lines.length === 0 || allUmas.length < 3) {
    return { hitProb: 0, expWinningLines: 0, bestCaseReturn: 0 };
  }
  // Restrict enumeration to the field the lines actually reference. A ticket
  // covering 4 horses in an 18-horse field still only cares about top-3 sets
  // containing ≥2 of its horses — but enumerating ALL C(n,3) top-3 sets is
  // O(816) worst case and the math is cleaner (the trio kernel handles the
  // weight), so we don't optimize further.
  const top3Sets = kCombos(allUmas, 3);
  let hitProb = 0;
  let expWinningLines = 0;
  let bestCaseReturn = 0;
  for (const set of top3Sets) {
    const pt = comboProb("trio", set, p, allUmas);
    if (!(pt > 0)) continue;
    const setHas = new Set(set);
    let winningLines = 0;
    let payoutSum = 0;
    for (const line of lines) {
      if (line.combo.length === 2 && setHas.has(line.combo[0]) && setHas.has(line.combo[1])) {
        winningLines += 1;
        payoutSum += line.payout;
      }
    }
    if (winningLines === 0) continue;
    hitProb += pt;
    expWinningLines += pt * winningLines;
    if (payoutSum > bestCaseReturn) bestCaseReturn = payoutSum;
  }
  return { hitProb, expWinningLines, bestCaseReturn };
}
