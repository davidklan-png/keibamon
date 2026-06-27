// ============================================================================
// Impression store (ADR-0011 D3, Phase 1).
//
// Local-first store for the user's per-horse intuition marks. Replaces the
// old uma-keyed `Record<uma, IntuitionState>` state in App.tsx with a
// (race_id, horse_key)-keyed store that survives race re-selection, renumber
// (a horse's umaban shifts on a scratch but its name doesn't), and is ready
// to migrate server-side (Clerk user + D1) when Phase 3 lands.
//
// DESIGN CHOICES
//
//  - Key: `${race_id}|${horse_key}` where horse_key = normalizeName(name).
//    horse_key is the SAME transform the Worker applies to the user-provided
//    name in /api/horses/:name/form, so a marked horse resolves to the same
//    key the form-panel fetches. This is the foundation for the Phase 2
//    impression-vs-drift display.
//
//  - Value: { mark, umaban, odds_when_marked, odds_snapshot_at, formed_at }.
//    umaban + odds are stamped AT MARK TIME (the moment the user toggles the
//    mark on) so a later odds drift is visible against the impression's
//    anchor, not against the live value. formed_at is a millisecond epoch
//    for stable ordering + display.
//
//  - Persistence: localStorage, single JSON blob under KBM_IMPRESSIONS_KEY.
//    The blob is a flat Record<compositeKey, Impression> — keeps read/write
//    O(1) and avoids nested-lookup serialization overhead. ~5MB localStorage
//    cap is well above what a season's worth of marks would consume (each
//    impression is <200 bytes; even 10k impressions is ~2MB).
//
//  - No React coupling: the store is plain TS. Components re-read on a
//    version counter (useImpressionStore hook in App.tsx) so SSR + tests
//    work without jsdom. The hook is intentionally NOT in this module — it
//    keeps the store testable in isolation.
//
//  - Race_id fallback: when a race has no JRA race_id (manual entry, legacy
//    snapshot), callers pass the existing composite `date|venue|race_no|name`
//    key. Marks don't cross between the two keying schemes.
//
// BEHAVIOR PRESERVATION (vs the uma-keyed Record)
//
//  - At most one mark per horse (mutually exclusive taxonomy, same as before).
//  - Toggling a mark off (setImpression with mark=null or clearImpression)
//    deletes the entry — same semantics as the old `delete copy[uma]`.
//  - Race-scoped clear (clearRace) replaces the old `setIntuition({})` on
//    race-apply. Phase 1 calls this from App.applyRace().
// ============================================================================

import { normalizeName } from "./normalizeName";
import type { IntuitionKind, IntuitionState } from "./types";

/**
 * Reserved localStorage key. Single JSON blob; one namespace per device.
 * Phase 3 will move this server-side and demote localStorage to an offline
 * cache (same shape, same key) — keep the version suffix so a future schema
 * change can bump to .v2 without colliding.
 */
export const KBM_IMPRESSIONS_KEY = "kbm.impressions.v1";

/**
 * One stored impression. `mark` is non-null (cleared impressions are deleted,
 * not stored with mark=null). `umaban` + odds fields are snapshotted at mark
 * time so the Phase 2 impression-vs-drift UI has a stable anchor.
 *
 * `umaban` is kept as a number (the canonical shape from LiveRunner.umaban).
 * `odds_when_marked` may be null when the mark was set without an odds
 * context (e.g. an offline FormPanel); the drift UI degrades to "first
 * seen" in that case.
 */
export interface Impression {
  mark: IntuitionKind;
  umaban: number;
  odds_when_marked: number | null;
  odds_snapshot_at: string | null;
  formed_at: number;
}

/** On-disk shape: a flat map keyed by `${race_id}|${horse_key}`. */
export type ImpressionMap = Record<string, Impression>;

