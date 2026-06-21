// ADR-0007 Phase 4 — canonical ticket-settlement resolver.
//
// This module is the SINGLE source of truth for "did a committed ticket hit
// or miss, and for how much?" The frontend imports it via a thin shim
// (`frontend/src/lib/settle.ts`); the Worker's cron sweep imports it directly.
// Keeping the rules in one place forbids the two tiers from drifting on the
// definition of a hit (a real correctness risk for quinella/wide/trio where
// order-vs-set matters).
//
// Pure, no I/O, no Cloudflare deps — a faithful extraction of the verbatim
// Phase 2 logic (commit `e357b8e`). Phase 4 Task 2 extends this with
// dead-heat + scratch handling; that's a separate change on top of this move.
//
// The expected result shape (the historical splash page used this; the new
// app consumes the same form):
//   result: {
//     finishers?: number[];                 // [1st_umaban, 2nd_umaban, ...]
//     top3?:      { pos: number; umaban: number }[];   // legacy form
//     payouts?:   { pool: string; combo: string; yen: number }[];
//   }
// `payouts.yen` is per 100-yen stake (JRA convention). A line at `unit` stake
// returns `yen * unit / 100`. Combos are dash-separated umaban strings
// ("5-16" or "5-16-1"), matching netkeiba_payouts.py.

/** The five exotic bet types the recommender emits. */
export type BetType = "quinella" | "wide" | "exacta" | "trio" | "trifecta";

/**
 * Minimal structural input — what the resolver actually reads. The frontend's
 * richer `Ticket` (lib/types.ts) is structurally compatible, so the call site
 * `resolveTicket(tk.ticket, tk.unit, result)` in App.tsx is unchanged.
 */
export interface ResolveTicket {
  type: BetType;
  /** Each line is one combination; `combo` is the umaban strings. */
  lines: { combo: string[] }[];
  /** Commit-time fair-value estimate; used when payouts are absent. */
  avgPayout: number;
}

export interface RaceResult {
  finishers?: number[];
  top3?: { pos: number; umaban: number }[];
  payouts?: { pool: string; combo: string; yen: number }[];
}

export type SettleResult =
  | { state: "open"; reason: "no_finishers_yet" }
  | { state: "won"; returned: number; source: "result" | "estimate" }
  | { state: "miss" };

/** Empty/null/{} result — the current production shape until the producer ships. */
export function isEmptyResult(result: RaceResult | null | undefined): boolean {
  if (!result) return true;
  if (result.finishers && result.finishers.length > 0) return false;
  if (result.top3 && result.top3.length > 0) return false;
  return true;
}

/** Normalize the finishing order to an umaban array, or null if absent. */
function finishingOrder(result: RaceResult): number[] | null {
  if (result.finishers && result.finishers.length > 0) {
    return result.finishers;
  }
  if (result.top3 && result.top3.length > 0) {
    return [...result.top3]
      .sort((a, b) => a.pos - b.pos)
      .map((e) => e.umaban);
  }
  return null;
}

function sameSet(as: string[], bs: number[]): boolean {
  if (as.length !== bs.length) return false;
  const asSet = new Set(as.map((x) => Number(x)));
  for (const b of bs) if (!asSet.has(b)) return false;
  return true;
}

function sameOrder(as: string[], bs: number[]): boolean {
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) {
    if (Number(as[i]) !== bs[i]) return false;
  }
  return true;
}

/**
 * Did a single line (combo) hit, given the bet type and the ordered finish?
 *
 *   exacta / trifecta  → ordered match against the top of the finish
 *   quinella           → unordered match against the top 2
 *   trio               → unordered match against the top 3
 *   wide               → both combos finish in the top 3
 */
export function lineHits(type: BetType, combo: string[], order: number[]): boolean {
  if (!combo || combo.length === 0 || !order || order.length === 0) return false;
  if (type === "exacta") {
    return sameOrder(combo, order.slice(0, 2));
  }
  if (type === "trifecta") {
    return sameOrder(combo, order.slice(0, 3));
  }
  if (type === "quinella") {
    return sameSet(combo, order.slice(0, 2));
  }
  if (type === "trio") {
    return sameSet(combo, order.slice(0, 3));
  }
  if (type === "wide") {
    const top3 = new Set(order.slice(0, 3));
    return combo.every((u) => top3.has(Number(u)));
  }
  return false;
}

