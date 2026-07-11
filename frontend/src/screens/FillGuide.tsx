// ============================================================================
// FillGuide — ADR-0011 Phase 3a/3b, Option B.
//
// A JRA-style "fill card" rendering of a structured ticket. 3a covered the box
// family (quinella/wide/trio via buildBoxTicket): a number grid 1..N with the
// selected set highlighted. 3b extends to the ordered family (exacta/trifecta
// via buildFormationTicket / buildWheelTicket): position columns 1着→2着→3着
// with directional arrows + (for wheels) an axis tag on the anchored position.
//
// The card is SHARE-EXPORTABLE (3b Part 4): a [data-not-advice] micro-line
// (the app-wide auth.disclaimer) satisfies the hard gate in lib/share.ts's
// exportTicketCard, and the share button rasterizes the card via html-to-image.
// No parallel export path — reuses the existing gate.
//
// Pure presentational — "not an OMR replica" per task, just a legible mobile
// card. Driven by a Ticket's `structure` + `structurePayload`:
//   - box       → number grid (highlight structurePayload.set)
//   - formation → position columns (structurePayload.positions)
//   - wheel     → position columns reconstructed from axis/opponents/position
// ============================================================================
import { Fragment, useRef } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import { exportTicketCard } from "../lib/share";
import type { Runner } from "../lib/fairvalue";
import type { Ticket, FormationPayload, WheelPayload } from "../lib/types";

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

  const isBox = ticket.structure === "box";
  const isFormation = ticket.structure === "formation";
  const isWheel = ticket.structure === "wheel";
  const isOrdered = isFormation || isWheel;

  // ---- Ordered path: resolve the position columns. -------------------------
  // Formation reads positions directly; wheel reconstructs them from
  // axis@position + opponents (axis pinned to `position`, opponents elsewhere).
  const k = ticket.type === "trifecta" ? 3 : 2;
  let positions: string[][] | null = null;
  let axisPosition = 0; // 0 = none (formation/box); 1..k = wheel anchor slot
  if (isFormation && ticket.structurePayload) {
    positions = (ticket.structurePayload as FormationPayload).positions;
  } else if (isWheel && ticket.structurePayload) {
    const wp = ticket.structurePayload as WheelPayload;
    positions = Array.from({ length: k }, (_, i) =>
      i + 1 === wp.position ? wp.axis : wp.opponents,
    );
    axisPosition = wp.position;
  }

  // ---- Box path: number grid setup (unchanged from 3a). -------------------
  const set = new Set(
    isBox && ticket.structurePayload
      ? (ticket.structurePayload as { set: string[] }).set
      : [],
  );
  const maxUmaban = runners.reduce((m, r) => {
    const n = Number(r.uma);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  const gridSize = Math.max(maxUmaban, ticket.core.length, 1);
  const cells = Array.from({ length: gridSize }, (_, i) => String(i + 1));

  const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];

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

      {isOrdered && positions ? (
        <div className="fillguide-ordered" aria-label={t("fillGuide.ordered")}>
          {positions.map((posSet, i) => (
            <Fragment key={i}>
              <div className="fillguide-pos-col">
                <div className="fillguide-pos-label">
                  {posLabels[i] ?? `${i + 1}`}
                  {axisPosition === i + 1 && (
                    <span className="fillguide-pos-tag">{t("fillGuide.axis")}</span>
                  )}
                </div>
                <div className="fillguide-pos-chips">
                  {posSet.map((u) => (
                    <span key={u} className="fillguide-pos-chip">{u}</span>
                  ))}
                </div>
              </div>
              {i < positions.length - 1 && (
                <span className="fillguide-arrow" aria-hidden="true">→</span>
              )}
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="fillguide-grid" role="list">
          {cells.map((num) => {
            const on = set.has(num);
            return (
              <span
                key={num}
                role="listitem"
                className={`fillguide-cell${on ? " on" : ""}`}
                aria-label={num + (on ? " (selected)" : "")}
              >
                {num}
              </span>
            );
          })}
        </div>
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
