// ============================================================================
// FormationView — ADR-0011 Phase 3b, Option A (ordered family).
//
// The ordered counterpart of SetFamilyView. Renders the user's OWN marked set
// as ONE consolidated ordered-box row per formation bet type (exacta / trifecta),
// instead of the P(n,k) flat ordered-combo rows. An exacta-box of 4 renders as
// one row, not 12.
//
// Source of truth: the `set` prop (umas derived from the impression store —
// anchor / like / priceHorse marks). Each row builds a formation with
// positions = [set, set] (exacta) or [set, set, set] (trifecta) via
// buildFormationTicket, which expands via the cartesian product + no-repeat
// filter and prices each line through the SAME orderProb + RET path as
// evaluateCombos.
//
// Guardrail: the builder seeds ONLY from the user's marks — no app-chosen
// axis. A wheel (axis-anchored) is a separate WheelView. Descriptive copy
// only; never betting advice.
// ============================================================================
import { Fragment } from "react";
import { useI18n } from "../i18n";
import { fmt, yen } from "../lib/format";
import type { Runner, BetType } from "../lib/fairvalue";
import { buildFormationTicket } from "../lib/recommender";
import type { Ticket } from "../lib/types";

export interface FormationViewProps {
  /** Selected umas (from the user's anchor/like/priceHorse marks). */
  set: string[];
  /** Full field — market context (unused by the builder, kept for parity). */
  runners: Runner[];
  /** De-vigged win probabilities keyed by uma. */
  p: Record<string, number>;
  /** Stable list of all umas in the race. */
  allUmas: string[];
  /** Per-point stake. */
  unitStake: number;
  /** Tap a row → caller opens FillGuide with the structured formation ticket. */
  onSelectTicket?: (ticket: Ticket) => void;
}

/** Ordered bet types whose formation (ordered box) is offered. */
const FORMATION_TYPES: BetType[] = ["exacta", "trifecta"];

export function FormationView(props: FormationViewProps) {
  const { t } = useI18n();
  const { set, p, allUmas, unitStake, onSelectTicket } = props;

  const formations: Partial<Record<BetType, Ticket | null>> = {
    exacta: buildFormationTicket(
      "exacta",
      [set, set],
      p,
      allUmas,
      unitStake,
      "fv",
    ),
    trifecta: buildFormationTicket(
      "trifecta",
      [set, set, set],
      p,
      allUmas,
      unitStake,
      "fv",
    ),
  };

  return (
    <section className="formation-view" aria-label={t("formation.title")}>
      <header className="formation-head">
        <h3>{t("formation.title")}</h3>
      </header>

      <div className="formation-rows">
        {FORMATION_TYPES.map((bt) => {
          const ticket = formations[bt];
          if (!ticket) return null;
          const k = bt === "trifecta" ? 3 : 2;
          const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];
          return (
            <button
              key={bt}
              type="button"
              className="formation-row"
              onClick={() => onSelectTicket?.(ticket)}
              disabled={!onSelectTicket}
            >
              <span className="formation-label">{t(`betType.${bt}`)}</span>
              <span className="formation-points">
                {ticket.lines.length}
                {t("setFamily.points")}
              </span>
              <div className="formation-posline">
                {Array.from({ length: k }, (_, i) => (
                  <Fragment key={i}>
                    <span className="formation-pos">
                      <span className="formation-pos-label">{posLabels[i]}</span>
                      <span className="formation-pos-set">{set.join(" ")}</span>
                    </span>
                    {i < k - 1 && <span className="formation-arrow" aria-hidden="true">→</span>}
                  </Fragment>
                ))}
              </div>
              <span className="formation-cost">
                {t("setFamily.cost")}: {yen(ticket.cost)}
              </span>
              <span className="formation-hit">
                {t("setFamily.hitProb")}: {fmt(ticket.hitProb * 100, 0)}%
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
