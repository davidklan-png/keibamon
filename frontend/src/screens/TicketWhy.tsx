// ============================================================================
// TicketWhy — the inline "why this ticket" reasoning, extracted from the old
// ExplainScreen (ADR-0007 Phase 5) for Session 3a.
//
// Session 3a collapsed the "Why" step: this renders ONLY the reasoning (lead
// sentence, the coverage/upside/fragility/cost <dl>, the combos, and the
// math/house-edge disclosure). It is rendered inline per ticket on the Tickets
// screen inside a "Why ▾" <details>. The per-horse form/context drill that the
// old ExplainScreen also carried is NOT here — that capability lives on the
// Race screen (tap a runner → FormPanel/HorseDrillView) and is not duplicated.
// ============================================================================
import { useI18n } from "../i18n";
import { RET, type BetType } from "../lib/fairvalue";
import type { Ticket, StyleState } from "../lib/types";
import { moodKey } from "../lib/types";
import { yen, fmt } from "../lib/format";

export interface TicketWhyProps {
  ticket: Ticket;
  style: StyleState;
}

export function TicketWhy({ ticket }: TicketWhyProps) {
  const { t, tFmt } = useI18n();
  const sep = ticket.type === "exacta" || ticket.type === "trifecta" ? " > " : " - ";
  const ev = ticket.expectedReturn;
  const edgePct = ((ev / Math.max(1, ticket.cost) - 1) * 100).toFixed(0);
  const fairForTicket = ticket.lines[0]?.fairOdds ?? Infinity;
  // Coverage: how many of the contender pool's top combos this ticket holds.
  const coveragePct = (ticket.hitProb * 100).toFixed(ticket.hitProb < 0.1 ? 1 : 0);

  return (
    <div className="ticket-why">
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
    </div>
  );
}
