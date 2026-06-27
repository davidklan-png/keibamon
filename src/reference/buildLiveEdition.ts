// ============================================================================
// buildLiveEdition — pure builder for the rolling "live" Weekend Roundup edition.
//
// ADR-0010: every 5 minutes the racing Worker's `scheduled` handler reads the
// latest `live_snapshot` (key='current') and turns its graded races into a
// WeekendInput that joins the same edition_key as the manual ones. The result
// is UPSERTed into `weekly_report` at LIVE_VERSION (90) — a single rolling row,
// never a new version, so the audit trail stays clean and the read path's
// `ORDER BY version DESC` surfaces it as the latest.
//
// WHY PURE — no D1, no Date.now(), no network. The caller passes the snapshot
// payload (already fetched) and the current time. Same inputs → byte-identical
// output, so the builder is unit-testable offline (mirrors weeklyReport.ts's
// generator contract).
//
// HONESTY — the live edition is the SAME research framing the manual editions
// use; the generator + its banned-phrase scan (lib/guardrails) apply to it
// identically. This module just produces the input shape — it carries no copy
// of its own, so there is nothing for the guardrail scan to police here.
// ============================================================================
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- snapshot payload is untyped JSON from D1; we defend at the boundary.
type AnyJson = any;

/**
 * Reserved version number for the rolling live row. Picked ABOVE the manual
 * Friday/Saturday sequence (v1/v2/...) so `ORDER BY version DESC` always
 * surfaces the live edition as the latest when both exist for the same
 * edition_key. Documented in docs/adr/0010.
 */
export const LIVE_VERSION = 90;

/**
 * Maximum age (ms) of a live_snapshot before the rolling edition refuses to
 * republish. ~10× the JRA ~120s odds-refresh cadence — clearly stalled, not
 * just a missed tick. When the producer's heartbeat (`meta.published_at`) is
 * older than this, the edition label's "auto-refreshed HH:MM JST" would be
 * lying about freshness, so we freeze the existing v90 row in place rather
 * than stamp a stale payload with a fresh-looking label.
 */
export const MAX_SNAPSHOT_STALENESS_MS = 20 * 60 * 1000;

/**
 * Freshness classification of a snapshot payload. Shared by `buildLiveEdition`
 * (decides whether to build) and the scheduled handler (decides whether to
 * warn). `"unknown"` covers malformed/missing `meta.published_at`; `"stale"`
 * covers a parseable heartbeat older than the threshold; `"fresh"` = buildable.
 */
export type SnapshotFreshness = "fresh" | "stale" | "unknown";

/**
 * Pure freshness probe. `now` and `maxStalenessMs` are injected so the same
 * function serves tests and production. Never throws.
 */
export function snapshotFreshness(
  snapshotPayload: unknown,
  now: Date,
  maxStalenessMs: number = MAX_SNAPSHOT_STALENESS_MS,
): SnapshotFreshness {
  if (!snapshotPayload || typeof snapshotPayload !== "object") return "unknown";
  const meta = (snapshotPayload as AnyJson).meta;
  if (!meta || typeof meta !== "object") return "unknown";
  const publishedAt =
    typeof meta.published_at === "string" ? meta.published_at : "";
  if (!publishedAt) return "unknown";
  const ts = Date.parse(publishedAt);
  if (!Number.isFinite(ts)) return "unknown";
  return now.getTime() - ts > maxStalenessMs ? "stale" : "fresh";
}

/**
 * Output shape — a structural subset of `WeekendInput`
 * (frontend/src/lib/weeklyReport.ts). The shape is what matters: when this is
 * JSON-serialized into `weekly_report.payload`, the frontend's report generator
 * reads it back as a `WeekendInput`. No type shared across the worker/frontend
 * boundary — the wire contract is documented in weeklyReport.ts and asserted
 * by `frontend/src/lib/weeklyReport.test.ts`.
 */
export interface LiveEdition {
  edition_key: string;
  edition_label: string;
  weekend_label: string;
  version: number;
  published_at: string;
  odds_snapshot_at: string | null;
  gate_snapshot_at: string | null;
  card_snapshot_at: string | null;
  condition_snapshot_at: string | null;
  races: LiveEditionRace[];
}

