// ADR-0007 Phase 4 — canonical ticket-settlement resolver.
//
// This module is the SINGLE source of truth for "did a committed ticket hit,
// miss, or refund, and for how much?" The frontend imports it via a thin shim
// (`frontend/src/lib/settle.ts`); the Worker's cron sweep imports it directly.
// Keeping the rules in one place forbids the two tiers from drifting on the
// definition of a hit (a real correctness risk for quinella/wide/trio where
// order-vs-set matters and dead heats expand the winner set).
//
// Pure, no I/O, no Cloudflare deps. The expected result shape (the historical
// splash page used this; the new app consumes the same form):
//   result: {
//     finishers?: number[];                 // [1st_umaban, 2nd_umaban, ...]
//     top3?:      { pos: number; umaban: number }[];   // legacy form
//     placings?:  { pos: number; umabans: number[] }[]; // dead-heat form
//     scratched?: number[];                 // refund-eligible umabans
//     payouts?:   { pool: string; combo: string; yen: number }[];
//   }
// `payouts.yen` is per 100-yen stake (JRA convention). A line at `unit` stake
// returns `yen * unit / 100`. Combos are dash-separated umaban strings
// ("5-16" or "5-16-1"), matching netkeiba_payouts.py.
//
// Dead-heat model: `placings` lets the result carry 同着 (two umabans at one
// position). The resolver enumerates every consistent ordering (cartesian
// product across tied positions) and a line hits if it matches ANY ordering.
// This is a strict superset of the legacy single-`finishers` behavior on
// clean races; on a tie race it correctly pays combos that name any of the
// tied horses (the case the Phase 2 ADR flagged as a correctness gap).
//
// Scratch model: any combo containing a scratched umaban refunds the whole
// ticket to `{state:'refunded', reason:'scratched'}` (JRA 返還). We don't
// compute the refund amount (stake return — out of scope for this resolver);
// the sweep records the state and the UI shows a generic "refund" badge.

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
  /** Ordered umabans, 1st-first. Legacy form; converter treats each entry as one placing. */
  finishers?: number[];
  /** Legacy {pos, umaban} form (the splash page's expected shape). */
  top3?: { pos: number; umaban: number }[];
  /**
   * Placings, set per position. Handles 同着 (dead heats) — e.g.
   * `[{pos:1, umabans:[5]}, {pos:2, umabans:[16,7]}, {pos:3, umabans:[1]}]`
   * means 5 won; 16 and 7 dead-heated for 2nd; 1 was alone at 3rd.
   * When present, takes precedence over `finishers` / `top3`.
   */
  placings?: { pos: number; umabans: number[] }[];
  /** Umabans scratched from this race; any line containing one is refunded. */
  scratched?: number[];
  payouts?: { pool: string; combo: string; yen: number }[];
}

export type SettleResult =
  | { state: "open"; reason: "no_finishers_yet" }
  | { state: "won"; returned: number; source: "result" | "estimate" }
  | { state: "miss" }
  | { state: "refunded"; reason: "scratched" };

/** Empty/null/{} result — the current production shape until the producer ships. */
export function isEmptyResult(result: RaceResult | null | undefined): boolean {
  if (!result) return true;
  if (result.placings && result.placings.length > 0) return false;
  if (result.finishers && result.finishers.length > 0) return false;
  if (result.top3 && result.top3.length > 0) return false;
  return true;
}

/**
 * Normalize the result into placings-as-sets. Three input shapes converge here:
 *   - `placings` (preferred, can express 同着) — used as-is.
 *   - `finishers: number[]` (ordered) — one umaban per position; ties impossible.
 *   - `top3: {pos, umaban}[]` (legacy) — grouped by pos (a dead heat in this
 *     form has two entries with the same `pos`).
 * Returns null if no placing data is present.
 */
