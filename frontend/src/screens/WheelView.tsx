// ============================================================================
// WheelView — ADR-0011 Phase 3b, Option A (wheel family).
//
// Renders axis-anchored wheels: the user's ANCHOR horse pinned to 1着, the
// remaining marked horses (like / priceHorse) flowing across the other
// finishing positions. One consolidated row per ordered wheel bet type
// (exacta / trifecta). An exacta wheel of 1 anchor + 4 opponents renders as
// one row, not 4 flat lines.
//
// Guardrail (critical): the axis is the user's anchor mark ONLY — never an
// app-chosen horse. The caller (RaceScreen / Roundup bridge) is responsible
// for passing `axis` = the anchor uma and `opponents` = the remaining marks;
// if there is no anchor, the caller does not mount this view. The builder
// (buildWheelTicket) takes axis/opponents as parameters and makes no
// selection of its own.
//
// Both rows anchor the axis to 1着 (the JRA 軸1頭流し pattern — the most common
// recreational wheel). Position-2/3 anchoring is a 3c concern.
// ============================================================================
import { useI18n } from "../i18n";
import { fmt, yen } from "../lib/format";
import type { Runner, BetType } from "../lib/fairvalue";
import { buildWheelTicket } from "../lib/recommender";
import type { Ticket } from "../lib/types";

export interface WheelViewProps {
  /** The axis horse — the user's anchor mark (never app-chosen). */
  axis: string;
  /** Opponent horses — the remaining marked set (like / priceHorse). */
  opponents: string[];
  /** Full field — market context (unused by the builder, kept for parity). */
  runners: Runner[];
  /** De-vigged win probabilities keyed by uma. */
  p: Record<string, number>;
  /** Stable list of all umas in the race. */
  allUmas: string[];
  /** Per-point stake. */
  unitStake: number;
  /** Tap a row → caller opens FillGuide with the structured wheel ticket. */
  onSelectTicket?: (ticket: Ticket) => void;
}

/** Ordered bet types whose wheel (axis @ 1着) is offered. */
const WHEEL_TYPES: BetType[] = ["exacta", "trifecta"];

export function WheelView(props: WheelViewProps) {
  const { t } = useI18n();
  const { axis, opponents, p, allUmas, unitStake, onSelectTicket } = props;

  const wheels: Partial<Record<BetType, Ticket | null>> = {
    exacta: buildWheelTicket(
      "exacta",
      [axis],
      opponents,
      1,
      p,
      allUmas,
      unitStake,
      "wv",
    ),
    trifecta: buildWheelTicket(
      "trifecta",
      [axis],
      opponents,
      1,
      p,
      allUmas,
      unitStake,
      "wv",
    ),
  };

  return (
    <section className="wheel-view" aria-label={t("wheel.title")}>
      <header className="wheel-head">
        <h3>{t("wheel.title")}</h3>
      </header>

      <div className="wheel-rows">
        {WHEEL_TYPES.map((bt) => {
          const ticket = wheels[bt];
          if (!ticket) return null;
          const k = bt === "trifecta" ? 3 : 2;
          const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];
          return (
            <button
              key={bt}
              type="button"
              className="wheel-row"
              onClick={() => onSelectTicket?.(ticket)}
              disabled={!onSelectTicket}
            >
              <span className="wheel-label">{t(`betType.${bt}`)}</span>
              <span className="wheel-points">
                {ticket.lines.length}
                {t("setFamily.points")}
              </span>
              <div className="wheel-posline">
                <span className="wheel-pos wheel-pos-axis">
                  <span className="wheel-pos-label">
                    {posLabels[0]}
                    <span className="wheel-pos-tag">{t("fillGuide.axis")}</span>
                  </span>
                  <span className="wheel-pos-set">{axis}</span>
                </span>
                <span className="wheel-arrow" aria-hidden="true">→</span>
                {Array.from({ length: k - 1 }, (_, i) => (
                  <span key={i} className="wheel-pos">
                    <span className="wheel-pos-label">{posLabels[i + 1]}</span>
                    <span className="wheel-pos-set">{opponents.join(" ")}</span>
                  </span>
                ))}
              </div>
              <span className="wheel-cost">
                {t("setFamily.cost")}: {yen(ticket.cost)}
              </span>
              <span className="wheel-hit">
                {t("setFamily.hitProb")}: {fmt(ticket.hitProb * 100, 0)}%
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
