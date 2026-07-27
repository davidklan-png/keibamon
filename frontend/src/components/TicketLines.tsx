// ============================================================================
// TicketLines — structure-aware ticket-body renderer (ticket-detail UX,
// 2026-07-12). ONE shared component used everywhere a ticket body renders:
// the My-Tickets detail card, the viewer share-detail pane, and the feed
// ShareCard. The structural interpretation lives in lib/ticketStructure.ts
// (one interpreter, two presentations — TicketLines + FillGuide); this file
// is presentation only.
//
// Visual identity: echoes a real ticket's ORGANIZATION (columns, points) but
// uses Keibamon's own palette/typography — no JRA marks, mark-card look, or
// official colors. Old share snapshots without `structure` take the single/
// legacy path untouched (render-side only — no migration, no snapshot rewrite).
// ============================================================================
import { Fragment, useState } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import type { Ticket } from "../lib/types";
import { interpretTicket, isOrderedType } from "../lib/ticketStructure";

export interface TicketLinesProps {
  ticket: Ticket;
  /** Per-combo stake (CommittedTicket.unit / Ticket.unit). */
  unitStake: number;
  /** Dense tiles for compact feed/share cards. Default false (detail size). */
  compact?: boolean;
  /**
   * Which points line to render under the body (box/formation/wheel AND chips):
   *
   *   "full"  — "N combos × unit = cost" (default). DetailView/FriendsScreen/
   *             ShareCard behaviour.
   *   "count" — count only ("N combos" / "N点"), no unit, no cost. For hosts
   *             that already show cost but NOT the combo count (the four list/
   *             preview surfaces). Cost without count is a worse pair than the
   *             chip wall it replaced, so restore the count — without
   *             duplicating the cost the host already prints.
   *   "none"  — no line. For hosts that already show BOTH cost and count
   *             (DetailView's pay panel, TicketWhy's <dl>, the manual builder's
   *             preview head).
   *
   * The count renders on the chips (legacy) path too — the count line is the
   * one way the combo total is expressed, replacing the old compact "+N" chip.
   */
  points?: "full" | "count" | "none";
  /**
   * Suppress the `.tl-head` structure-badge row. For hosts that already label
   * the structure themselves — FillGuide's header carries the bet type + a
   * structure badge, so mounting TicketLines for the body must not duplicate
   * the badge. Default false: every existing mount (detail / share / feed)
   * shows the badge.
   */
  badge?: boolean;
}

export function TicketLines({
  ticket,
  unitStake,
  compact = false,
  points = "full",
  badge = true,
}: TicketLinesProps) {
  const { t, tFmt } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const view = interpretTicket(ticket);

  const nCombos = ticket.lines.length;
  const sep = isOrderedType(ticket.type) ? " › " : " – ";
  const tileCls = compact ? "tl-tile tl-tile-sm" : "tl-tile";
  const rootCls = compact ? "tl tl-compact" : "tl";

  function PointsLine() {
    if (points === "none") return null;
    if (points === "count") {
      // Count only — no unit, no cost (the host already shows cost). This is
      // the one place the combo total is expressed on the dense list/preview
      // cards; it also renders on the chips path so a legacy ticket states its
      // total the same way a box/formation/wheel does.
      return <div className="tl-points">{tFmt("ticketLines.count", { n: nCombos })}</div>;
    }
    return (
      <div className="tl-points">
        {tFmt("ticketLines.points", {
          n: nCombos,
          unit: yen(unitStake),
          cost: yen(ticket.cost),
        })}
      </div>
    );
  }

  // ---- Box ----------------------------------------------------------------
  if (view.mode === "box") {
    const bracketTileCls = view.isBracket ? `${tileCls} tl-tile-bracket` : tileCls;
    return (
      <div className={rootCls}>
        {badge && (
          <div className="tl-head">
            <span className="tl-badge tl-badge-box">{t("fillGuide.box")}</span>
            {view.isBracket && (
              <span className="tl-bracket-tag">{t("ticketLines.brackets")}</span>
            )}
          </div>
        )}
        <div className="tl-tiles" role="list">
          {view.set.map((u) => (
            <span key={u} className={bracketTileCls} role="listitem">
              {u}
            </span>
          ))}
        </div>
        <PointsLine />
      </div>
    );
  }

  // ---- Formation ----------------------------------------------------------
  if (view.mode === "formation") {
    const positions = view.positions;
    const k = positions.length;
    const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];
    return (
      <div className={rootCls}>
        {badge && (
          <div className="tl-head">
            <span className="tl-badge tl-badge-form">{t("fillGuide.formation")}</span>
          </div>
        )}
        <div className="tl-cols">
          {positions.map((posSet, i) => (
            <Fragment key={i}>
              <div className="tl-col">
                <div className="tl-col-label">{posLabels[i] ?? `${i + 1}`}</div>
                <div className="tl-col-tiles">
                  {posSet.map((u) => (
                    <span key={u} className={tileCls}>
                      {u}
                    </span>
                  ))}
                </div>
              </div>
              {i < k - 1 && (
                <span className="tl-arrow" aria-hidden="true">
                  →
                </span>
              )}
            </Fragment>
          ))}
        </div>
        <PointsLine />
      </div>
    );
  }

  // ---- Wheel --------------------------------------------------------------
  if (view.mode === "wheel") {
    const { axis, opponents, axisPosition } = view;
    const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];
    const axisLabel = posLabels[axisPosition - 1] ?? `#${axisPosition}`;
    return (
      <div className={rootCls}>
        {badge && (
          <div className="tl-head">
            <span className="tl-badge tl-badge-wheel">{t("fillGuide.wheel")}</span>
            {axis.length > 1 && <span className="tl-multi">{t("ticketLines.multi")}</span>}
          </div>
        )}
        <div className="tl-cols">
          <div className="tl-col">
            <div className="tl-col-label">
              {axisLabel} <span className="tl-axis-tag">{t("fillGuide.axis")}</span>
            </div>
            <div className="tl-col-tiles">
              {axis.map((u) => (
                <span key={u} className={`${tileCls} tl-tile-axis`}>
                  {u}
                </span>
              ))}
            </div>
          </div>
          <span className="tl-arrow" aria-hidden="true">
            →
          </span>
          <div className="tl-col">
            <div className="tl-col-label">{t("ticketLines.partners")}</div>
            <div className="tl-col-tiles">
              {opponents.map((u) => (
                <span key={u} className={tileCls}>
                  {u}
                </span>
              ))}
            </div>
          </div>
        </div>
        <PointsLine />
      </div>
    );
  }

  // ---- Single / legacy (chips) -------------------------------------------
  const CAP = compact ? 6 : 8; // ~2 rows of chips
  const shown = expanded ? ticket.lines : ticket.lines.slice(0, CAP);
  const hidden = nCombos - shown.length;
  return (
    <div className={rootCls}>
      <div className="tl-chips">
        {shown.map((ln, i) => (
          <span key={i} className="tl-chip">
            {ln.combo.join(sep)}
          </span>
        ))}
        {/* Non-compact offers an expander to reveal every chip. Compact no
            longer carries a "+N" truncation chip: the count line below states
            the combo total (the one way the count is expressed), so a dense
            card reads "6 chips · 18 combos" instead of "+12". */}
        {!expanded && hidden > 0 && !compact && (
          <button type="button" className="tl-more" onClick={() => setExpanded(true)}>
            {tFmt("ticketLines.allCombos", { n: nCombos })}
          </button>
        )}
      </div>
      <PointsLine />
    </div>
  );
}
