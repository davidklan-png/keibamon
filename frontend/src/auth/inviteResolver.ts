// ============================================================================
// Invite deep-link resolver — pure state machine (Social UX Fixes, Phase C).
//
// Maps the relationship state between the viewer and the inviter (whose handle
// arrived as ?friend=) to the action the invite flow should take. Pure +
// unit-tested in isolation (all five states); the side effects (fetch, toast,
// navigation) live in useInvite + the App shell.
//
// The five states (per the spec):
//   none      → show the "Add @handle" interstitial (one tap to add)
//   friends   → already friends → Friends tab + "already friends" toast
//   pending   → a pending request either direction → one-tap accept
//   blocked   → block either direction → SILENT no-op (no existence leak)
//   unknown   → handle not found → friendly error
//
// NO-LEAK NOTE: a block is hidden from the client as a 404 (see handleProfile),
// so "blocked" and "unknown" are indistinguishable over the wire — both surface
// as a not-found 404. The live flow therefore treats blocked as unknown (→
// friendly error), because telling them apart would itself be a leak. The
// "blocked → silent" branch below is the idealized behavior for the state
// machine and is kept distinct so the unit test pins all five states; it is
// defensive (if a future change makes a block distinguishable to the resolver,
// the silent no-op is the correct no-leak action).
// ============================================================================

export type InviteRel = "none" | "friends" | "pending" | "blocked" | "unknown";

export type InviteAction =
  | { kind: "interstitial"; handle: string } // none → render the Add card
  | { kind: "already_friends"; handle: string } // friends → toast + Friends tab
  | { kind: "accept_pending"; handle: string } // pending → one-tap accept + Friends tab
  | { kind: "silent" } // blocked → no-op, no leak
  | { kind: "not_found"; handle: string }; // unknown → friendly error

export function resolveInvite(rel: InviteRel, handle: string): InviteAction {
  switch (rel) {
    case "none":
      return { kind: "interstitial", handle };
    case "friends":
      return { kind: "already_friends", handle };
    case "pending":
      return { kind: "accept_pending", handle };
    case "blocked":
      return { kind: "silent" };
    case "unknown":
      return { kind: "not_found", handle };
  }
}

// ---------------------------------------------------------------------------
// Deferred-context persistence (survives the OAuth round-trip + handle setup).
// ---------------------------------------------------------------------------
// sessionStorage is the store: it survives same-tab OAuth redirects AND a
// reload, but is cleared when the tab closes (an invite is a session-scoped
// intent, not a durable preference). The invite is stashed at boot from the
// ?friend= query param BEFORE any redirect, and re-read on every boot so a
// redirect that dropped the param (Clerk dashboard "After sign-in URL"
// misconfig) can't silently drop the invite.

export const INVITE_STORAGE_KEY = "kbm.invite.handle";

/** Read the stashed invite handle (sessionStorage), or null. Safe if storage is unavailable. */
export function readStashedInvite(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(INVITE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Stash the invite handle. Called at boot when ?friend= is present, BEFORE any
 * sign-in redirect, so it survives the OAuth round-trip.
 */
export function stashInvite(handle: string): void {
  try {
    globalThis.sessionStorage?.setItem(INVITE_STORAGE_KEY, handle);
  } catch {
    /* sessionStorage unavailable — the URL param is the fallback */
  }
}

/** Clear the stashed invite once it has been resolved (or dismissed). */
export function clearStashedInvite(): void {
  try {
    globalThis.sessionStorage?.removeItem(INVITE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Strip the ?friend= param from the URL (replaceState, no reload / no history
 * noise) once the invite has been consumed, so a reload or share of the URL
 * doesn't re-trigger the flow.
 */
export function stripInviteFromUrl(): void {
  try {
    const url = new URL(globalThis.location.href);
    if (url.searchParams.has("friend")) {
      url.searchParams.delete("friend");
      globalThis.history?.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  } catch {
    /* location/history unavailable — non-fatal */
  }
}