// Resolve `localStorage` lazily through globalThis so the module is SSR-safe
// (no top-level ReferenceError) AND compatible with `vi.stubGlobal(
// "localStorage", stub)` in tests. Bare `window.localStorage` would miss the
// stub; bare `localStorage` would throw under SSR. Project convention (see
// auth/ticketQueue.ts) is to lean on the try/catch alone; we keep the helper
// so the `useState(() => loadImpressions())` initializer in App.tsx can't
// trip a ReferenceError mid-render.
function ls(): Storage | null {
  try {
    if (typeof globalThis === "undefined") return null;
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the composite store key for a (race_id, horse_name) pair.
 *
 * horse_name is normalized via NFKC + whitespace strip so a name spelled
 * with full-width whitespace in one place and half-width in another resolves
 * to the same impression entry. Returns null when race_id OR the normalized
 * horse_key is empty — those impressions are unstoreable (the caller should
 * skip the write rather than pollute the map with an unaddressable key).
 */
export function impressionKey(
  raceId: string | null | undefined,
  horseName: string | null | undefined,
): string | null {
  if (!raceId) return null;
  const horseKey = normalizeName(horseName);
  if (!horseKey) return null;
  return `${raceId}|${horseKey}`;
}

// ---------------------------------------------------------------------------
// PURE layer — same map in / map out. No localStorage. Unit-testable in
// isolation (mirrors the worker's pure-builder pattern).
// ---------------------------------------------------------------------------

/** Read a single impression from an in-memory map. null when absent. */
export function getImpression(
  map: ImpressionMap,
  raceId: string | null | undefined,
  horseName: string | null | undefined,
): Impression | null {
  const key = impressionKey(raceId, horseName);
  if (!key) return null;
  return map[key] ?? null;
}

/**
 * Write (or clear) a single impression, returning a new map. The original is
 * never mutated. Clearing (mark === null OR omitting context fields) deletes
 * the entry — same semantics as the old uma-keyed `delete copy[uma]`.
 *
 * `now` is injected so tests are deterministic. At mark time, callers MUST
 * pass the runner's current odds + the snapshot's published_at — these are
 * the foundation of the impression-vs-drift feature in Phase 2.
 */
export function setImpression(
  prev: ImpressionMap,
  raceId: string | null | undefined,
  horseName: string | null | undefined,
  next: {
    mark: IntuitionState;
    umaban: number;
    odds_when_marked?: number | null;
    odds_snapshot_at?: string | null;
  },
  now: number = Date.now(),
): ImpressionMap {
  const key = impressionKey(raceId, horseName);
  if (!key) return prev;
  if (next.mark === null) {
    // Toggle off → delete the entry. Same shape as the old delete copy[uma].
    if (!(key in prev)) return prev;
    const copy = { ...prev };
    delete copy[key];
    return copy;
  }
  return {
    ...prev,
    [key]: {
      mark: next.mark,
      umaban: next.umaban,
      odds_when_marked: next.odds_when_marked ?? null,
      odds_snapshot_at: next.odds_snapshot_at ?? null,
      formed_at: now,
    },
  };
}

/**
 * Clear a single impression. Returns the input map unchanged when the entry
 * doesn't exist (no spurious re-render).
 */
export function clearImpression(
  prev: ImpressionMap,
  raceId: string | null | undefined,
  horseName: string | null | undefined,
): ImpressionMap {
  const key = impressionKey(raceId, horseName);
  if (!key || !(key in prev)) return prev;
  const copy = { ...prev };
  delete copy[key];
  return copy;
}

/**
 * Race-scoped view: all impressions for one race, as a Record<horse_key,
 * Impression>. Used by the ticket builder (App.tsx regenerate) — it iterates
 * the map and resolves horse_key → umaban via the current runners list to
 * rebuild the uma-keyed shape the recommender still expects.
 *
 * Returns a NEW object each call (callers can safely mutate). Empty when the
 * race has no marks or the raceId is empty.
 */
export function impressionsByRace(
  map: ImpressionMap,
  raceId: string | null | undefined,
): Record<string, Impression> {
  if (!raceId) return {};
  const prefix = `${raceId}|`;
  const out: Record<string, Impression> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(prefix)) {
      const horseKey = k.slice(prefix.length);
      out[horseKey] = v;
    }
  }
  return out;
}

/**
 * Clear all impressions for one race. Called from App.applyRace() to replace
 * the old `setIntuition({})` reset — the user's marks from the previous race
 * are dropped when they switch to a new one. Phase 3 (server-side migration)
 * will revisit whether marks should follow the user across races.
 */
export function clearRace(
  prev: ImpressionMap,
  raceId: string | null | undefined,
): ImpressionMap {
  if (!raceId) return prev;
  const prefix = `${raceId}|`;
  let changed = false;
  const out: ImpressionMap = {};
  for (const [k, v] of Object.entries(prev)) {
    if (k.startsWith(prefix)) {
      changed = true;
    } else {
      out[k] = v;
    }
  }
  return changed ? out : prev;
}

// ---------------------------------------------------------------------------
// localStorage shell. Thin I/O around the pure layer. SSR-safe: when
// `globalThis.localStorage` is undefined (server render, jsdom without
// storage), reads return {} and writes no-op.
// ---------------------------------------------------------------------------

/**
 * Load the full impression map from localStorage. Returns {} when storage is
 * unavailable or the blob is missing/corrupt — never throws (a malformed
 * blob is silently ignored rather than blocking the app).
 */
export function loadImpressions(): ImpressionMap {
  const storage = ls();
  if (!storage) return {};
  try {
    const raw = storage.getItem(KBM_IMPRESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as ImpressionMap;
  } catch {
    return {};
  }
}

/**
 * Persist the full impression map. Failures are swallowed (best-effort) so a
 * quota-exceeded or storage-disabled state degrades to "in-memory only"
 * rather than throwing into the React render.
 */
export function saveImpressions(map: ImpressionMap): void {
  const storage = ls();
  if (!storage) return;
  try {
    storage.setItem(KBM_IMPRESSIONS_KEY, JSON.stringify(map));
  } catch {
    /* best-effort; in-memory only */
  }
}

/**
 * Drop the entire store. Used by the unit tests' beforeEach reset; not
 * wired into app UI (no "clear all marks" affordance in Phase 1).
 */
export function wipeImpressions(): void {
  const storage = ls();
  if (!storage) return;
  try {
    storage.removeItem(KBM_IMPRESSIONS_KEY);
  } catch {
    /* best-effort */
  }
}
