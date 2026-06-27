// ============================================================================
// SetFamilyView — ADR-0011 Phase 3a, Option A.
//
// Renders the user's OWN selected horse set (the marked horses: anchor / like /
// priceHorse) as ONE consolidated box per set-family bet type, instead of the
// C(n,k) flat combo rows the recommender's Ticket card shows. A box of 5
// renders as one row, not 10.
//
// Source of truth: the `set` prop (umas derived from the impression store).
// The combo math (`comboProb`, `kCombos`, `wideTicketStats`) stays in the
// engine — this is a presentation/aggregation layer that calls `buildBoxTicket`
// + `bracketQuinellaAgg` and renders the results.
//
// 枠連 (bracket quinella) is aggregation-only over the quinella kernel (no new
// BetType). Its row is DISPLAY-ONLY — it has no Ticket representation, so it
// can't drive a FillGuide. Omitted entirely when any selected runner lacks a
// numeric gate (the live path doesn't carry gate yet).
//
// Guardrail-clean: descriptive copy only, never betting advice.
// ============================================================================
import { useI18n } from "../i18n";
import { fmt, yen } from "../lib/format";
import type { Runner } from "../lib/fairvalue";
import {
  buildBoxTicket,
  bracketQuinellaAgg,
} from "../lib/recommender";
import type { BetType } from "../lib/fairvalue";
import type { Ticket } from "../lib/types";

export interface SetFamilyViewProps {
  /** Selected umas (from the user's anchor/like/priceHorse marks). */
  set: string[];
  /** Full field — market + optional gate (for 枠連). */
  runners: Runner[];
  /** De-vigged win probabilities keyed by uma. */
  p: Record<string, number>;
  /** Stable list of all umas in the race. */
  allUmas: string[];
  /** Per-point stake (defaults to 100 by the caller). */
  unitStake: number;
  /** Tap a box row → caller opens FillGuide with the structured ticket. */
  onSelectTicket?: (ticket: Ticket) => void;
}

const BOX_TYPES: BetType[] = ["quinella", "wide", "trio"];

export function SetFamilyView(props: SetFamilyViewProps) {
  const { t } = useI18n();
  const { set, runners, p, allUmas, unitStake, onSelectTicket } = props;

  // Build each box ticket once. Null when the set is too small for that type
  // (e.g. trio needs ≥3) or a selected horse is scratched.
  const boxes: Partial<Record<BetType, Ticket | null>> = {
    quinella: buildBoxTicket("quinella", set, p, allUmas, unitStake, "sf"),
    wide: buildBoxTicket("wide", set, p, allUmas, unitStake, "sf"),
    trio: buildBoxTicket("trio", set, p, allUmas, unitStake, "sf"),
  };

  // 枠連 aggregation — null when any selected runner lacks a numeric gate.
  const selectedRunners = set
    .map((u) => runners.find((r) => r.uma === u))
    .filter((r): r is Runner => !!r);
  const bracket = bracketQuinellaAgg(selectedRunners, p, allUmas, unitStake);

  return (
    <section className="setfamily-view" aria-label={t("setFamily.title")}>
      <header className="setfamily-head">
        <h3>{t("setFamily.title")}</h3>
      </header>

      <div className="setfamily-rows">
        {BOX_TYPES.map((bt) => {
          const ticket = boxes[bt];
          if (!ticket) return null;
          return (
            <button
              key={bt}
              type="button"
              className="setfamily-row"
              onClick={() => onSelectTicket?.(ticket)}
              disabled={!onSelectTicket}
            >
              <span className="setfamily-label">{t(`betType.${bt}`)}</span>
              <span className="setfamily-points">
                {ticket.lines.length}
                {t("setFamily.points")}
              </span>
              <span className="setfamily-cost">
                <span className="setfamily-cost-label">{t("setFamily.cost")}</span>{" "}
                {yen(ticket.cost)}
              </span>
              <span className="setfamily-hit">
                {t("setFamily.hitProb")}: {fmt(ticket.hitProb * 100, 0)}%
              </span>
              <span className="setfamily-best">
                {t("setFamily.bestCase")}: {yen(ticket.bestCaseReturn)}
              </span>
            </button>
          );
        })}

        {bracket && (
          // 枠連 is display-only: aggregation has no Ticket representation
          // (no new BetType), so it can't drive a FillGuide.
          <div className="setfamily-row setfamily-row-bracket" aria-label={t("setFamily.bracketQuinella")}>
            <span className="setfamily-label">{t("setFamily.bracketQuinella")}</span>
            <span className="setfamily-points">
              {bracket.points}
              {t("setFamily.points")}
            </span>
            <span className="setfamily-cost">
              <span className="setfamily-cost-label">{t("setFamily.cost")}</span>{" "}
              {yen(bracket.cost)}
            </span>
            <span className="setfamily-hit">
              {t("setFamily.hitProb")}: {fmt(bracket.hitProb * 100, 0)}%
            </span>
            <span className="setfamily-best">
              {t("setFamily.bestCase")}: {yen(bracket.bestCaseReturn)}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
