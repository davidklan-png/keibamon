// ====================== NEW BET ======================
// Extracted from MyTickets' inner renderNew (2026-07-08 split — behavior
// preserving; all state/actions come through MtCtx).
import React from "react";
import { MT_MOOD_COLOR, mtFmtDate, mtSep } from "../../lib/mytickets-view";
import { yen } from "../../lib/format";
import type { MtCtx } from "./ctx";

export function NewView({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    lang,
    setView,
    feature,
    fallbackDate,
    options,
    selIdx,
    setSelIdx,
    unit,
    setUnit,
    setManualEditId,
    commit,
  } = ctx;
  const selCost = options[selIdx]?.ticket.cost ?? 0;
  return (
    <>
      <div className="mt-back-head">
        <button className="mt-back" onClick={() => setView("feed")}>
          ‹
        </button>
        <div className="mt-back-title">{t("mine.newTitle")}</div>
      </div>

      <div className="mt-new">
        {feature ? (
          <>
            <div className="mt-race-card">
              <div className="mt-race-card-eyebrow">
                {feature.grade_label || "—"} · {t("mine.raceDay")}
              </div>
              <div className="mt-race-card-name">{feature.name}</div>
              <div className="mt-race-card-meta">
                {feature.venue} · R{feature.race_no} ·{" "}
                {mtFmtDate(feature.date ?? fallbackDate ?? "", lang)}
                {feature.post_time ? ` · ${t("mine.post")} ${feature.post_time}` : ""}
              </div>
            </div>

            <div className="mt-vibe-label">{t("mine.pickVibe")}</div>
            {options.map((o, i) => {
              const sel = selIdx === i;
              const sep = mtSep(o.ticket.type);
              const descKey =
                o.mood === "safer"
                  ? "mine.saferDesc"
                  : o.mood === "spicier"
                    ? "mine.spicierDesc"
                    : "mine.balancedDesc";
              return (
                <div
                  key={o.mood}
                  className="mt-option"
                  style={{ borderColor: sel ? MT_MOOD_COLOR[o.mood] : "var(--line)" }}
                  onClick={() => setSelIdx(i)}
                >
                  <div className="mt-option-head">
                    <span
                      className="mt-option-mooddot"
                      style={{ background: MT_MOOD_COLOR[o.mood] }}
                    />
                    <span className="mt-option-mood">{t(`mine.${o.mood}`)}</span>
                    <span className="mt-option-bet">
                      {t(`betType.${o.ticket.type}`)}
                    </span>
                    {sel && (
                      <span
                        className="mt-check"
                        style={{ background: MT_MOOD_COLOR[o.mood] }}
                      >
                        ✓
                      </span>
                    )}
                  </div>
                  <div className="mt-option-desc">{t(descKey)}</div>
                  <div className="mt-chips">
                    {o.ticket.lines.slice(0, 4).map((ln, j) => (
                      <span key={j} className="mt-chip">
                        {ln.combo.join(sep)}
                      </span>
                    ))}
                  </div>
                  <div className="mt-option-figures">
                    <div>
                      <span>{t("mine.cost")} </span>
                      <b>{yen(o.ticket.cost)}</b>
                    </div>
                    <div>
                      <span>{t("mine.ifHits")} </span>
                      <b className="pay">{yen(o.ticket.avgPayout)}</b>
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="mt-unit-label">{t("mine.unit")}</div>
            <div className="mt-units">
              {[100, 200, 300].map((v) => (
                <button
                  key={v}
                  className={`mt-unit ${unit === v ? "on" : ""}`}
                  onClick={() => setUnit(v)}
                >
                  ¥{v}
                </button>
              ))}
            </div>

            {/* 4th "Build manually" option — sibling to the 3 vibe picks.
                Routes to the manual builder (create-from-scratch path)
                without disturbing the 3 personality moods above. */}
            <button
              type="button"
              className="mt-manual-entry"
              onClick={() => {
                setManualEditId(null);
                setView("manual");
              }}
            >
              <span className="mt-manual-entry-head">
                <span className="mt-manual-entry-title">{t("manual.entryTitle")}</span>
                <span className="mt-manual-entry-arrow">›</span>
              </span>
              <span className="mt-manual-entry-desc">{t("manual.entryDesc")}</span>
            </button>
          </>
        ) : (
          <p className="empty">{t("race.noLive")}</p>
        )}
      </div>

      {feature && options.length > 0 && (
        <div className="mt-cta-wrap">
          <button className="mt-cta" onClick={commit}>
            {t("mine.confirm")} · {yen(selCost)}
          </button>
        </div>
      )}
    </>
  );
}
