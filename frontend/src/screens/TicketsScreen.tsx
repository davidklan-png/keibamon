// ============================================================================
// Tickets Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Session 3a: the 4-step builder collapsed to race → tickets. The old Style
// step is now the inline "Refine ▾" panel at the top; the old Why step is now
// an inline "Why ▾" <details> per ticket (TicketWhy). Shows the recommended
// ticket set with mood badges, cost / if-hits metrics, refine + why + place
// per ticket.
// ============================================================================
import { useI18n } from "../i18n";
import type { Ticket, StyleState, IntuitionKind } from "../lib/types";
import { moodKey } from "../lib/types";
import { yen } from "../lib/format";
import { normalizeName } from "../lib/normalizeName";
import { impressionsByRace, type ImpressionMap } from "../lib/impressions";
import type { Runner } from "../lib/fairvalue";
import { MARK_GLYPH, markClass } from "./RunnerMark";
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
  /**
   * Friend Interactions Phase 2 — Share a ticket. Opens the FriendPicker (the
   * confirmation step); a single tap never publishes. Absent on the test render.
   */
  onShare?: (ticket: Ticket) => void;
  /** Label for the Share button (resolved by the caller). */
  shareLabel?: string;
  /** Transient status line (e.g. "Updated with your marks", offline-queued). */
  toast?: string;
  /**
   * ADR-0016: read-only "your marks" echo. When the race has ≥1 mark, the
   * strip renders above the ticket list (glyph + horse chip per mark). Absent
   * on the empty state and when no marks exist. Editing stays on Race /
   * inside the drill — this surface is display-only.
   */
  runners?: Runner[];
  raceId?: string;
  impressions?: ImpressionMap;
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
    onShare,
    shareLabel,
    toast,
    runners,
    raceId,
    impressions,
  } = props;

  // ADR-0016: build the per-runner mark list for the read-only echo. Same
  // join path RaceScreen uses (normalizeName → horse_key → impression). Only
  // rendered when ≥1 mark exists; otherwise the strip is absent.
  const markedRunners: { runner: Runner; mark: IntuitionKind }[] = (() => {
    if (!runners || !raceId || !impressions) return [];
    const byHorseKey = impressionsByRace(impressions, raceId);
    const out: { runner: Runner; mark: IntuitionKind }[] = [];
    for (const r of runners) {
      const hk = normalizeName(r.name);
      if (!hk) continue;
      const m = byHorseKey[hk]?.mark;
      if (m) out.push({ runner: r, mark: m });
    }
    return out;
  })();

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
      {/* ADR-0016: read-only echo of the marks set on Race. Renders only when
          the race has ≥1 mark. Editing stays on Race / in the drill — this
          surface is display-only. */}
      {markedRunners.length > 0 && (
        <section className="section tickets-marks" aria-label={t("tickets.yourMarks")}>
          <div className="section-title">
            <h3>{t("tickets.yourMarks")}</h3>
          </div>
          <ul className="tickets-marks-list">
            {markedRunners.map(({ runner, mark }) => (
              <li
                key={runner.uma}
                className={`tickets-mark-chip ${markClass(mark)}`}
              >
                <span aria-hidden="true" className="tickets-mark-glyph">
                  {MARK_GLYPH[mark]}
                </span>
                <span className="tickets-mark-uma">{runner.uma}</span>
                <span className="tickets-mark-name">
                  {runner.name || `#${runner.uma}`}
                </span>
                <span className="sr-only">
                  {" "}
                  — {t(`form.intuition.${mark}`)}
                </span>
              </li>
            ))}
          </ul>
        </section>
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
                {onShare && (
                  <button className="btn ghost" onClick={() => onShare(tk)}>
                    {shareLabel ?? t("share.share")}
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
