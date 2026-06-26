// ============================================================================
// upcoming — pick the real upcoming graded stakes out of a /api/live snapshot.
//
// Used by the Weekend Roundup empty state (ReferenceScreen): when no edition is
// published yet, the tab shows what's actually on the card instead of fabricated
// sample data. This helper filters the live snapshot to the graded (G1/G2/G3)
// races whose date is today or later, and sorts them in a stable, readable order.
//
// Pure + deterministic — takes `now` as a parameter so tests don't depend on
// wall-clock time. The grade ladder mirrors popularScore in RaceScreen.tsx
// (case-folded G1/G2/G3); the date filter prevents a stale /api/live (last
// weekend's results) from being shown as "upcoming".
// ============================================================================
import type { LiveRace } from "../api";

const GRADE_RANK: Record<string, number> = { G1: 0, G2: 1, G3: 2 };

/** Case-folded grade ladder: returns "G1" | "G2" | "G3" or null if not graded. */
export function gradeOf(race: LiveRace): string | null {
  const g = (race.grade_label || "").toUpperCase();
  return g === "G1" || g === "G2" || g === "G3" ? g : null;
}

/** Normalize YYYYMMDD → YYYY-MM-DD; leave YYYY-MM-DD (and anything else) as-is. */
function normalizeDate(date: string): string {
  return /^\d{8}$/.test(date)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date;
}

/** YYYY-MM-DD calendar date in JST (Asia/Tokyo), where JRA race dates live.
 *  This is a soft display filter (not a PIT gate), but pinning the boundary to
 *  JST stops a borderline race flipping in/out of "upcoming" by a day for
 *  viewers outside Japan. Pure — `now` is injected, and Intl.DateTimeFormat
 *  with a fixed timeZone is host-tz-independent. */
function todayStr(now: Date): string {
  // en-CA yields ISO-style YYYY-MM-DD; timeZone fixes the calendar to Tokyo.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Filter `races` to graded (G1/G2/G3) upcoming (JST date >= today), sorted by
 * grade rank (G1→G2→G3), then date, then race_no. Stable on ties. Returns a new
 * array; never mutates input. Empty/undefined input → [].
 */
export function pickGradedUpcoming(
  races: LiveRace[] | undefined,
  now: Date,
): LiveRace[] {
  if (!races || races.length === 0) return [];
  const today = todayStr(now);
  const graded = races.filter((r) => {
    if (gradeOf(r) === null) return false;
    if (!r.date) return false;
    return normalizeDate(r.date) >= today;
  });
  return [...graded].sort((a, b) => {
    const ga = GRADE_RANK[gradeOf(a) as string];
    const gb = GRADE_RANK[gradeOf(b) as string];
    if (ga !== gb) return ga - gb;
    const da = normalizeDate(a.date as string);
    const db = normalizeDate(b.date as string);
    if (da !== db) return da < db ? -1 : 1;
    return a.race_no - b.race_no;
  });
}
