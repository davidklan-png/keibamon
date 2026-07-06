// ============================================================================
// RunnerMark — the inline per-runner mark control on the Race screen runner
// rows (ADR-0016).
//
// Adds the NetKeiba 予想印→投票シート muscle-memory path: set an impression
// mark in 2 taps directly from the runner list, without opening the full
// per-horse drill (FormPanel → HorseDrillView → IntuitionMarks). The drill
// stays; this is the faster inline path AND makes marks visible at list level.
//
// Same vocabulary + write path as IntuitionMarks (the chip strip inside the
// drill). Both surfaces write through `setImpression`, so a mark made on one
// is immediately visible on the other — single source of truth.
//
// HTML constraint: the parent runner row's tappable surface is a <button>,
// and the W3C spec forbids nested interactive elements. So RunnerMark is a
// SIBLING of the runner button inside the new `.runner-row` wrapper — never
// a child.
//
// Vocabulary order is identical to IntuitionMarks ( HorseDrillView ):
//   like, distrust, priceHorse, avoid, anchor
// so the two surfaces feel like the same control in two sizes.
//
// Recreational context, NOT an edge claim or betting advice. The marks shape
// the ticket; they don't predict outcomes (see form.intuitionHint copy).
// ============================================================================
import { useI18n } from "../i18n";
import type { IntuitionKind, IntuitionState } from "../lib/types";
import type { ImpressionMap } from "../lib/impressions";
import { getImpression, setImpression } from "../lib/impressions";

/**
 * JA newspaper prediction-mark convention (予想印). The glyphs are universal
 * racing print symbols — same across EN/JA contexts — so they don't carry
 * i18n strings; aria-labels do (form.intuition.<kind>).
 *
 * Order mirrors IntuitionMarks so the expanded chip strip reads identically
 * to the drill's IntuitionMarks strip.
 */
export const MARK_KINDS: IntuitionKind[] = [
  "like",
  "distrust",
  "priceHorse",
  "avoid",
  "anchor",
];

export const MARK_GLYPH: Record<IntuitionKind, string> = {
  anchor: "◎",
  like: "○",
  priceHorse: "▲",
  // ▽ (hollow inverted triangle) — NOT △. In JA 予想印 convention △ is the
  // 4th pick (mildly positive), so a JA reader saw the old △ distrust mark
  // as a recommendation. ▽ inverts that signal visually and is script-neutral.
  // Distinct from ▼ (filled) used by HorseDrillView drift arrows + MyTickets
  // history toggle — different fill + the badge container differ them further.
  distrust: "▽",
  avoid: "×",
};

/**
 * Stable CSS class suffix per mark kind. Used for both the chip strip and
 * the badge so a single .runner-mark-{kind} rule paints both surfaces.
 */
export function markClass(kind: IntuitionKind): string {
  return `runner-mark-${kind}`;
}

export interface RunnerMarkProps {
  /** Active race id — the store key prefix. */
  raceId: string;
  /** Horse name — normalized to the store key (same key FormPanel resolves). */
  horseName: string;
  /** Stable uma number — stamped into the impression at mark time. */
  umaban: number;
  /** Runner's current odds. null when odds==0 (no market yet). */
  odds: number | null;
  /** Snapshot heartbeat, stamped into the impression at mark time. */
  oddsSnapshotAt: string | null;
  /** Full impression store (App-level state). */
  impressions: ImpressionMap;
  /** App-level setter — writes through setImpression. */
  onSetImpressions: (next: ImpressionMap) => void;
  /** Is this row's chip strip currently expanded? (Parent owns single-open.) */
  isOpen: boolean;
  /** Lift open-state to the parent. Pass null to collapse, this uma to open. */
  onOpenChange: (uma: string | null) => void;
}

export function RunnerMark(props: RunnerMarkProps) {
  const { t } = useI18n();
  const {
    raceId,
    horseName,
    umaban,
    odds,
    oddsSnapshotAt,
    impressions,
    onSetImpressions,
    isOpen,
    onOpenChange,
  } = props;

  const impression = getImpression(impressions, raceId, horseName);
  const active: IntuitionState = impression?.mark ?? null;

  function write(next: IntuitionState) {
    onSetImpressions(
      setImpression(impressions, raceId, horseName, {
        mark: next,
        umaban,
        // Treat odds=0 as "no market yet" — matches RaceScreen's own
        // openRunner.odds > 0 ? odds : null conversion when it threads
        // currentOdds into HorseDrillView. Keeps the two surfaces honest.
        odds_when_marked: odds && odds > 0 ? odds : null,
        odds_snapshot_at: oddsSnapshotAt ?? null,
      }),
    );
    // Collapse after choose — single-tap-then-back-to-list rhythm, same as
    // IntuitionMarks' implicit "tap to set, tap again to clear" cadence but
    // with the strip closing so the user can see the new glyph land.
    onOpenChange(null);
  }

  // Collapsed badge: glyph when marked, subtle "—" placeholder when not.
  // Tapping expands the chip strip (or collapses if already open).
  const badgeAria = active
    ? t(`form.intuition.${active}`)
    : t("race.markAdd");

  return (
    <div className={`runner-mark ${isOpen ? "is-open" : ""}`}>
      <button
        type="button"
        className={`runner-mark-badge ${active ? `on ${markClass(active)}` : ""}`}
        aria-label={badgeAria}
        aria-expanded={isOpen}
        aria-haspopup="true"
        onClick={(e) => {
          // Stop the click from bubbling to any ancestor handler — the row
          // wrapper is a sibling, not a parent, but the click could still
          // propagate to a row-level listener if a future caller adds one.
          e.stopPropagation();
          onOpenChange(isOpen ? null : String(umaban));
        }}
      >
        <span aria-hidden="true">{active ? MARK_GLYPH[active] : "—"}</span>
      </button>
      {isOpen && (
        <div className="runner-mark-strip" role="group" aria-label={t("race.markAdd")}>
          {MARK_KINDS.map((k) => {
            const on = active === k;
            return (
              <button
                key={k}
                type="button"
                className={`runner-mark-chip ${on ? "on" : ""} ${markClass(k)}`}
                aria-pressed={on}
                aria-label={t(`form.intuition.${k}`)}
                onClick={(e) => {
                  e.stopPropagation();
                  write(on ? null : k);
                }}
              >
                <span aria-hidden="true" className="runner-mark-glyph">
                  {MARK_GLYPH[k]}
                </span>
                <span className="runner-mark-label">{t(`form.intuition.${k}`)}</span>
              </button>
            );
          })}
          {/* Clear affordance: only meaningful when something is set. Hidden
              when no active mark — tapping the active chip already clears. */}
          {active && (
            <button
              type="button"
              className="runner-mark-chip runner-mark-clear"
              aria-label={t("race.markClear")}
              onClick={(e) => {
                e.stopPropagation();
                write(null);
              }}
            >
              {t("race.markClear")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
