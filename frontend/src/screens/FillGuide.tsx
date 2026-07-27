// ============================================================================
// FillGuide — ADR-0011 Phase 3a/3b, Option B.
//
// A JRA-style "fill card" rendering of a structured ticket. 3a covered the box
// family (quinella/wide/trio via buildBoxTicket): a number grid 1..N with the
// selected set highlighted. 3b extends to the ordered family (exacta/trifecta
// via buildFormationTicket / buildWheelTicket). Since ticket-structure-unify
// Phase 2 the ordered BODY is rendered by the shared <TicketLines> (one
// interpreter, one body renderer); FillGuide keeps only what is genuinely its
// own — the field grid (box mode), the summary <dl>, the [data-not-advice]
// micro-line, and the Save/Share action row.
//
// The card is SHARE-EXPORTABLE (3b Part 4): a [data-not-advice] micro-line
// (the app-wide auth.disclaimer) satisfies the hard gate in lib/share.ts's
// exportTicketCard, and the share button rasterizes the card via html-to-image.
// No parallel export path — reuses the existing gate.
//
// Pure presentational — "not an OMR replica" per task, just a legible mobile
// card. Structural interpretation is shared via lib/ticketStructure.ts
// (`interpretTicket`); this file renders that view as a fill card:
//   - box (horse)  → number grid 1..N (highlight the interpreted set)
//   - box (枠連)    → 1-8 waku grid, cells colored by bracket
//   - formation    → <TicketLines> position columns
//   - wheel        → <TicketLines> columns (axis tagged on its anchored slot)
// ============================================================================
import { useRef } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import { exportTicketCard } from "../lib/share";
import { interpretTicket } from "../lib/ticketStructure";
import { TicketLines } from "../components/TicketLines";
import type { Runner } from "../lib/fairvalue";
import type { Ticket } from "../lib/types";

export interface FillGuideProps {
  /** A structured ticket from buildBoxTicket / buildFormationTicket / buildWheelTicket. */
  ticket: Ticket;
  /** Full field — grid size (max umaban) for the box path. */
  runners: Runner[];
  /** Per-point stake (display only). */
  unitStake: number;
  /**
   * Friend Interactions Phase 3 rewire: Save (persist privately) + Share
   * (FriendPicker → publish). When BOTH are provided (the live-card mount),
   * FillGuide shows the real Save/Share pair (identical semantics to the
   * TicketsScreen split); when absent (e.g. the roundup mount, which lacks a
   * CommittedTicket race context), it falls back to the image-export Share.
   */
  onSave?: (ticket: Ticket) => void;
  onShare?: (ticket: Ticket) => void;
}

