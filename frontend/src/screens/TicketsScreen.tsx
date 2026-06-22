// ============================================================================
// Tickets Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Behavior-preserving move. Shows the recommended ticket set with mood badges,
// cost / if-hits metrics, and a remix + why button per ticket.
// ============================================================================
import { useI18n } from "../i18n";
import type { Ticket } from "../lib/types";
import { moodKey } from "../lib/types";
import { yen } from "../lib/format";

export interface TicketsScreenProps {
  tickets: Ticket[];
  onRemix: () => void;
  onReset: () => void;
  onBackStyle: () => void;
  onExplain: (id: string) => void;
}

export function TicketsScreen(props: TicketsScreenProps) {
  const { t } = useI18n();
  const { tickets, onRemix, onReset, onBackStyle, onExplain } = props;
  if (tickets.length === 0) {
    // Only reachable when a real regenerate() returned 0 tickets — i.e. the
    // current constraints (typically too many "avoid" tags) are unsolvable.
    // Pair the message with a one-tap reset instead of a dead end.
    return (
      <>
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
        <div className="btn-row">
          <button className="btn ghost" onClick={onBackStyle}>
            ← {t("tickets.backToStyle")}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
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
                  move to "Why" (one tap away). */}
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
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn gold"
                  onClick={() => onExplain(tk.id)}
                >
                  {t("tickets.whyTicket")}
                </button>
                <button className="btn ghost" onClick={onRemix}>
                  ⟳ {t("tickets.remix")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={onBackStyle}>
          ← {t("tickets.backToStyle")}
        </button>
      </div>
    </>
  );
}
