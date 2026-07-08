// ====================== DETAIL ======================
// Extracted from MyTickets' inner renderDetail (2026-07-08 split — behavior
// preserving; all state/actions come through MtCtx, including detailCardRef
// which the share exporter rasters).
import React from "react";
import { MT_MOOD_COLOR, avatarColor, mtSep } from "../../lib/mytickets-view";
import { yen } from "../../lib/format";
import type { MtCtx } from "./ctx";

export function DetailView({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    tFmt,
    ja,
    detailTk,
    setView,
    detailCardRef,
    settleId,
    runnerRaceName,
    countdownText,
    driftView,
    liveOdds,
    runnerName,
    settle,
    doShare,
    cheer,
    burstId,
    burstSpans,
    setReportTarget,
    friendsOnRace,
    openProfile,
  } = ctx;
  const tk = detailTk;
  if (!tk) return null;
  const open = tk.state === "open";
  const sep = mtSep(tk.ticket.type);
  const ribbon =
    open
      ? "linear-gradient(135deg,#0E7A47,#16AC66)"
      : tk.state === "won"
        ? "linear-gradient(135deg,#D98A12,#F2A93B)"
        : "linear-gradient(135deg,#5E6E63,#8A9A8E)";
  const payLabel = tk.state === "won" ? t("mine.returned") : t("mine.ifHits");
  const payValue = tk.state === "won" ? tk.returned ?? 0 : tk.payoutBase;
  const payColor =
    tk.state === "won"
      ? "var(--gold-amber)"
      : tk.state === "miss"
        ? "var(--miss)"
        : "var(--ink)";
  const topNum = Number(tk.ticket.lines[0]?.combo[0] ?? 0);
  const board = tk.race.runners.slice(0, 6);
  const justSettled = settleId === tk.id;

  return (
    <>
      <div className="mt-back-head">
        <button className="mt-back" onClick={() => setView("feed")}>
          ‹
        </button>
        <div className="mt-back-title">{t("mine.ticketTitle")}</div>
      </div>

      <div className="mt-detail">
        <div className="mt-ticket" ref={detailCardRef}>
          {justSettled && (
            <div className="mt-confetti">
              {[
                ["8%", "#15A862", 8, 13, "2px", "1.5s", "0s"],
                ["20%", "#F2A93B", 7, 10, "2px", "1.7s", ".1s"],
                ["33%", "#2D8CF0", 9, 9, "50%", "1.4s", ".05s"],
                ["46%", "#FF6A6A", 7, 12, "2px", "1.65s", ".18s"],
                ["58%", "#F2A93B", 8, 8, "50%", "1.5s", ".08s"],
                ["70%", "#15A862", 7, 11, "2px", "1.75s", ".14s"],
                ["82%", "#FF6A6A", 9, 9, "50%", "1.45s", ".03s"],
                ["92%", "#2D8CF0", 7, 12, "2px", "1.6s", ".2s"],
              ].map((c, i) => (
                <span
                  key={i}
                  style={{
                    left: c[0] as string,
                    width: c[2] as number,
                    height: c[3] as number,
                    borderRadius: c[4] as string,
                    background: c[1] as string,
                    animationDuration: c[5] as string,
                    animationDelay: c[6] as string,
                  }}
                />
              ))}
            </div>
          )}

          <div className="mt-ribbon" style={{ background: ribbon }}>
            <div className="mt-ribbon-top">
              <div className="mt-ribbon-brand">
                <div className="mt-ribbon-mark">競</div>
                <span className="mt-ribbon-wordmark">KEIBAMON</span>
              </div>
              <span className="mt-serial">{tk.serial}</span>
            </div>
            <div className="mt-ribbon-pills">
              {tk.race.grade && (
                <span className="mt-ribbon-pill">{tk.race.grade}</span>
              )}
              <span className="mt-ribbon-pill">
                {open ? t("mine.live") : t("mine.result")}
              </span>
            </div>
            <div className="mt-ribbon-race">{runnerRaceName(tk)}</div>
            <div className="mt-ribbon-meta">
              {tk.race.venueEn} · R{tk.race.raceNo} ·{" "}
              {ja ? tk.race.dateJa : tk.race.dateEn}
              {tk.race.post ? ` · ${t("mine.post")} ${tk.race.post}` : ""}
            </div>
          </div>

          <div className="mt-perf">
            <i className="l" />
            <i className="r" />
          </div>

          <div className="mt-ticket-body">
            <div className="mt-ticket-bethead">
              <span className="mt-ticket-betlabel">
                {t(`betType.${tk.ticket.type}`)}
              </span>
              <span
                className="mt-mood-pill"
                style={{ background: MT_MOOD_COLOR[tk.mood] }}
              >
                {t(`mood.${tk.mood}`)}
              </span>
            </div>

            <div className="mt-chips-lg">
              {tk.ticket.lines.map((ln, j) => (
                <span key={j} className="mt-chip-lg">
                  {ln.combo.join(sep)}
                </span>
              ))}
            </div>

            <div className="mt-pay-panel">
              <div>
                <div className="mt-metric-label">{t("mine.cost")}</div>
                <div className="mt-pay-cost">{yen(tk.ticket.cost)}</div>
                <div className="mt-pay-break">
                  {tk.ticket.lines.length}
                  {ja ? "点 × " : " × "}
                  {yen(tk.unit)}
                </div>
              </div>
              <div className="mt-pay-right">
                <div className="mt-metric-label">{payLabel}</div>
                <div className="mt-pay-value" style={{ color: payColor }}>
                  {yen(payValue)}
                </div>
              </div>
            </div>

            {open && (
              <div className="mt-board">
                <div className="mt-board-head">
                  <span className="mt-dot-sm" />
                  <span className="mt-board-title">{t("mine.liveOdds")}</span>
                  <span className="mt-board-sub">{t("mine.oddsRefresh")}</span>
                  <span className="mt-countdown">
                    {countdownText(tk.race.post)}
                  </span>
                </div>
                <div className="mt-refresh" style={{ marginBottom: 10 }}>
                  <i />
                </div>
                {board.map((r) => {
                  const top = r.num === topNum;
                  const d = driftView(r.num, tk, open);
                  return (
                    <div key={r.num} className="mt-board-row">
                      <span
                        className="mt-board-num"
                        style={{
                          background: top ? "var(--turf)" : "var(--tint-3)",
                          color: top ? "#fff" : "var(--ink-2)",
                        }}
                      >
                        {r.num}
                      </span>
                      <span className="mt-board-name">{runnerName(r)}</span>
                      <span
                        className="mt-board-drift"
                        style={{ color: d.color }}
                      >
                        {d.arrow} {d.label}
                      </span>
                      <span className="mt-board-odds">
                        {liveOdds(tk, r.num).toFixed(1)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {!open && (
              <div
                className="mt-result"
                style={{
                  background:
                    tk.state === "won" ? "var(--won-bg)" : "var(--miss-bg)",
                  border: `1px solid ${tk.state === "won" ? "var(--gold-border)" : "var(--line)"}`,
                }}
              >
                <div
                  className="mt-stamp"
                  style={{
                    background:
                      tk.state === "won" ? "var(--gold-amber)" : "#8A9A8E",
                    animation: justSettled ? "kbmStamp .6s ease-out" : "none",
                  }}
                >
                  {tk.state === "won"
                    ? t("mine.hit")
                    : tk.state === "refunded"
                      ? t("mine.refund")
                      : t("mine.miss")}
                </div>
                <div>
                  <div className="mt-result-caption">
                    {tk.state === "won"
                      ? t("mine.returned")
                      : tk.state === "refunded"
                        ? t("mine.refunded")
                        : t("mine.settled")}
                  </div>
                  <div
                    className="mt-result-value"
                    style={{
                      color:
                        tk.state === "won" ? "var(--gold-amber)" : "#8A9A8E",
                    }}
                  >
                    {yen(payValue)}
                  </div>
                </div>
              </div>
            )}

            {/* R5: the actual finishing order, dead-heat aware, captured at
                settle time. Absent on tickets settled before this field
                existed (or a straggler that never settled automatically —
                see the "why didn't this settle" investigation) — the
                fallback line is honest about that rather than showing
                nothing with no explanation. */}
            {!open && (
              <div className="mt-finish">
                <div className="mt-board-title" style={{ marginBottom: 6 }}>
                  {t("mine.finishOrder")}
                </div>
                {tk.placings && tk.placings.length > 0 ? (
                  tk.placings.map((p) => (
                    <div key={p.pos} className="mt-finish-row">
                      <span className="mt-finish-pos">
                        {t(`fillGuide.pos${p.pos}`) || `#${p.pos}`}
                      </span>
                      <span className="mt-finish-names">
                        {p.umabans
                          .map((u) => {
                            const r = tk.race.runners.find((x) => x.num === u);
                            return `#${u} ${r ? runnerName(r) : ""}`.trim();
                          })
                          .join(" / ")}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="hint">{t("mine.finishOrderUnavailable")}</p>
                )}
              </div>
            )}

            <div className="mt-card-foot">
              <div className="mt-card-foot-mark">競</div>
              <div style={{ lineHeight: 1.2 }}>
                <div className="mt-handle">{t("mine.handle")}</div>
                <div className="mt-card-foot-micro" data-not-advice="">{t("auth.disclaimer")}</div>
              </div>
              <div className="mt-barcode" />
            </div>
          </div>
        </div>

        {open && import.meta.env.DEV && (
          <button className="mt-watch" onClick={() => settle(tk.id)}>
            <span className="mt-dot" />
            {t("mine.watchResult")}
          </button>
        )}

        <div className="mt-actions">
          <button
            className="mt-share"
            onClick={() => void doShare()}
          >
            <span style={{ fontSize: 16 }}>⇪</span>
            {t("mine.tapShare")}
          </button>
          {tk.state === "won" && (
            <button className="mt-cheer-lg" onClick={() => cheer(tk.id)}>
              <span style={{ fontSize: 16 }}>👏</span>
              {tk.cheers ?? tk.claps}
              {burstId === tk.id && burstSpans}
            </button>
          )}
          {/* Phase 4 — ticket report. Anyone can report any ticket
              (including their own — the moderation queue decides). */}
          <button
            className="mt-report-btn"
            onClick={() =>
              setReportTarget({ type: "ticket", id: tk.id })
            }
          >
            {t("profile.report")}
          </button>
        </div>

        <div className="mt-friends">
          <div className="mt-avatars">
            {(friendsOnRace[tk.race.raceKey]?.avatars ?? [])
              .slice(0, 8)
              .map((f, i) => (
                <div
                  key={i}
                  className="mt-avatar"
                  style={{ background: avatarColor(f.handle ?? f.display_name ?? "") }}
                  onClick={(e) => {
                    if (f.handle) {
                      e.stopPropagation();
                      openProfile(f.handle);
                    }
                  }}
                  role={f.handle ? "button" : undefined}
                  tabIndex={f.handle ? 0 : undefined}
                >
                  {(f.handle ?? f.display_name ?? "?").charAt(0).toUpperCase()}
                </div>
              ))}
          </div>
          <div className="mt-friends-text">
            {tFmt("mine.friendsOnRace", {
              n: friendsOnRace[tk.race.raceKey]?.count ?? 0,
            })}
          </div>
        </div>
      </div>
    </>
  );
}
