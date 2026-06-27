/** Tiny fetcher for the existing /api/live snapshot. No external deps. */

import type { RaceResult } from "./lib/settle";

export interface LiveRunner {
  umaban: number;
  name?: string | null;
  /** Live pari-mutuel win odds; null/absent until the pool opens. */
  win_odds?: number | null;
  /** Estimated odds shown while there is no live price (ADR-0006). */
  win_odds_est?: number | null;
  /** True iff win_odds is a real live price (not an estimate). */
  odds_is_live?: boolean;
  /**
   * Milestone 4 form panel (jockey-gap option a): passthrough fields for the
   * form panel. Absent on legacy/manual runners and on live races produced
   * before the entries scrape wired them in. Never written to silver.
   */
  jockey_id?: string | null;
  jockey_name?: string | null;
}

/** Race lifecycle the app renders against (ADR-0006). */
export type RaceStatus = "registered" | "open" | "result";

export interface LiveRace {
  date?: string;
  race_no: number;
  race_id?: string | null;
  name?: string | null;
  grade_label?: string | null;
  post_time?: string | null;
  venue?: string | null;
  /** "turf" (芝) or "dirt" (ダート). null when the day-index page omitted the
   *  RaceList_ItemLong cell. Parsed off the same field discover_card already
   *  scrapes — no extra fetch. */
  surface?: string | null;
  /** Race distance in meters (e.g. 1800). null when unparsable / absent. */
  distance_m?: number | null;
  status?: RaceStatus;
  /**
   * Phase 2 (ADR-0007): result block when status==='result'. Today's
   * /api/live producer passes `raw.get('result')` through unchanged and no
   * upstream currently emits it, so this is usually null/empty. The settle
   * resolver degrades to {state:'open'} when empty — see lib/settle.ts.
   */
  result?: RaceResult | null;
  runners?: LiveRunner[];
}

export interface LiveSnapshot {
  meta?: {
    status?: string;
    message?: string;
    updated_at?: string;
    /** Producer's heartbeat (src/keibamon_core/live/snapshot.py:171). The
     *  freshness anchor used by ADR-0010 buildLiveEdition AND by the Phase 1
     *  impression store's odds_snapshot_at stamp (ADR-0011 D3). */
    published_at?: string;
    date?: string;
  };
  races?: LiveRace[];
}

export async function fetchLiveSnapshot(): Promise<LiveSnapshot> {
  const res = await fetch("/api/live", { cache: "no-store" });
  if (!res.ok) throw new Error(`live snapshot HTTP ${res.status}`);
  return (await res.json()) as LiveSnapshot;
}

const SEED_NAMES = [
  "Market Star",
  "Rail Runner",
  "Late Kick",
  "Turf Logic",
  "Deep Closer",
  "Gold Tempo",
  "Quiet Form",
  "Wide Draw",
  "Storm Line",
  "Pocket Trip",
  "Green Signal",
  "Long Fuse",
  "Fast Return",
  "Night Odds",
  "Sharp Bend",
  "Final Call",
  "Lucky Gate",
  "Blue Turn",
];

/** Manual-entry seed matching helper.html's pattern. */
export function seedManualRunners(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uma: String(i + 1),
    name: SEED_NAMES[i] ?? null,
    odds: Number((2.1 + i * 1.35 + (i % 3) * 0.7).toFixed(1)),
  }));
}

// ---------------------------------------------------------------------------
// Milestone 4 — form/context panel (horse + jockey). Recreational CONTEXT to
// shape intuition; not an edge claim, tip, or advice. The backend reads
// pre-built PIT-correct marts; the read path filters `available_at < as_of` so
// the target race and anything after it are excluded. Missing entity ->
// { status: "no_history" } — never a 500.
//
// PRODUCTION: the racing Worker (src/worker.js) serves these three routes
// (GET /api/horses/:name/form, /api/jockeys/:id/form, /api/races/:race_id/form)
// from the keibamon_form D1. FormPanel treats {status:"no_history"} as the
// "genuinely empty" branch (→ "Coming this weekend" only when BOTH horse AND
// jockey come back no_history); a 404 or 5xx is a real load error (→ Retry).
// ---------------------------------------------------------------------------

/**
 * Error thrown by the form fetchers on non-2xx. Carries the HTTP status so the
 * caller can distinguish "endpoint not deployed" (404) from a real failure
 * (network / 5xx) and degrade gracefully.
 */
export class FormFetchError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "FormFetchError";
  }
}

