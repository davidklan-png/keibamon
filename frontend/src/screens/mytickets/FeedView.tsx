// ====================== FEED ======================
// Extracted from MyTickets' inner renderFeed (2026-07-08 split — behavior
// preserving; all state/actions come through MtCtx).
import React from "react";
import type { CommittedTicket } from "../../lib/types";
import { avatarColor, mtFmtDate } from "../../lib/mytickets-view";
import type { MtCtx } from "./ctx";
import { TicketCard } from "./TicketCard";
import { HistoryAggregates } from "./HistoryAggregates";

/** The raceKey's leading YYYYMMDD token (see mtRaceKey/raceKeyOf) — sortable as a string. */
function raceDateOf(tk: CommittedTicket): string {
  return tk.race.raceKey.split("|")[0] || "";
}

export function FeedView({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    tFmt,
    lang,
    friendsOnCard,
    openProfile,
    feature,
    fallbackDate,
    countdownText,
    tickets,
    historyExpanded,
    setHistoryExpanded,
    setView,
  } = ctx;
  return (
    <>
      {/* Social UX Fixes (Phase A): the brand + lang-toggle + "Browse races"
          row that lived here in .mt-head is gone. The shared <AppHeader /> in
          the App shell carries the brand + EN/JP toggle on every screen, and
          the always-present <BottomTabBar /> (Races tab) replaces the old
          "Browse races" button. This view is now just the feed body. */}
      <div className="mt-feed">
        {friendsOnCard.count > 0 && (
          <div className="mt-community">
            <div className="mt-avatars">
              {friendsOnCard.avatars.slice(0, 8).map((f, i) => (
                <div
                  key={i}
                  className="mt-avatar"
                  style={{ background: avatarColor(f.handle ?? f.display_name ?? "") }}
                  onClick={() =>
                    f.handle && openProfile(f.handle)
                  }
                  role={f.handle ? "button" : undefined}
                  tabIndex={f.handle ? 0 : undefined}
                >
                  {(f.handle ?? f.display_name ?? "?").charAt(0).toUpperCase()}
                </div>
              ))}
            </div>
            <div className="mt-community-text">
              {tFmt("mine.communityCard", { n: friendsOnCard.count })}
            </div>
          </div>
        )}

        {feature && (
          <div className="mt-banner">
            <div className="mt-banner-inner">
              <div className="mt-banner-eyebrow">
                <span className="mt-dot mt-dot-gold" />
                <span>
                  {t("mine.live")} · {t("mine.raceDay")}
                </span>
              </div>
              <div className="mt-banner-name">{feature.name}</div>
              <div className="mt-banner-foot">
                <span className="mt-banner-meta">
                  {feature.venue} · R{feature.race_no} ·{" "}
                  {mtFmtDate(feature.date ?? fallbackDate ?? "", lang)}
                </span>
                {countdownText(feature.post_time ?? "") && (
                  <span className="mt-chip-countdown">
                    {countdownText(feature.post_time ?? "")}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="mt-section-head">
          <h2>{t("mine.home")}</h2>
          <span className="mt-count">
            {tFmt("mine.count", { n: tickets.length })}
          </span>
        </div>

        {tickets.length === 0 && (
          <p className="empty">{t("mine.empty")}</p>
        )}

        {(() => {
          // Sort by race date (the leading YYYYMMDD token of raceKey — see
          // mtRaceKey/raceKeyOf), not ticket creation order. Open tickets:
          // soonest race first (what's coming up). Resolved: most recent
          // result first (what just happened). Ties (same-day tickets)
          // keep their relative creation order (Array#sort is stable).
          const openTk = tickets
            .filter((tk) => tk.state === "open")
            .sort((a, b) => raceDateOf(a).localeCompare(raceDateOf(b)));
          const resolvedTk = tickets
            .filter((tk) => tk.state !== "open")
            .sort((a, b) => raceDateOf(b).localeCompare(raceDateOf(a)));
          return (
            <>
              {/* "Open" sub-label renders only when there's a real split —
                  avoids a redundant header when the user has only live OR
                  only resolved tickets. The "My tickets · N total" header
                  above already covers the single-section case. */}
              {openTk.length > 0 && resolvedTk.length > 0 && (
                <div className="mt-section-head">
                  <h2>{t("mine.open")}</h2>
                  <span className="mt-count">{openTk.length}</span>
                </div>
              )}
              {openTk.map((tk) => (
                <TicketCard key={tk.id} tk={tk} ctx={ctx} />
              ))}

              {resolvedTk.length > 0 && (
                <>
                  <button
                    type="button"
                    className="mt-section-toggle"
                    onClick={() => setHistoryExpanded((v) => !v)}
                    aria-expanded={historyExpanded}
                  >
                    <span aria-hidden>{historyExpanded ? "▼" : "▶"}</span>
                    <span>
                      {historyExpanded
                        ? t("mine.hideHistory")
                        : tFmt("mine.showHistory", { n: resolvedTk.length })}
                    </span>
                  </button>
                  {historyExpanded && (
                    <div className="mt-history">
                      <HistoryAggregates tickets={resolvedTk} />
                      {resolvedTk.map((tk) => (
                        <TicketCard key={tk.id} tk={tk} ctx={ctx} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}
      </div>

      <button className="mt-fab" onClick={() => setView("new")}>
        <span>+</span>
        {t("mine.newBet")}
      </button>
    </>
  );
}
