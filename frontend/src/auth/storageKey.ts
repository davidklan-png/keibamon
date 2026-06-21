// ADR-0007 Phase 1 — namespaced localStorage key per Clerk user.
//
// Phase 0 keyed the committed-ticket log only by language (kbm.v4.<lang>).
// Phase 1 namespaces it per signed-in user so two accounts on one device
// don't collide. The signed-out path keeps the legacy key so the pre-auth
// sample (still rendered behind AuthGate for visual continuity) regresses
// nothing. Phase 2 will move ticket persistence server-side and demote
// localStorage to an offline cache.

/**
 * Build the localStorage key for the committed-ticket log.
 *
 * @param lang "ja" | "en"
 * @param userId Clerk user id when signed in, null when signed out
 * @returns
 *   - signed-in:  `kbm.v4.<userId>.<lang>`
 *   - signed-out: `kbm.v4.<lang>` (legacy Phase 0 sample key)
 */
export function storageKeyFor(lang: string, userId: string | null): string {
  return userId ? `kbm.v4.${userId}.${lang}` : `kbm.v4.${lang}`;
}