export interface LiveEditionRace {
  race_id: string;
  name: string;
  name_ja?: string;
  grade: "G1" | "G2" | "G3";
  venue: string;
  venue_ja?: string;
  surface: "turf" | "dirt";
  distance_m: number;
  post_time: string;
  date: string;
  field_size: number;
  going: null;
  weather: null;
  runners: {
    horse_number: number;
    horse_name: string;
    gate: null;
    win_odds: number | null;
  }[];
}

// ---------------------------------------------------------------------------
// Optional editorial polish — race_id → bilingual names for this weekend's
// graded stakes. When the snapshot carries a JRA race_id that matches, the
// polished name wins (so the roundup reads "宝塚記念" / "Takarazuka Kinen"
// rather than the feed's bare "Takarazuka Kinen (G1)" or worse, a code).
// Feed values are always the fallback. Add entries here as the weekend's
// graded stakes become known; unmapped races render with the feed name.
// ---------------------------------------------------------------------------
const NAME_POLISH: Record<string, { name?: string; name_ja?: string; venue_ja?: string }> = {
  // 2026-06-28 Takarazuka Kinen (Hanshin, G1, 2200m turf) — Hanshin's Sunday feature.
  "202606050911": { name: "Takarazuka Kinen", name_ja: "宝塚記念", venue_ja: "阪神" },
};

// ---------------------------------------------------------------------------
// Grade ladder — mirror of `gradeClass` in frontend/src/screens/RaceScreen.tsx.
// NFKC fold (full-width → half-width), uppercase, trim, then accept G1/GI and
// the JRA roman Ⅰ/Ⅱ/Ⅲ (which NFKC folds to I/II/III). Rejects "OP", "Listed",
// JpnI/II/III, and empty strings. Canonicalized to "G1"/"G2"/"G3" so the
// shared `.grade-chip grade-G1/G2/G3` CSS slots straight in.
// ---------------------------------------------------------------------------
function canonicalGrade(gradeLabel: string | null | undefined): "G1" | "G2" | "G3" | null {
  if (!gradeLabel) return null;
  const g = String(gradeLabel).normalize("NFKC").toUpperCase().trim();
  if (g === "G1" || g === "GI") return "G1";
  if (g === "G2" || g === "GII") return "G2";
  if (g === "G3" || g === "GIII") return "G3";
  return null;
}

/**
 * ISO-8601 week (e.g. "2026-W26") of a UTC calendar date. Used as the
 * edition_key so the live row joins the same weekend as the manual ones.
 * Pure + host-tz-independent (operates in UTC). Algorithm: ISO week is the
 * week containing the year's Thursdays; the Thursday-of-this-week carries the
 * ISO year + week number.
 */