export interface FormSplit {
  starts: number;
  wins: number;
  top3: number;
  win_pct: number | null;
  top3_pct: number | null;
}

export interface FormRecentFinish {
  available_at: string | null;
  race_date: string | null;
  racecourse: string | null;
  surface: string | null;
  distance_m: number | null;
  going: string | null;
  grade_label: string | null;
  field_size: number | null;
  finish_position: number | null;
  margin: string | null;
  last_3f_seconds: number | null;
  win_odds: number | null;
  popularity: number | null;
  style_signal: string | null;
}

export interface HorseFormCard {
  status: "ok" | "no_history";
  horse_name?: string | null;
  as_of?: string | null;
  context_note?: string;
  career?: FormSplit;
  recent_finishes?: FormRecentFinish[];
  by_surface?: Record<string, FormSplit>;
  by_distance_band?: Record<string, FormSplit>;
  by_wet?: { wet: FormSplit; dry: FormSplit };
  style_profile?: Record<string, number>;
  style_note?: string;
  market_vs_result?: { avg_beat_market: number | null; note: string | null };
}

export interface JockeyRecentFinish {
  available_at: string | null;
  race_date: string | null;
  racecourse: string | null;
  horse_name: string | null;
  finish_position: number | null;
  win_odds: number | null;
  popularity: number | null;
  grade_label: string | null;
}

export interface JockeyCombo {
  horse_name_key?: string;
  horse_name?: string;
  trainer_id?: string;
  starts: number;
  wins: number;
}

export interface JockeyFormCard {
  status: "ok" | "no_history";
  jockey_id?: string | null;
  as_of?: string | null;
  context_note?: string;
  career?: FormSplit;
  by_course?: Record<string, FormSplit>;
  recent?: JockeyRecentFinish[];
  combos?: { by_horse: JockeyCombo[]; by_trainer: JockeyCombo[] };
}

/**
 * Fetch a horse's form/context card. `asOf` is optional — when absent the
 * backend anchors on now-UTC (form-to-date, correct for upcoming races whose
 * results don't exist yet). Throws on non-2xx; the caller renders no_history.
 */
export async function fetchHorseForm(
  horseName: string,
  asOf?: string,
): Promise<HorseFormCard> {
  const q = asOf ? `?as_of=${encodeURIComponent(asOf)}` : "";
  const res = await fetch(
    `/api/horses/${encodeURIComponent(horseName)}/form${q}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new FormFetchError(res.status, `horse form HTTP ${res.status}`);
  return (await res.json()) as HorseFormCard;
}

/** Same as above but for a jockey_id (silver entries key). */
export async function fetchJockeyForm(
  jockeyId: string,
  asOf?: string,
): Promise<JockeyFormCard> {
  const q = asOf ? `?as_of=${encodeURIComponent(asOf)}` : "";
  const res = await fetch(
    `/api/jockeys/${encodeURIComponent(jockeyId)}/form${q}`,
    { cache: "no-store" },
  );
  if (!res.ok) throw new FormFetchError(res.status, `jockey form HTTP ${res.status}`);
  return (await res.json()) as JockeyFormCard;
}

// ---------------------------------------------------------------------------
// Reference — weekend graded-stakes roundup. The worker route
// /api/weekly-report returns either a D1-published edition
// ({ status:"published", inputs: WeekendInput[] }) or { status:"empty" }
// when no edition has been published yet. On empty, the frontend renders a
// no-data state: a cadence message + the real upcoming graded stakes from
// /api/live (no fabricated sample data). Generation always runs client-side +
// deterministically when an edition is published.
// ---------------------------------------------------------------------------

export interface WeeklyReportResponse {
  /** "published" = a real D1 edition is available; "empty" = none yet. */
  status: "published" | "empty";
  /** Published WeekendInput editions (Friday + Saturday refresh + ...). */
  inputs?: unknown[];
}

export async function fetchWeeklyReport(): Promise<WeeklyReportResponse> {
  try {
    const res = await fetch("/api/weekly-report", { cache: "no-store" });
    if (!res.ok) return { status: "empty" };
    const data = (await res.json()) as WeeklyReportResponse;
    if (data && data.status === "published") return data;
    // Any other shape — including a stale "sample" response from a not-yet-
    // redeployed worker — normalizes to empty so the user never sees fake data.
    return { status: "empty" };
  } catch {
    // Offline / route not deployed → empty state (cadence + upcoming).
    return { status: "empty" };
  }
}
