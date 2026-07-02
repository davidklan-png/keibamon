// ============================================================================
// ADR-0018 — account-backed impression marks (Session 5b).
//
// The signed-out My Tickets empty state promises "sign in to save your marks."
// This module makes that promise true. Today marks live only in localStorage
// (kbm.impressions.v1) — this layer pulls/pushes them against the social
// Worker's /api/social/me/impressions endpoints when signed in, while keeping
// localStorage as the canonical store when signed out.
//
// SEMANTICS (decided in ADR-0018 — implement, don't re-open):
//
//   ON SIGN-IN:
//     GET server map → mergeImpressions(local, server) → setImpressions(merged)
//     → PUT merged. One-time per session.
//
//   WHILE SIGNED IN:
//     Debounced (~2s) best-effort PUT of the full map on impressions change —
//     mirrors the ticketQueue offline-tolerance pattern: failure = silent
//     retry on next change, no UI error.
//
//   SIGNED OUT:
//     Exactly today's behavior (localStorage only). Sign-out does NOT wipe
//     local marks — device-local research stays, matching current product.
//
// KNOWN EDGE (accepted, documented in ADR-0018): a mark cleared locally
//   BEFORE sign-in can reappear if it still exists server-side (union
//   semantics at merge time). The full-replace PUT after the merge makes
//   subsequent clears stick.
//
// This module is OBSERVER-ONLY. It reads impressions + setImpressions from
// App's existing useState; it does NOT fork the store, and the RunnerMark /
// HorseDrillView write paths are untouched.
// ============================================================================

import { useEffect, useRef } from "react";
import type { Impression, ImpressionMap } from "../lib/impressions";
import { base, type SocialError } from "./socialClient";

/** Row shape returned by GET /api/social/me/impressions (server-side columns). */
export interface ServerImpressionRow {
  comp_key: string;
  mark: string;
  umaban: number | null;
  odds_when_marked: number | null;
  odds_snapshot_at: string | null;
  formed_at: number;
  updated_at?: number;
}

/** PUT body shape — the server treats comp_key as an opaque string. */
interface PutBody {
  impressions: ImpressionMap;
}

// ---------------------------------------------------------------------------
// PURE LAYER — mergeImpressions. No I/O. Unit-testable in isolation.
// ---------------------------------------------------------------------------

/**
 * Last-Writer-Wins union of two impression maps.
 *
 * For each comp_key present in either map, keep the entry with the larger
 * `formed_at`. Ties (equal formed_at) prefer the LOCAL entry — the user's
 * device is the source of truth for "what they just did", and a tie means the
 * server clock and the client clock agreed on the same millisecond (rare; the
 * local write is the more recent intent). When both entries are absent the
 * key is dropped (can't happen here since iteration is over the union).
 *
 * Returns a NEW ImpressionMap; inputs are never mutated.
 *
 * Edge cases (pinned by tests):
 *   - server empty → returns local unchanged
 *   - local empty → returns server unchanged
 *   - both empty → {}
 *   - same key, server newer → server wins
 *   - same key, local newer → local wins
 *   - same key, tie → local wins
 *   - the mark field is preserved verbatim (it's a validated IntuitionKind at
 *     write time; we trust the server round-tripped it correctly)
 */
export function mergeImpressions(
  local: ImpressionMap,
  server: ImpressionMap,
): ImpressionMap {
  const out: ImpressionMap = {};
  // First pass: copy local entries verbatim.
  for (const [k, v] of Object.entries(local)) {
    out[k] = v;
  }
  // Second pass: for each server entry, take it iff the local entry is missing
  // OR strictly newer. Equal formed_at → local wins (already in `out`).
  for (const [k, sv] of Object.entries(server)) {
    const lv = out[k];
    if (!lv || sv.formed_at > lv.formed_at) {
      out[k] = sv;
    }
  }
  return out;
}

/**
 * Convert the server's row array into the client ImpressionMap shape.
 *
 * Drops any row whose comp_key is empty (defensive against a malformed write)
 * or whose mark is empty. Trusts the server's mark/umaban/odds fields — the
 * worker validates them at PUT time.
 */