function isoWeekOfUTC(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Shift to the Thursday of this ISO week (Mon=1..Sun=7; Thu=4).
  const dayOfWeek = d.getUTCDay(); // 0=Sun..6=Sat in JS
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  d.setUTCDate(d.getUTCDate() - (isoDay - 4));
  const isoYear = d.getUTCFullYear();
  // ISO week number: week containing this Thursday.
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekIndex = Math.floor((d.getTime() - yearStart) / (7 * 24 * 60 * 60 * 1000));
  // The Thursday of week 1 is the first Thursday of the ISO year. The calendar
  // days before that Thursday belong to the prior ISO year's last week; the
  // arithmetic above lands us on a Thursday, and its weekIndex is 0-based from
  // Jan 1, so add 1 to make it 1-based.
  const week = weekIndex + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** "HH:MM" in JST (UTC+9) for the edition_label. Pure + host-tz-independent. */
function jstHHMM(utc: Date): string {
  const jstMs = utc.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** "YYYY-MM-DDTHH:MM:SSZ" — UTC ISO instant. */
function isoUTCNow(utc: Date): string {
  return utc.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function safeStr(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return fallback;
}

function safeNum(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Build a rolling "live" WeekendInput from a live_snapshot payload. Returns
 * null when:
 *   - the payload is malformed (missing meta/races, non-array races)
 *   - `meta.published_at` is missing/unparseable OR older than `maxStalenessMs`
 *     (stalled producer — freezes the prior v90 row rather than lying about
 *     freshness)
 *   - there are zero graded (G1/G2/G3) races in the snapshot
 *
 * Null = caller no-op (the scheduled handler just returns; existing editions
 * are never deleted or blanked). Throws NEVER — every defensive gate returns
 * null instead.
 *
 * @param snapshotPayload The parsed JSON from `live_snapshot.payload` (key='current')
 * @param now             The current UTC instant, injected for testability
 * @param maxStalenessMs  Optional override for the snapshot-age threshold (test-only knob)
 */
export function buildLiveEdition(
  snapshotPayload: unknown,
  now: Date,
  maxStalenessMs: number = MAX_SNAPSHOT_STALENESS_MS,
): LiveEdition | null {
  if (!snapshotPayload || typeof snapshotPayload !== "object") return null;
  // Freshness gate — refuse to build if the producer's heartbeat is stale or
  // missing. Freezes the existing v90 row in place (the caller no-ops) rather
  // than stamping a stale payload with a fresh-looking "auto-refreshed" label.
  if (snapshotFreshness(snapshotPayload, now, maxStalenessMs) !== "fresh") {
    return null;
  }
  const snap = snapshotPayload as AnyJson;
  const races = Array.isArray(snap.races) ? snap.races : null;
  if (!races) return null;

  // Filter to graded races; collect into the output race shape as we go.
  const graded: LiveEditionRace[] = [];
  for (const raceRaw of races) {
    if (!raceRaw || typeof raceRaw !== "object") continue;
    const r = raceRaw as AnyJson;
    const grade = canonicalGrade(r.grade_label);
    if (!grade) continue;

    const runnersRaw = Array.isArray(r.runners) ? r.runners : [];
    const runners = runnersRaw
      .filter((rn: AnyJson) => rn && typeof rn === "object")
      .map((rn: AnyJson) => {
        const uma = safeNum(rn.umaban ?? rn.horse_number, 0);
        return {
          horse_number: uma,
          horse_name: safeStr(rn.name ?? rn.horse_name, `No.${uma}`),
          gate: null,
          win_odds:
            typeof rn.win_odds === "number" && rn.win_odds > 0
              ? rn.win_odds
              : null,
        };
      });

    const rawRaceId = safeStr(r.race_id);
    const raceId = rawRaceId || `jra-${safeStr(r.date)}-${safeNum(r.race_no)}`;
    const polished = rawRaceId ? NAME_POLISH[rawRaceId] : undefined;
    const venue = safeStr(r.venue);
    const rawSurface = safeStr(r.surface).toLowerCase();
    const surface: "turf" | "dirt" = rawSurface === "dirt" ? "dirt" : "turf";
    const distance_m = safeNum(r.distance_m, 0);

    graded.push({
      race_id: raceId,
      name: polished?.name ?? safeStr(r.name, `R${safeNum(r.race_no)}`),
      ...(polished?.name_ja ? { name_ja: polished.name_ja } : {}),
      grade,
      venue,
      ...(polished?.venue_ja ? { venue_ja: polished.venue_ja } : {}),
      surface,
      distance_m,
      post_time: safeStr(r.post_time),
      date: safeStr(r.date),
      field_size: runners.length,
      going: null,
      weather: null,
      runners,
    });
  }

  if (graded.length === 0) return null;

  // edition_key = ISO-week of the earliest graded race date. JRA dates are
  // already calendar JST; parse as UTC midnight (date-only) so the ISO week
  // computation is host-tz-independent. All graded races on a given snapshot
  // share the same ISO week in practice; use the min as the canonical anchor.
  const sortedDates = graded
    .map((g) => g.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const anchorDateStr = sortedDates[0];
  const anchorDate = anchorDateStr
    ? new Date(`${anchorDateStr}T00:00:00Z`)
    : now;
  const editionKey = isoWeekOfUTC(anchorDate);

  // published_at = now (UTC ISO). odds/card snapshot stamps = the snapshot's
  // own published_at (when the producer wrote it). gate/condition stay null
  // until the entries/condition scrapes populate them — the producer chains
  // those into the same payload, so a richer snapshot upgrades the live row
  // on the next tick without a code change. The freshness gate above
  // guarantees meta.published_at is a parseable string, so no fallback needed.
  const meta: AnyJson =
    snap.meta && typeof snap.meta === "object" ? (snap.meta as AnyJson) : {};
  const snapshotPublishedAt = safeStr(meta.published_at);

  return {
    edition_key: editionKey,
    edition_label: `Live — auto-refreshed ${jstHHMM(now)} JST`,
    weekend_label: `Live weekend · ${editionKey}`,
    version: LIVE_VERSION,
    published_at: isoUTCNow(now),
    odds_snapshot_at: snapshotPublishedAt,
    gate_snapshot_at: null,
    card_snapshot_at: snapshotPublishedAt,
    condition_snapshot_at: null,
    races: graded,
  };
}
