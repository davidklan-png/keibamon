// ============================================================================
// Funnel lane store (ADR-0011 Phase 2 — two-path entry).
//
// Tiny localStorage-backed preference for the user's top-of-funnel lane choice:
//   - "quick"    → jump straight to building tickets from the live card
//   - "research" → open the weekend roundup and drill into contenders
//
// Both lanes share the same HorseDrillView + impression store, so a mark made
// on either surface shows on the other — the lane only picks the entry screen.
// Mirrors the impressions.ts I/O pattern (lazy `ls()` + try/catch) so SSR and
// storage-disabled environments degrade silently to in-memory state.
// ============================================================================

/** Reserved localStorage key. Fresh key with no prior shape (no migration). */
export const KBM_FUNNEL_KEY = "kbm.funnel.v1";

export type FunnelLane = "quick" | "research";

/** Resolve localStorage lazily through globalThis (SSR-safe, test-stubbable). */
function ls(): Storage | null {
  try {
    if (typeof globalThis === "undefined") return null;
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function isValid(v: unknown): v is FunnelLane {
  return v === "quick" || v === "research";
}

/**
 * Load the stored lane. null when storage is unavailable, the key is missing,
 * or the stored value isn't one of the two valid lanes — callers treat null as
 * "first launch" and surface the intro card.
 */
export function loadFunnel(): FunnelLane | null {
  const storage = ls();
  if (!storage) return null;
  try {
    const raw = storage.getItem(KBM_FUNNEL_KEY);
    if (!isValid(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Persist the lane. Best-effort: failures degrade silently to in-memory. */
export function saveFunnel(lane: FunnelLane): void {
  const storage = ls();
  if (!storage) return;
  try {
    storage.setItem(KBM_FUNNEL_KEY, lane);
  } catch {
    /* best-effort; in-memory only */
  }
}
