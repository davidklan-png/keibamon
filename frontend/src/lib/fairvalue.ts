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
};

export type BetType = "quinella" | "wide" | "exacta" | "trio" | "trifecta";

export interface Runner {
  /** Saddle number as a string key (kept stable across re-renders). */
  uma: string;
  /** Display name, optional. */
  name?: string | null;
  /** Decimal win odds (>= 1.0). Runners with odds <= 0 are treated as scratched. */
  odds: number;
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