export function FillGuide(props: FillGuideProps) {
  const { t } = useI18n();
  const { ticket, runners, unitStake, onSave, onShare } = props;
  const rootRef = useRef<HTMLElement | null>(null);

  const view = interpretTicket(ticket);
  const isBox = view.mode === "box";
  const isFormation = view.mode === "formation";
  const isWheel = view.mode === "wheel";
  const isOrdered = isFormation || isWheel;
  // 枠連 box: the grid is the fixed 1-8 WAKU grid (brackets, not umabans), cells
  // colored by bracket via the .fillguide-cell.bracket-N rules. Every other box
  // is the 1..maxUmaban HORSE grid with the set highlighted "on".
  const isBracketBox = isBox && view.isBracket;

  // NOTE: the grid highlight set is now DERIVATION-driven (view.mode === "box",
  // which can be a derived legacy box) rather than the old declarative
  // `ticket.structure === "box"`. So a structure-less ticket whose lines happen
  // to be a full box expansion now highlights cells where before none were.
  // Unreachable in practice — FillGuide is only mounted from TicketStudio with
  // explicitly-structured tickets — but flagged so the next person doesn't
  // rediscover it.
  const boxSet = isBox ? new Set(view.set) : new Set<string>();
  const maxUmaban = runners.reduce((m, r) => {
    const n = Number(r.uma);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const gridSize = isBracketBox ? 8 : Math.max(maxUmaban, ticket.core.length, 1);
  const cells = Array.from({ length: gridSize }, (_, i) => String(i + 1));
  // A non-bracket box grids against the FIELD, so it needs `runners` to size/
  // label cells. FillGuide is always mounted with runners (TicketStudio); if a
  // future mount omits them, fall back to TicketLines tiles (below) so the set
  // still reads instead of an unhighlightable 1..core grid.
  const boxGridOk = isBracketBox || runners.length > 0;

  async function doShare() {
    if (!rootRef.current) return;
    try {
      await exportTicketCard(rootRef.current);
      // shared / downloaded are silent successes — the OS already showed
      // the share sheet or saved the file. 'none' is a silent fail too:
      // the card still renders; flashing a toast here would be noise.
    } catch {
      // MissingNotAdvice (guard) or toPng failure — the card still renders.
    }
  }

  return (
    <section className="fillguide" ref={rootRef} aria-label={t("fillGuide.title")}>
      <header className="fillguide-head">
        <h3>{t("fillGuide.title")}</h3>
        <div className="fillguide-shibetsu">
          <span className="fillguide-type">{t(`betType.${ticket.type}`)}</span>
          {isBox && <span className="fillguide-box-badge">{t("fillGuide.box")}</span>}
          {isFormation && (
            <span className="fillguide-formation-badge">{t("fillGuide.formation")}</span>
          )}
          {isWheel && <span className="fillguide-wheel-badge">{t("fillGuide.wheel")}</span>}
        </div>
      </header>

      {isOrdered ? (
        // Ordered structure body — shared with every other ticket-body surface:
        // TicketLines renders the formation/wheel columns. badge={false}: this
        // card's header already carries the structure label (no duplicate pill).
        // points="none": the summary <dl> below carries per-point/count/total.
        <TicketLines ticket={ticket} unitStake={unitStake} points="none" badge={false} />
      ) : isBox && boxGridOk ? (
        <div className="fillguide-grid" role="list">
          {cells.map((num) => {
            const on = boxSet.has(num);
            const cls = isBracketBox
              ? `fillguide-cell${on ? ` bracket-${num}` : ""}`
              : `fillguide-cell${on ? " on" : ""}`;
            return (
              <span
                key={num}
                role="listitem"
                className={cls}
                aria-label={num + (on ? " (selected)" : "")}
              >
                {num}
              </span>
            );
          })}
        </div>
      ) : (
        // Box without a field to grid against (defensive), or a chips/legacy
        // ticket (defensive — FillGuide only sees explicit structured tickets):
        // TicketLines renders the set as tiles/chips so the body still reads.
        <TicketLines ticket={ticket} unitStake={unitStake} points="none" badge={false} />
      )}

      <dl className="fillguide-summary">
        <div>
          <dt>{t("fillGuide.perPoint")}</dt>
          <dd>{yen(unitStake)}</dd>
        </div>
        <div>
          <dt>{t("fillGuide.unit")}</dt>
          <dd>{ticket.lines.length}</dd>
        </div>
        <div>
          <dt>{t("fillGuide.total")}</dt>
          <dd>{yen(ticket.cost)}</dd>
        </div>
      </dl>

      <div className="fillguide-foot">
        <span className="fillguide-micro" data-not-advice="">
          {t("auth.disclaimer")}
        </span>
        {onSave && onShare ? (
          <div className="fillguide-actions">
            <button type="button" className="btn" onClick={() => onSave(ticket)}>
              {t("share.save")}
            </button>
            <button type="button" className="btn primary" onClick={() => onShare(ticket)}>
              {t("share.share")}
            </button>
          </div>
        ) : (
          <button type="button" className="fillguide-share" onClick={doShare}>
            {t("fillGuide.share")}
          </button>
        )}
      </div>
    </section>
  );
}