function placingsFromResult(
  result: RaceResult,
): { pos: number; umabans: number[] }[] | null {
  if (result.placings && result.placings.length > 0) {
    return [...result.placings]
      .sort((a, b) => a.pos - b.pos)
      .map((p) => ({ pos: p.pos, umabans: [...p.umabans] }));
  }
  if (result.finishers && result.finishers.length > 0) {
    return result.finishers.map((umaban, i) => ({ pos: i + 1, umabans: [umaban] }));
  }
  if (result.top3 && result.top3.length > 0) {
    const byPos = new Map<number, number[]>();
    for (const e of result.top3) {
      const arr = byPos.get(e.pos) ?? [];
      arr.push(e.umaban);
      byPos.set(e.pos, arr);
    }
    return [...byPos.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pos, umabans]) => ({ pos, umabans }));
  }
  return null;
}

/**
 * Enumerate every consistent ordered finish implied by the placings.
 *
 * For placings `[{pos:1,umabans:[5]}, {pos:2,umabans:[16,7]}, {pos:3,umabans:[1]}]`
 * the cartesian product yields 1×2×1 = 2 orderings: `[5,16,1]` and `[5,7,1]`.
 * Each ordering is a flat `number[]` (1st-first) the legacy `lineHits` consumes.
 *
 * The JRA semantics: a dead-heat placing is a SET — for hit purposes, any
 * horse tied at a position counts as having finished at that position.
 * Enumerating keeps `lineHits` simple (a line hits if it matches ANY
 * consistent ordering) without baking tie logic into five different bet-type
 * branches. On a clean race this collapses to one ordering (today's behavior).
 *
 * Capped at 36 orderings (a 6-way tie at one position) — beyond that the
 * result is implausible and we'd rather under-match than OOM the Worker.
 */
export function expandPlacings(
  placings: { pos: number; umabans: number[] }[],
): number[][] {
  if (placings.length === 0) return [];
  let orders: number[][] = [[]];
  for (const { umabans } of placings) {
    if (umabans.length === 0) continue;
    const next: number[][] = [];
    for (const prefix of orders) {
      for (const u of umabans) {
        next.push([...prefix, u]);
      }
    }
    orders = next;
    if (orders.length > 36) return orders.slice(0, 36);
  }
  return orders;
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
 * Sum ALL payout rows matching this pool + combo (yen per 100-yen stake).
 *
 * Dead-heat pools (quinella/wide/trio/exacta where the rules pay multiple
 * combos) legitimately have multiple payout rows for one winning line — e.g.
 * a quinella on a tie at 2nd pays (1st,2nd-a) and (1st,2nd-b), each as its
 * own row. JRA lists each as its own payout; summing mirrors what a real
 * bettor receives.
 *
 * Returns null if no payout rows match (the producer may legitimately omit a
 * pool — see the `source:'estimate'` fallback in `resolveTicket`). A 0-yen
 * payout never appears in JRA data (minimum is the stake back), so "no rows"
 * is unambiguous against "rows summed to 0".
 */
function payoutYen(
  result: RaceResult,
  type: BetType,
  combo: string[],
): number | null {
  if (!result.payouts || result.payouts.length === 0) return null;
  const want = comboKey(type, combo);
  let total = 0;
  let matched = false;
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
    if (canon === want) {
      total += p.yen;
      matched = true;
    }
  }
  return matched ? total : null;
}

/**
 * Top N finishing positions, dead-heat aware, for DISPLAY only (not used by
 * the resolver itself, which reasons over `expandPlacings`' enumerated
 * orderings). Returns null when the result carries no placing data yet.
 *
 * Callers persist this alongside a settled ticket so the UI can show what
 * actually happened in a race (1st/2nd/3rd, with ties) without having to
 * re-fetch a result block that may no longer be reachable — `/api/live` only
 * carries a rolling window of recent race days, so a result available at
 * settle time can be gone by the time someone opens the ticket later.
 */
export function topPlacings(
  result: RaceResult | null | undefined,
  n = 3,
): { pos: number; umabans: number[] }[] | null {
  if (isEmptyResult(result)) return null;
  const placings = placingsFromResult(result!);
  if (!placings || placings.length === 0) return null;
  return placings.slice(0, n);
}

