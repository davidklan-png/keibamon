// ============================================================================
// HistoryAggregates — punter stat grid shown at the top of the expanded
// History section. Stateless; calls useI18n() for locale + strings. Renders a
// 3-col × 2-row grid: Hit/miss · Wagered · Returned · Net P/L · ROI · Biggest
// win. Module scope so it isn't re-created (and re-mounted) on every parent
// render. (Moved verbatim out of MyTickets.tsx in the 2026-07-08 split.)
//
// `tickets` is the RESOLVED subset (open already filtered out upstream). The
// stats module is total — an empty input yields zero counts — but this
// component is only rendered inside the history section which is itself
// gated on `resolvedTk.length > 0`, so the empty path is defensive.
// ============================================================================
import React from "react";
import { useI18n } from "../../i18n";
import type { CommittedTicket } from "../../lib/types";
import { computePunterStats } from "../../lib/punterStats";
import { yen } from "../../lib/format";

export function HistoryAggregates({ tickets }: { tickets: CommittedTicket[] }) {
  const { t, tFmt, lang } = useI18n();
  const stats = computePunterStats(tickets, lang);

  // Sign classes: positive → gold-amber, negative → red (danger). Zero/empty
  // → neutral ink (no modifier). Applied to Net P/L and ROI only.
  const netClass =
    stats.net > 0 ? "mt-stat-value--pos" : stats.net < 0 ? "mt-stat-value--neg" : "";
  const roiClass =
    stats.roi !== null && stats.roi > 0
      ? "mt-stat-value--pos"
      : stats.roi !== null && stats.roi < 0
        ? "mt-stat-value--neg"
        : "";
  const roiText =
    stats.roi === null ? t("mine.stats.none") : `${(stats.roi * 100).toFixed(1)}%`;

  return (
    <div className="mt-stats-grid" role="table" aria-label="Punter stats">
      <div className="mt-stat">
        <div className="mt-stat-label">{t("mine.stats.hitMiss")}</div>
        <div className="mt-stat-value">
          {stats.wonCount} / {stats.missCount}
        </div>
      </div>
      <div className="mt-stat">
        <div className="mt-stat-label">{t("mine.stats.wagered")}</div>
        <div className="mt-stat-value">{yen(stats.wagered)}</div>
      </div>
      <div className="mt-stat">
        <div className="mt-stat-label">{t("mine.stats.returned")}</div>
        <div className="mt-stat-value">{yen(stats.returned)}</div>
      </div>
      <div className="mt-stat">
        <div className="mt-stat-label">{t("mine.stats.net")}</div>
        <div className={`mt-stat-value ${netClass}`.trim()}>{yen(stats.net)}</div>
      </div>
      <div className="mt-stat">
        <div className="mt-stat-label">{t("mine.stats.roi")}</div>
        <div className={`mt-stat-value ${roiClass}`.trim()}>{roiText}</div>
      </div>
      <div className="mt-stat">
        <div className="mt-stat-label">{t("mine.stats.biggestWin")}</div>
        <div className="mt-stat-value">
          {stats.biggestWin
            ? yen(stats.biggestWin.amount)
            : t("mine.stats.none")}
        </div>
        {stats.biggestWin && (
          <div className="mt-stat-sub">
            {tFmt("mine.stats.biggestWinRace", {
              name: stats.biggestWin.raceName,
              date: stats.biggestWin.date,
            })}
          </div>
        )}
      </div>
    </div>
  );
}
