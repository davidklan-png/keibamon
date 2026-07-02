// ============================================================================
// RaceContextBar — persistent "what race am I on?" strip (Session 5a / ADR-0017).
//
// Answers the audit's hierarchy-A question: every builder screen surfaces a
// slim line that says which race the user is on, so the answer is one glance
// away on both the Race step and the Tickets step. Renders ABOVE the stepper,
// directly under the App header, whenever:
//   - the user is on the Races destination (view === "browse"), AND
//   - the funnel is NOT research (the roundup path has its own context), AND
//   - a race is applied (selectedRace non-null, or the manual sample card).
//
// Data source: `selectedRace` + `raceStatus` ONLY. The 45s `snap` rotation
// (refreshSnap replaces the snapshot — race may rotate off, name may drift,
// meta.date may roll) is a known trap documented in App.tsx; re-looking-up the
// race inside snap would silently miss on rotation and blank the bar. App
// freezes selectedRace at selection time precisely so this strip is stable.
//
// Props only — no fetching, no store reads. Each field omits cleanly when null
// (surface/distance_m are both optional on LiveRace; going is a future
// publisher-side prop, wired as optional here).
// ============================================================================
import type { LiveRace } from "../api";
import { useI18n } from "../i18n";

export interface RaceContextBarProps {
  /** Frozen at selection time. Null on the manual sample card. */
  race: LiveRace | null;
  /** App's raceLabel — the race name, or "(sample race)" on the manual path. */
  raceLabel: string;
  /** App's raceStatus: "registered" | "open" | "result" | "manual". */
  raceStatus: string;
  /** Optional going (e.g. "good"). Omitted from the strip when null/empty. */
  going?: string | null;
}

/** Maps a surface string to the localized label. Unknown → pass through. */
function surfaceLabel(
  raw: string | null | undefined,
  t: (k: string) => string,
): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === "turf" || lower === "芝") return t("race.surfaceTurf");
  if (lower === "dirt" || lower === "ダート") return t("race.surfaceDirt");
  return raw;
}

/** CJK / kana widths abut the distance with no space (芝2000m / ダート1800m);
 *  latin labels use a space (turf 2000m). Detect via codepoint range. */
function hasWideChar(s: string): boolean {
  return /[\u3000-\u9fff\uff66-\uff9f]/.test(s);
}

function statusChipLabel(
  raceStatus: string,
  t: (k: string) => string,
): string {
  if (raceStatus === "open") return t("race.statusOpen");
  if (raceStatus === "registered") return t("race.statusRegistered");
  if (raceStatus === "result") return t("race.statusResult");
  // "manual" (App-level sample-race status) and any unknown value both fall
  // back to the sample-card label.
  return t("race.manual");
}

function chipClass(raceStatus: string): string {
  // Reuses the canonical status vocabulary so a single CSS rule per variant
  // styles both the race-card chip and the context-bar chip.
  if (
    raceStatus === "open" ||
    raceStatus === "registered" ||
    raceStatus === "result"
  ) {
    return `status-${raceStatus}`;
  }
  return "status-manual";
}

export function RaceContextBar({
  race,
  raceLabel,
  raceStatus,
  going,
}: RaceContextBarProps) {
  const { t } = useI18n();

  // Nothing to show: no applied race AND no manual label. App guards this too,
  // but the component stays null-safe so it can be mounted eagerly.
  if (!race && !raceLabel) return null;

  const venue = race?.venue || null;
  const raceNo = race?.race_no ?? null;
  const surface = surfaceLabel(race?.surface ?? null, t);
  const distance = race?.distance_m ?? null;

  // Build the surface/distance segment. Both parts are optional; we don't
  // want "turf · · 2000m" with stray bullets when one is missing.
  //   turf + 2000   → "turf 2000m"   (latin: space)
  //   芝 + 2000     → "芝2000m"      (CJK: no space — JA newspaper convention)
  //   turf only     → "turf"
  //   2000m only    → "2000m"
  //   neither       → segment omitted entirely
  let surfDist: string | null = null;
  if (surface && distance != null) {
    surfDist = hasWideChar(surface)
      ? `${surface}${distance}m`
      : `${surface} ${distance}m`;
  } else if (surface) {
    surfDist = surface;
  } else if (distance != null) {
    surfDist = `${distance}m`;
  }

  const goingLabel =
    going && going.trim().length > 0 ? going.trim() : null;

  return (
    <div
      className={`race-context-bar ${chipClass(raceStatus)}`}
      role="status"
      aria-label={t("race.contextBar")}
    >
      <span className="rcb-id">
        {venue ? <span className="rcb-venue">{venue}</span> : null}
        {raceNo != null ? (
          <span className="rcb-raceno">R{raceNo}</span>
        ) : null}
        {surfDist ? (
          <span className="rcb-surf-dist">{surfDist}</span>
        ) : null}
        <span className={`rcb-chip ${chipClass(raceStatus)}`}>
          {statusChipLabel(raceStatus, t)}
        </span>
        {goingLabel ? (
          <span className="rcb-going">{goingLabel}</span>
        ) : null}
      </span>
      {raceLabel ? (
        <span className="rcb-name" title={raceLabel}>
          {raceLabel}
        </span>
      ) : null}
    </div>
  );
}
