// ====================== PROFILE (Phase 3) ======================
// Extracted from MyTickets' inner renderProfile (2026-07-08 split — behavior
// preserving; all state/actions come through MtCtx).
import React from "react";
import { avatarColor, mtSep, mtStateColor } from "../../lib/mytickets-view";
import { yen } from "../../lib/format";
import type { MtCtx } from "./ctx";

export function ProfileView({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    tFmt,
    setView,
    profile,
    profileLoading,
    userId,
    selectedProfileHandle,
    doFollow,
    doUnfollow,
    doBlock,
    setReportTarget,
    openDetail,
    runnerRaceName,
  } = ctx;
  const p = profile;
  return (
    <>
      <div className="mt-back-head">
        <button className="mt-back" onClick={() => setView("feed")}>
          ‹
        </button>
        <div className="mt-back-title">{t("profile.title")}</div>
      </div>
      <div className="mt-profile">
        {profileLoading && !p && <p className="empty">…</p>}
        {!profileLoading && !p && <p className="empty">404</p>}
        {p && (
          <>
            <div className="mt-profile-head">
              <div
                className="mt-profile-avatar"
                style={{ background: avatarColor(p.handle ?? p.display_name ?? "") }}
              >
                {(p.handle ?? p.display_name ?? "?").charAt(0).toUpperCase()}
              </div>
              <div className="mt-profile-meta">
                <div className="mt-profile-handle">@{p.handle}</div>
                <div className="mt-profile-counts">
                  <span>{tFmt("profile.followers", { n: p.follower_count })}</span>
                  <span>{tFmt("profile.following", { n: p.followee_count })}</span>
                </div>
              </div>
              {userId && selectedProfileHandle && p.id !== "__self__" && (
                <>
                  <button
                    className={`mt-follow-btn ${p.is_following ? "on" : ""}`}
                    onClick={() =>
                      p.is_following
                        ? doUnfollow(p.id, p.handle)
                        : doFollow(p.id, p.handle)
                    }
                  >
                    {p.is_following ? t("profile.unfollow") : t("profile.follow")}
                  </button>
                  <button
                    className="mt-block-btn"
                    onClick={() => doBlock(p.id)}
                  >
                    {t("profile.block")}
                  </button>
                  <button
                    className="mt-report-btn"
                    onClick={() =>
                      setReportTarget({ type: "user", id: p.id })
                    }
                  >
                    {t("profile.report")}
                  </button>
                </>
              )}
            </div>
            <div className="mt-profile-tickets">
              {(!p.tickets || p.tickets.length === 0) && (
                <p className="empty">{t("profile.noTickets")}</p>
              )}
              {(p.tickets ?? []).map((tk) => {
                const sep = mtSep(tk.ticket.type);
                const payLabel =
                  tk.state === "won" ? t("mine.returned") : t("mine.ifHits");
                const payValue =
                  tk.state === "won" ? tk.returned ?? 0 : tk.payoutBase;
                return (
                  <div
                    key={tk.id}
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
                        <div className="mt-badges">
                          <span
                            className="mt-state-badge"
                            style={{ background: mtStateColor(tk.state) }}
                          >
                            {tk.state === "open"
                              ? t("mine.live")
                              : t("mine.result")}
                          </span>
                          {tk.race.grade && (
                            <span className="mt-grade-badge">{tk.race.grade}</span>
                          )}
                        </div>
                        <div className="mt-card-race">{runnerRaceName(tk)}</div>
                      </div>
                      <div className="mt-chips">
                        {tk.ticket.lines.slice(0, 4).map((ln, j) => (
                          <span key={j} className="mt-chip">
                            {ln.combo.join(sep)}
                          </span>
                        ))}
                      </div>
                      <div className="mt-metrics">
                        <div>
                          <div className="mt-metric-label">{t("mine.cost")}</div>
                          <div className="mt-metric-cost">
                            {yen(tk.ticket.cost)}
                          </div>
                        </div>
                        <div>
                          <div className="mt-metric-label">{payLabel}</div>
                          <div className="mt-metric-pay">{yen(payValue)}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
