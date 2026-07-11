// ====================== CARD (shared by Open + History) ======================
// Extracted from MyTickets' inner renderCard (2026-07-08 split — behavior
// preserving). The same card renders in both the Open section and the expanded
// History section. Callers put `key={tk.id}` on <TicketCard> so React
// reconciles by ticket id across the two lists.
import React from "react";
import type { CommittedTicket } from "../../lib/types";
import { MT_MOOD_COLOR, mtSep, mtStateColor } from "../../lib/mytickets-view";
import { yen } from "../../lib/format";
import type { MtCtx } from "./ctx";

export function TicketCard({ tk, ctx }: { tk: CommittedTicket; ctx: MtCtx }) {
  const {
    t,
    ja,
    driftView,
    liveOdds,
    runnerName,
    countdownText,
    runnerRaceName,
    openDetail,
    setManualEditId,
    setView,
    burstId,
    burstSpans,
  } = ctx;
  const open = tk.state === "open";
  const sep = mtSep(tk.ticket.type);
  const topNum = Number(tk.ticket.lines[0]?.combo[0] ?? 0);
  const topR = tk.race.runners.find((r) => r.num === topNum);
  const d = driftView(topNum, tk, open);
  const ownerYou = tk.owner === "you";
  const payLabel =
    tk.state === "won" ? t("mine.returned") : t("mine.ifHits");
  const payValue =
    tk.state === "won" ? tk.returned ?? 0 : tk.payoutBase;
  const payColor =
    tk.state === "won"
      ? "var(--gold-amber)"
      : tk.state === "miss"
        ? "var(--miss)"
        : "var(--ink)";
  return (
    <div
      className="mt-card"
      onClick={() => openDetail(tk.id)}
      role="button"
      tabIndex={0}
    >
      <div
        className="mt-stripe"
        style={{ background: mtStateColor(tk.state) }}
      />
      <div className="mt-card-body">
        <div className="mt-card-top">
          <div className="mt-card-top-main">
            <div className="mt-badges">
              <span
                className="mt-state-badge"
                style={{ background: mtStateColor(tk.state) }}
              >
                {open ? t("mine.live") : t("mine.result")}
              </span>
              {tk.race.grade && (
                <span className="mt-grade-badge">{tk.race.grade}</span>
              )}
            </div>
            <div className="mt-card-race">{runnerRaceName(tk)}</div>
          </div>
          <span
            className="mt-mood-pill"
            style={{ background: MT_MOOD_COLOR[tk.mood] }}
          >
            {t(`mood.${tk.mood}`)}
          </span>
          {open && (
            <button
              type="button"
              className="mt-card-edit"
              aria-label={t("manual.editAria")}
              onClick={(e) => {
                // Stop propagation so the card's openDetail(id) doesn't fire
                // and double-route (card→detail + edit→manual at once).
                e.stopPropagation();
                setManualEditId(tk.id);
                setView("manual");
              }}
            >
              ✎
            </button>
          )}
        </div>

        <div className="mt-betline">
          <span className="mt-bet-label">
            {t(`betType.${tk.ticket.type}`)}
          </span>
          <div className="mt-chips">
            {tk.ticket.lines.slice(0, 4).map((ln, j) => (
              <span key={j} className="mt-chip">
                {ln.combo.join(sep)}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-metrics">
          <div>
            <div className="mt-metric-label">{t("mine.cost")}</div>
            <div className="mt-metric-cost">{yen(tk.ticket.cost)}</div>
          </div>
          <div>
            <div className="mt-metric-label">{payLabel}</div>
            <div className="mt-metric-pay" style={{ color: payColor }}>
              {yen(payValue)}
            </div>
          </div>
        </div>

        {open && (
          <div className="mt-live-strip">
            <div className="mt-live-row">
              <span className="mt-dot-sm" />
              <span className="mt-live-contender">
                #{topNum} {topR ? runnerName(topR) : ""}
              </span>
              <span className="mt-live-odds">
                {liveOdds(tk, topNum).toFixed(1)}
              </span>
              <span className="mt-drift" style={{ color: d.color }}>
                {d.arrow} {d.label}
              </span>
              <span className="mt-countdown">
                {countdownText(tk.race.post)}
              </span>
            </div>
            <div className="mt-refresh">
              <i />
            </div>
          </div>
        )}

        {!open && (
          <div className="mt-owner-row">
            <div
              className="mt-owner-avatar"
              style={{
                background: ownerYou
                  ? "var(--turf)"
                  : (tk.owner as { color: string }).color,
              }}
            >
              {ownerYou
                ? ja
                  ? "私"
                  : "Y"
                : ja
                  ? (tk.owner as { initialJa: string }).initialJa
                  : (tk.owner as { initial: string }).initial}
            </div>
            <span className="mt-owner-line">
              {ownerYou
                ? tk.state === "won"
                  ? t("mine.won")
                  : t("mine.settled")
                : `${ja ? (tk.owner as { ja: string }).ja : (tk.owner as { en: string }).en} · ${t("mine.hit")}`}
            </span>
            {tk.state === "won" && burstId === tk.id && (
              <span className="mt-burst-host" aria-hidden="true">{burstSpans}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
