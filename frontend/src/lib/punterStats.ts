// ============================================================================
// Punter stats — pure aggregation over the resolved subset of a user's ticket
// feed. Used by the My Tickets "Show history" panel to surface hit/miss counts,
// wagered/returned, Net P/L, ROI %, and the biggest single-race return.
//
// Pure: no I/O, no React. Iterates the resolved subset once. Locale-aware name
// + date selection via Lang and the race snapshot fields on CommittedTicket.
//
// Accounting rules:
//   • wagered  = Σ ticket.ticket.cost over all resolved (won + miss + refunded).
//     `cost` is the actual yen committed (lines × unit), NOT `payoutBase` (the
//     pre-race "if it hits" estimate). Punter stats use the real stake.
//   • returned = Σ (won → ticket.returned; refunded → ticket.ticket.cost, since
//     a refund by definition returns the stake; miss → 0). Treating refunds as
//     net-zero keeps Net P/L honest — a scratched-horse refund is not a loss.
//   • net      = returned − wagered (can be negative).
//   • roi      = net / wagered, or null iff wagered === 0 (defensive — shouldn't
//     happen since every resolved ticket has a positive cost).
//   • biggestWin = the won ticket with the highest `returned`; ties broken by
//     the most recent `createdAt`. null iff wonCount === 0 (refunds don't count).
// ============================================================================

import type { Lang } from "../i18n";
import type { CommittedTicket } from "./types";

export interface BiggestWin {
  amount: number;
  raceName: string; // locale-aware: nameEn | nameJa
  raceKey: string;
  date: string; // locale-aware: dateEn | dateJa
}

export interface PunterStats {
  resolvedCount: number; // won + miss + refunded
  wonCount: number;
  missCount: number;
  refundedCount: number;
  wagered: number;
  returned: number;
  net: number; // returned − wagered (can be negative)
  roi: number | null; // net / wagered; null iff wagered === 0
  biggestWin: BiggestWin | null; // null iff wonCount === 0
}

const EMPTY_STATS: PunterStats = {
  resolvedCount: 0,
  wonCount: 0,
  missCount: 0,
  refundedCount: 0,
  wagered: 0,
  returned: 0,
  net: 0,
  roi: null,
  biggestWin: null,
};

/**
 * Compute punter aggregates over a list of resolved tickets. Open tickets are
 * ignored (they are not part of history). The function is total: an empty or
 * all-open input returns EMPTY_STATS.
 */
export function computePunterStats(
  tickets: CommittedTicket[],
  lang: Lang,
): PunterStats {
  let wonCount = 0;
  let missCount = 0;
  let refundedCount = 0;
  let wagered = 0;
  let returned = 0;

  // Best won ticket seen so far (highest returned; ties → most recent createdAt).
  let bestId: string | null = null;
  let bestAmount = -1;
  let bestCreatedAt = -Infinity;

  for (const tk of tickets) {
    if (tk.state === "open") continue;
    const cost = tk.ticket.cost;
    wagered += cost;

    if (tk.state === "won") {
      wonCount += 1;
      const amt = tk.returned ?? 0;
      returned += amt;
      // Tie-break: strictly-greater amount wins; on equal amount, the newer
      // ticket (greater createdAt) wins. We update when amount is greater OR
      // (equal AND newer).
      if (
        amt > bestAmount ||
        (amt === bestAmount && tk.createdAt > bestCreatedAt)
      ) {
        bestAmount = amt;
        bestCreatedAt = tk.createdAt;
        bestId = tk.id;
      }
    } else if (tk.state === "miss") {
      missCount += 1;
      // returned += 0
    } else if (tk.state === "refunded") {
      refundedCount += 1;
      // Refund = stake returned; nets to zero in P/L.
      returned += cost;
    }
  }

  const resolvedCount = wonCount + missCount + refundedCount;
  if (resolvedCount === 0) return EMPTY_STATS;

  const net = returned - wagered;
  const roi = wagered === 0 ? null : net / wagered;

  let biggestWin: BiggestWin | null = null;
  if (bestId !== null) {
    // Re-find the winning ticket by id (O(n) again, but N is small — a user's
    // resolved history. Kept simple to avoid threading state through the loop).
    const win = tickets.find((tk) => tk.id === bestId);
    if (win) {
      biggestWin = {
        amount: bestAmount,
        raceName: lang === "ja" ? win.race.nameJa || win.race.nameEn : win.race.nameEn,
        raceKey: win.race.raceKey,
        date: lang === "ja" ? win.race.dateJa || win.race.dateEn : win.race.dateEn,
      };
    }
  }

  return {
    resolvedCount,
    wonCount,
    missCount,
    refundedCount,
    wagered,
    returned,
    net,
    roi,
    biggestWin,
  };
}
