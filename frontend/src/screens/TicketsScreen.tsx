// ============================================================================
// Tickets Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Session 3a: the 4-step builder collapsed to race → tickets. The old Style
// step is now the inline "Refine ▾" panel at the top; the old Why step is now
// an inline "Why ▾" <details> per ticket (TicketWhy). Shows the recommended
// ticket set with mood badges, cost / if-hits metrics, refine + why + place
// per ticket.
// ============================================================================
import { useI18n } from "../i18n";
import type { Ticket, StyleState } from "../lib/types";
import { moodKey } from "../lib/types";
import { yen } from "../lib/format";
import { RefinePanel } from "./RefinePanel";
import { TicketWhy } from "./TicketWhy";

export interface TicketsScreenProps {
  tickets: Ticket[];
  onRemix: () => void;
  onReset: () => void;
  /**
   * Current play style + setter. The inline Refine panel edits this; App still
   * owns the state and its auto-regenerate effect reshapes `tickets` in place
   * on every change.
   */
  style: StyleState;
  onStyleChange: (s: StyleState) => void;
  /**
   * Place (commit) a single ticket. Mirrors MyTickets.commit() — the label is
   * chosen by the caller (App) based on auth state so this component stays
   * free of the auth context. Absent on the test render.
   */
  onPlace?: (ticket: Ticket) => void;
  /** Label for the Place button (auth-aware, resolved by the caller). */
  placeLabel?: string;
  /** Transient status line (e.g. "Updated with your marks", offline-queued). */
  toast?: string;
}

export function TicketsScreen(props: TicketsScreenProps) {
  const { t } = useI18n();
  const {
    tickets,
    onRemix,
    onReset,
    style,
    onStyleChange,
    onPlace,
    placeLabel,
    toast,
  } = props;
  if (tickets.length === 0) {
    // Only reachable when a real regenerate() returned 0 tickets — i.e. the
    // current constraints (typically too many "avoid" tags) are unsolvable.
    // Pair the message with a one-tap reset instead of a dead end. The Refine
    // panel stays available so the user can loosen the style that wedged it.
    return (
      <>
        <RefinePanel style={style} onChange={onStyleChange} />
        <section className="section">
          <p className="empty">{t("tickets.noCandidates")}</p>
          <button
            className="btn primary"
            style={{ width: "100%", marginTop: 12 }}
            onClick={onReset}
          >
            {t("tickets.resetStandard")}
          </button>
        </section>
      </>
    );
  }
  return (
    <>
      {/* Session 3a: the old standalone Style step is now an inline collapsible
          panel at the top of Tickets. Editing it auto-regenerates the set. */}
      <RefinePanel style={style} onChange={onStyleChange} />
      {toast && (
        <p className="hint marks-toast" role="status">
          {toast}
        </p>
      )}
      <div className="tickets">
        {tickets.map((tk, i) => {
          const sep = tk.type === "exacta" || tk.type === "trifecta" ? " > " : " - ";
          const shownLines = tk.lines.slice(0, 9);
          const mood = moodKey(tk);
          return (
            <article
              key={tk.id}
              className={`ticket ${i === 0 ? "top-pick" : ""}`}
            >
              {/* ADR-0005 Phase 3: default card carries two numbers + one mood
                  label. Hit %, variance, value tag and the house-edge line all
                  move to the inline "Why" (one tap away). */}
              <div className="ticket-head">
                <div>
                  <h3>{t(`betType.${tk.type}`)}</h3>
                </div>
                <span className={`badge mood-${mood}`}>{t(`mood.${mood}`)}</span>
              </div>
              <div className="metrics">
                <div className="metric cost-metric">
                  <span>{t("tickets.cost")}</span>
                  <b>{yen(tk.cost)}</b>
                </div>
                <div className="metric">
                  <span>{t("tickets.ifHits")}</span>
                  <b>{yen(tk.avgPayout)}</b>
                </div>
              </div>
              <div className="combos">
                {shownLines.map((ln, j) => (
                  <span key={j} className="combo-chip">
                    {ln.combo.join(sep)}
                  </span>
                ))}
                {tk.lines.length > shownLines.length && (
                  <span className="combo-chip">
                    +{tk.lines.length - shownLines.length}
                  </span>
                )}
              </div>
              {/* Session 3a: per-ticket reasoning, inline. Replaces the old
                  onExplain(id) navigation to a separate Why step. */}
              <details className="ticket-why-disclosure">
                <summary>{t("tickets.whyTicket")}</summary>
                <TicketWhy ticket={tk} style={style} />
              </details>
              <div className="btn-row" style={{ marginTop: 12 }}>
                {onPlace && (
                  <button
                    className="btn primary"
                    onClick={() => onPlace(tk)}
                  >
                    {placeLabel ?? t("tickets.placeCta")}
                  </button>
                )}
                <button className="btn ghost" onClick={onRemix}>
                  ⟳ {t("tickets.remix")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