export function rowsToMap(rows: ServerImpressionRow[]): ImpressionMap {
  const out: ImpressionMap = {};
  for (const r of rows) {
    if (!r.comp_key || !r.mark) continue;
    out[r.comp_key] = {
      mark: r.mark as Impression["mark"],
      umaban: r.umaban ?? 0,
      odds_when_marked: r.odds_when_marked ?? null,
      odds_snapshot_at: r.odds_snapshot_at ?? null,
      formed_at: r.formed_at,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLIENT I/O — thin wrappers around authedFetch (mirrors socialClient).
// ---------------------------------------------------------------------------

export type ImpressionsResult<T> =
  | { ok: true; data: T }
  | { ok: false; err: SocialError };

/** GET /api/social/me/impressions → the caller's full map. */
export async function getMyImpressions(
  token: string | null,
): Promise<ImpressionsResult<ImpressionMap>> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  let res: Response;
  try {
    res = await fetch(`${base()}/api/social/me/impressions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return { ok: false, err: { kind: "network" } };
  }
  if (!res.ok) return { ok: false, err: { kind: "http", status: res.status } };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, err: { kind: "http", status: 200 } };
  }
  const rows = (body as { impressions?: ServerImpressionRow[] } | null)?.impressions;
  if (!Array.isArray(rows)) {
    return { ok: false, err: { kind: "http", status: 200 } };
  }
  return { ok: true, data: rowsToMap(rows) };
}

/**
 * PUT /api/social/me/impressions — transactional full-replace. Best-effort:
 * the caller (useImpressionsSync) does NOT surface failures to the UI; the
 * next debounce window retries on the next impressions change.
 */
export async function putMyImpressions(
  token: string | null,
  map: ImpressionMap,
): Promise<ImpressionsResult<{ ok: true }>> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  let res: Response;
  try {
    res = await fetch(`${base()}/api/social/me/impressions`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({ impressions: map } satisfies PutBody),
    });
  } catch {
    return { ok: false, err: { kind: "network" } };
  }
  if (!res.ok) return { ok: false, err: { kind: "http", status: res.status } };
  return { ok: true, data: { ok: true } };
}

// ---------------------------------------------------------------------------
// REACT HOOK — the only wiring App.tsx needs.
// ---------------------------------------------------------------------------

/** Debounce window for the steady-state PUT. Tuned for "user finished marking". */
const DEBOUNCE_MS = 2000;

export interface ImpressionsSyncApi {
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
}

/**
 * Observes `impressions` and `auth`, syncing to the server:
 *
 *   - On sign-in transition (null → user): GET → merge → setImpressions → PUT.
 *     The merge runs LWW on formed_at; the merge result replaces App's state
 *     so the UI immediately reflects the cross-device union.
 *   - While signed in: debounced PUT of the full map on impressions change.
 *   - On sign-out: nothing — local marks stay (current product behavior).
 *
 * The hook returns nothing; it is a side-effect-only observer. App's
 * `impressions` state remains the single source of truth for the UI; this
 * hook just keeps the server in sync (and pulls once per session on sign-in).
 *
 * The setImpressions prop takes a React state-updater so we can write the
 * merged map without racing against in-flight local writes — we accept the
 * functional form and only replace when the merge differs from current state
 * (avoids a spurious re-render when server == local).
 */
export function useImpressionsSync(
  impressions: ImpressionMap,
  setImpressions: (
    next:
      | ImpressionMap
      | ((prev: ImpressionMap) => ImpressionMap),
  ) => void,
  auth: ImpressionsSyncApi,
): void {
  // Tracks whether we've done the one-time sign-in merge for THIS session.
  // Reset when the user signs out (so a re-sign-in re-merges). Ref, not state,
  // so it doesn't trigger a re-render.
  const mergedForSessionRef = useRef<boolean>(false);

  // ---------------------------------------------------------------------
  // Sign-in transition: GET → merge → setImpressions → PUT. One-time.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!auth.isSignedIn) {
      // Sign-out (or initial signed-out state): reset so a future sign-in
      // re-runs the merge. Local marks are NOT wiped — device-local research
      // stays put.
      mergedForSessionRef.current = false;
      return;
    }
    if (mergedForSessionRef.current) return; // already merged this session
    let cancelled = false;
    (async () => {
      const token = await auth.getToken();
      if (!token || cancelled) return;
      const got = await getMyImpressions(token);
      if (cancelled || !got.ok) {
        // GET failed (offline / 5xx) — defer the merge. The next sign-in
        // (after a sign-out cycle) re-tries. In the meantime, the debounced
        // PUT below will still push local state, so a first-time sign-in on
        // a new device uploads its local marks even if GET failed.
        return;
      }
      // Merge server-into-local (LWW). setImpressions gets the functional
      // form so we read the latest in-flight state, not the stale closure
      // copy of `impressions` from the effect's render.
      setImpressions((prev) => {
        const merged = mergeImpressions(prev, got.data);
        // If the merge produced something byte-identical to prev (server was
        // already a subset of local with older timestamps), skip the write —
        // a spurious state update would just trigger the debounced PUT below
        // for nothing.
        if (sameMap(merged, prev)) return prev;
        return merged;
      });
      // PUT the merged result so the server reflects the union. Read post-
      // merge state via a fresh effect (the setImpressions above is async).
      // Easiest correct path: re-fetch the token and PUT the merged map.
      // We can't read the just-set React state synchronously, so compute the
      // merged map directly from the closure's `impressions` + got.data.
      const mergedForPut = mergeImpressions(impressions, got.data);
      await putMyImpressions(token, mergedForPut);
      mergedForSessionRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // Re-run when the signed-in bit flips. Not on every impressions change —
    // the steady-state sync has its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.isSignedIn]);

  // ---------------------------------------------------------------------
  // Steady-state: debounced best-effort PUT on impressions change.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!auth.isSignedIn) return;
    const handle = setTimeout(() => {
      void (async () => {
        const token = await auth.getToken();
        if (!token) return;
        // Best-effort: failure is silent — the next impressions change will
        // re-trigger this effect and retry. No UI surface, no queue (mirrors
        // the ticketQueue pattern but simpler since PUT is idempotent and
        // full-replace).
        await putMyImpressions(token, impressions);
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [impressions, auth]);
}

// ---------------------------------------------------------------------------
// Internal — shallow equality on ImpressionMap. Used to skip a spurious
// setImpressions write when the merge produced no change.
// ---------------------------------------------------------------------------

function sameMap(a: ImpressionMap, b: ImpressionMap): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    const av = a[k];
    const bv = b[k];
    if (!bv) return false;
    if (
      av.mark !== bv.mark ||
      av.umaban !== bv.umaban ||
      av.odds_when_marked !== bv.odds_when_marked ||
      av.odds_snapshot_at !== bv.odds_snapshot_at ||
      av.formed_at !== bv.formed_at
    ) {
      return false;
    }
  }
  return true;
}