/**
 * Build the dash-separated combo string the payouts table uses.
 *   exacta "5-16"  (ordered: 1st-2nd)
 *   trifecta "5-16-1"
 *   quinella "5-16"  (unordered; canonical sorted form)
 *   trio "1-5-16"    (unordered; canonical sorted form)
 *   wide   "1-5"     (one per winning pair — caller loops)
 *
 * For wide, multiple pairs can hit per ticket; this helper returns the
 * canonical form for ONE pair.
 */
function comboKey(type: BetType, combo: string[]): string {
  const nums = combo.map((x) => Number(x));
  if (type === "exacta" || type === "trifecta") {
    return nums.join("-"); // preserve order
  }
  // Unordered — canonicalize ascending so it matches netkeiba's payout rows
  // regardless of how the recommender enumerated the combo.
  return [...nums].sort((a, b) => a - b).join("-");
}

/**
 * Look up a single winning line's payout (yen per 100-yen stake).
 * Returns null if the pool/combo isn't in the result (the producer may
 * legitimately omit a pool that had no winning tickets sold — but for the
 * 5 exotic types the recommender emits, JRA always pays out if the combo
 * hit, so a missing row is a publisher gap, not a real miss).
 */
function payoutYen(
  result: RaceResult,
  type: BetType,
  combo: string[],
): number | null {
  if (!result.payouts || result.payouts.length === 0) return null;
  const want = comboKey(type, combo);
  for (const p of result.payouts) {
    if (p.pool !== type) continue;
    // Normalize the publisher's combo to canonical (sorted-ascending for
    // unordered types) so "16-5" matches our "5-16".
    const canon =
      type === "exacta" || type === "trifecta"
        ? p.combo
        : p.combo
            .split("-")
            .map((x) => Number(x))
            .sort((a, b) => a - b)
            .join("-");
    if (canon === want) return p.yen;
  }
  return null;
}

/**
 * Resolve a committed ticket to won/miss/open against a result payload.
 *
 *   - No finishing order in the result yet → `{state:'open', reason:...}`.
 *     The caller leaves the ticket OPEN; the UI shows the commit-time
 *     estimate (payoutBase). This is today's production path.
 *   - Finishing order present:
 *       - Any winning line  → `state:'won'`. `returned` is Σ line payouts
 *         (yen * unit/100) when payouts are present; otherwise it falls back
 *         to the ticket's avgPayout with `source:'estimate'`.
 *       - No winning line   → `state:'miss'`, returned = 0.
 */
export function resolveTicket(
  ticket: ResolveTicket,
  unit: number,
  result: RaceResult | null | undefined,
): SettleResult {
  if (isEmptyResult(result)) {
    return { state: "open", reason: "no_finishers_yet" };
  }
  const order = finishingOrder(result!) ?? [];
  if (order.length === 0) {
    return { state: "open", reason: "no_finishers_yet" };
  }

  const stakeMultiplier = unit > 0 ? unit / 100 : 1;
  let totalReturned = 0;
  let anyHit = false;
  let payoutSource: "result" | "estimate" = "result";

  for (const line of ticket.lines) {
    if (!lineHits(ticket.type, line.combo, order)) continue;
    anyHit = true;
    const yen = payoutYen(result!, ticket.type, line.combo);
    if (yen == null) {
      // Combo hit but the publisher didn't include the payout row. Fall back
      // to the commit-time fair-value estimate (already in avgPayout) and
      // flag it so the UI can mark the figure as provisional.
      payoutSource = "estimate";
      totalReturned += ticket.avgPayout * stakeMultiplier;
    } else {
      totalReturned += yen * stakeMultiplier;
    }
  }

  if (!anyHit) {
    return { state: "miss" };
  }
  return {
    state: "won",
    returned: Math.round(totalReturned),
    source: payoutSource,
  };
}