/**
 * Stable serialization of the resolver-relevant fields of a result block.
 * Two semantically-equivalent result blocks (same placings/scratches/payouts,
 * possibly different array orders or row order) serialize identically so the
 * hash doesn't flap on benign producer re-emits.
 *
 * placings  — sorted by pos; umabans sorted ascending within each pos.
 * scratched — sorted ascending.
 * payouts   — sorted by (pool, combo); yen as-is.
 *
 * Lives here (not sweep.ts) so it's importable from a plain Node script —
 * this module is pure (no I/O, no Cloudflare deps), unlike sweep.ts which
 * needs D1Database + Workers' `fetch` extensions. See
 * workers/social/scripts/backfill-stuck-tickets.ts.
 */
function stableResultJson(result: RaceResult): string {
  const placings = [...(result.placings ?? [])]
    .sort((a, b) => a.pos - b.pos)
    .map((p) => ({ pos: p.pos, umabans: [...p.umabans].sort((a, b) => a - b) }));
  const scratched = [...(result.scratched ?? [])].sort((a, b) => a - b);
  const payouts = [...(result.payouts ?? [])]
    .map((p) => ({ pool: p.pool, combo: p.combo, yen: p.yen }))
    .sort((a, b) =>
      a.pool === b.pool ? a.combo.localeCompare(b.combo) : a.pool.localeCompare(b.pool),
    );
  return JSON.stringify({ placings, scratched, payouts });
}

/** SHA-256 hex digest via Web Crypto (available in Workers + Node 20+). */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Identity of the result block a ticket was settled against. Stored on the
 * ticket row; the sweep compares it to the current result's hash and
 * re-settles when they differ.
 */
export async function hashResult(result: RaceResult): Promise<string> {
  return sha256Hex(stableResultJson(result));
}

/**
 * Resolve a committed ticket to won/miss/open/refunded against a result payload.
 *
 *   - No placings in the result yet → `{state:'open', reason:...}`.
 *     The caller leaves the ticket OPEN; the UI shows the commit-time
 *     estimate (payoutBase). This is today's production path.
 *   - Any combo umaban ∈ result.scratched → `{state:'refunded', reason:'scratched'}`
 *     across the whole ticket. JRA refunds all lines containing a scratched
 *     horse (返還); we don't compute the refund amount (stake return) — the
 *     sweep records the state and the UI shows a generic "refund" badge.
 *   - Placings present, no scratch:
 *       - Any winning line (across all expanded orderings) → `state:'won'`.
 *         `returned` is Σ line payouts (yen * unit/100) when payouts are
 *         present; otherwise it falls back to the ticket's avgPayout with
 *         `source:'estimate'`.
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
  const placings = placingsFromResult(result!);
  if (!placings || placings.length === 0) {
    return { state: "open", reason: "no_finishers_yet" };
  }

  // Scratch check: any combo umaban in result.scratched refunds the ticket.
  const scratched = result!.scratched ?? [];
  if (scratched.length > 0) {
    const scratchSet = new Set(scratched);
    for (const line of ticket.lines) {
      if (line.combo.some((u) => scratchSet.has(Number(u)))) {
        return { state: "refunded", reason: "scratched" };
      }
    }
  }

  const orders = expandPlacings(placings);
  const stakeMultiplier = unit > 0 ? unit / 100 : 1;
  let totalReturned = 0;
  let anyHit = false;
  let payoutSource: "result" | "estimate" = "result";

  for (const line of ticket.lines) {
    // A line hits if it matches ANY consistent ordering (dead-heat aware).
    const hit = orders.some((order) => lineHits(ticket.type, line.combo, order));
    if (!hit) continue;
    anyHit = true;
    const yen = payoutYen(result!, ticket.type, line.combo);
    if (yen == null) {
      // Combo hit but the publisher didn't include any payout row for this
      // pool+combo. Fall back to the commit-time fair-value estimate (already
      // in avgPayout) and flag it so the UI can mark the figure as provisional.
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
