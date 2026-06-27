// ============================================================================
// Explain Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Behavior-preserving move. The "why this ticket" view: lead sentence + a
// details dl + combos + an optional math disclosure with the house-edge line.
// ============================================================================
import { useState } from "react";
import { useI18n } from "../i18n";
import { RET, type BetType, type Runner } from "../lib/fairvalue";
import type { Ticket, StyleState, IntuitionState } from "../lib/types";
import { moodKey } from "../lib/types";
import { yen, fmt } from "../lib/format";
import type { ImpressionMap } from "../lib/impressions";
import { getImpression } from "../lib/impressions";
import { FormPanel } from "./FormPanel";
import type { MarkPayload } from "./RaceScreen";

export interface ExplainScreenProps {
  ticket: Ticket | null;
  style: StyleState;
  onBack: () => void;
  /** Milestone 4: runners for the current race, so the Explain screen can
   * surface a form/context panel for each horse on the ticket. */
  runners: Runner[];
  /**
   * ADR-0011 Phase 1: replaces the old uma-keyed intuition record. Same shape
   * as RaceScreen — parent owns the store; this screen reads via lookup +
   * writes through onMark with the full odds-context payload.
   */
  raceId: string;
  impressions: ImpressionMap;
  oddsSnapshotAt: string | null;
  onMark: (payload: MarkPayload) => void;
}

export function ExplainScreen(props: ExplainScreenProps) {
  const { t, tFmt } = useI18n();
  const { ticket, style, onBack, runners, raceId, impressions, oddsSnapshotAt, onMark } = props;
  const [openUma, setOpenUma] = useState<string | null>(null);
  if (!ticket) {
    return (
      <section className="section">
        <p className="empty">—</p>
        <button className="btn ghost" onClick={onBack}>
          ← {t("explain.back")}
        </button>
      </section>
    );
  }
  const sep = ticket.type === "exacta" || ticket.type === "trifecta" ? " > " : " - ";
  const ev = ticket.expectedReturn;
  const edgePct = ((ev / Math.max(1, ticket.cost) - 1) * 100).toFixed(0);
  const fairForTicket = ticket.lines[0]?.fairOdds ?? Infinity;
  // Coverage: how many of the contender pool's top combos this ticket holds.
  const coveragePct = (ticket.hitProb * 100).toFixed(ticket.hitProb < 0.1 ? 1 : 0);

  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("explain.title")}</h2>
          <small>
            {t(`betType.${ticket.type}`)} · {t(`valueTag.${ticket.tag}`)}
          </small>
        </div>
        {/* ADR-0005 Phase 3: plain sentence first, the math below it. */}
        <p className="explain-lead">
          {tFmt("explain.lead", {
            mood: t(`mood.${moodKey(ticket)}`),
            cost: yen(ticket.cost),
            hit: coveragePct,
          })}
        </p>
        <h3 className="details-heading">{t("explain.detailsHeading")}</h3>
        <dl className="explain">
          <dt>{t("explain.coverage")}</dt>
          <dd>
            {ticket.lines.length} {t("tickets.lines")} ·{" "}
            {t("tickets.hitEst")} {coveragePct}% ·{" "}
            {t("explain.fairValue")}: {fmt(fairForTicket, 1)}x
          </dd>
          <dt>{t("explain.upside")}</dt>
          <dd>
            {/* Wide can pay multiple lines in one race (up to C(3,2)=3 pairs).
             * Show the best-case multi-pay scenario so the displayed "if it
             * hits" return never looks like a net loss on a real win. */}
            {ticket.type === "wide" ? (
              <>
                {t("tickets.wideBestCase")}: {yen(ticket.bestCaseReturn)} ·{" "}
                {t("tickets.cost")}: {yen(ticket.cost)}
              </>
            ) : (
              <>
                {t("tickets.avgPayout")}: {yen(ticket.avgPayout)} ·{" "}
                {t("tickets.cost")}: {yen(ticket.cost)}
              </>
            )}
          </dd>
          <dt>{t("explain.fragility")}</dt>
          <dd>
            {ticket.variance === "high"
              ? t("tickets.variance")
              : t("tickets.lowVariance")}
            {ticket.tag === "chalk" && ` · ${t("valueTag.chalk")}`}
            {ticket.tag === "value" && ` · ${t("valueTag.value")}`}
          </dd>
          <dt>{t("explain.costLabel")}</dt>
          <dd>
            {yen(ticket.cost)} ({ticket.lines.length} × {yen(ticket.unit)})
          </dd>
        </dl>
        <div className="combos">
          {ticket.lines.slice(0, 12).map((ln, j) => (
            <span key={j} className="combo-chip">
              {ln.combo.join(sep)}
            </span>
          ))}
        </div>
        <details className="math-disclosure">
          <summary>{t("explain.mathSummary")}</summary>
          <div className="ev-line">
            {tFmt("tickets.estReturnLine", {
              ret: ev.toFixed(0),
              edge: `${edgePct}%`,
            })}
          </div>
          <p className="math">
            <strong>{t("explain.math")}:</strong>
            <br />
            {t("explain.mathBody")}
            <br />
            <span style={{ color: "var(--muted)" }}>
              RET[{ticket.type}] = {RET[ticket.type as BetType]} · γ = 0.856
            </span>
          </p>
        </details>

        {/* Milestone 4: form/context for the horses on this ticket. Recreational
         * context — NOT a tip or edge claim. The takeout reminder still applies. */}
        {ticket.core.length > 0 && runners.length > 0 && (
          <details className="form-disclosure">
            <summary>{t("form.title")} · {t("form.tapHint")}</summary>
            <div className="form-runner-list">
              {ticket.core
                .map((uma) => runners.find((r) => r.uma === uma))
                .filter((r): r is Runner => !!r)
                .map((r) => (
                  <button
                    key={r.uma}
                    type="button"
                    className={`runner runner-tappable ${openUma === r.uma ? "on" : ""}`}
                    onClick={() => setOpenUma(openUma === r.uma ? null : r.uma)}
                  >
                    <span className="uma">{r.uma}</span>
                    <span>
                      <span className="nm">{r.name || `#${r.uma}`}</span>
                      <span className="odds-line">
                        <span className="odds-value">{fmt(r.odds, 1)}</span>
                      </span>
                    </span>
                  </button>
                ))}
            </div>
            {openUma && (() => {
              const r = runners.find((x) => x.uma === openUma);
              if (!r) return null;
              return (
                <FormPanel
                  horseName={r.name || `#${r.uma}`}
                  jockeyId={r.jockey_id ?? null}
                  jockeyName={r.jockey_name ?? null}
                  impression={getImpression(impressions, raceId, r.name)}
                  onMark={(next) =>
                    onMark({
                      raceId,
                      horseName: r.name ?? "",
                      umaban: Number(r.uma),
                      oddsWhenMarked: r.odds > 0 ? r.odds : null,
                      oddsSnapshotAt,
                      mark: next,
                    })
                  }
                  onClose={() => setOpenUma(null)}
                />
              );
            })()}
          </details>
        )}
      </section>
      <button className="btn primary" style={{ width: "100%" }} onClick={onBack}>
        ← {t("explain.back")}
      </button>
    </>
  );
}
