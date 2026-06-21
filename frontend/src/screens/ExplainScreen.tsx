// ============================================================================
// Explain Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Behavior-preserving move. The "why this ticket" view: lead sentence + a
// details dl + combos + an optional math disclosure with the house-edge line.
// ============================================================================
import { useI18n } from "../i18n";
import { RET, type BetType } from "../lib/fairvalue";
import type { Ticket, StyleState } from "../lib/types";
import { moodKey } from "../lib/types";
import { yen, fmt } from "../lib/format";

export interface ExplainScreenProps {
  ticket: Ticket | null;
  style: StyleState;
  onBack: () => void;
}

export function ExplainScreen(props: ExplainScreenProps) {
  const { t, tFmt } = useI18n();
  const { ticket, style, onBack } = props;
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
            {t("tickets.avgPayout")}: {yen(ticket.avgPayout)} ·{" "}
            {t("tickets.cost")}: {yen(ticket.cost)}
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
            })}{" "}
            {t("tickets.houseEdgeNote")}
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
          <p className="hint" style={{ marginTop: 12 }}>
            {t("explain.takeoutReminder")}
          </p>
        </details>
      </section>
      <button className="btn primary" style={{ width: "100%" }} onClick={onBack}>
        ← {t("explain.back")}
      </button>
    </>
  );
}
