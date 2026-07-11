// ============================================================================
// useInvite — the invite deep-link orchestrator (Social UX Fixes, Phase C).
//
// Owns the full deferred-deep-link lifecycle:
//   1. Boot: read ?friend=<handle>, reconcile with the sessionStorage stash
//      (the stash is written BEFORE any OAuth redirect, so it survives the
//      round-trip AND the Phase B handle-setup step).
//   2. When "ready" — signed-out (show a "Sign in to add" interstitial) OR
//      signed-in-with-handle (past the Phase B gate, so resolution can act) —
//      fetch the inviter's profile (token-optional getProfile) and run the
//      resolver. friends/pending/self auto-resolve; none → interstitial; 404
//      → friendly error (unknown OR blocked, indistinguishable = no leak).
//   3. The App shell renders the exposed `interstitial` (full-screen, blocking),
//      shows the one-shot `toast`, or renders the `notFound` error, and wires
//      navigation (Friends tab) + Clerk sign-in.
//
// The invite is consumed (stash + URL param cleared) the moment it resolves to
// a terminal outcome (added / already / self / not_found) — never dropped
// silently during signup, because the stash carries it across auth + handle
// setup and is only cleared on resolution.
// ============================================================================
import { useEffect, useRef, useState } from "react";
import { acceptInvite, getProfile, type PublicProfile } from "./socialClient";
import {
  resolveInvite,
  stashInvite,
  readStashedInvite,
  clearStashedInvite,
  stripInviteFromUrl,
} from "./inviteResolver";

export interface InviteToast {
  kind: "added" | "already" | "self";
  handle: string;
}

export interface InviteInterstitialState {
  profile: PublicProfile;
  handle: string;
  /** "add" = signed-in, one tap forms the friendship; "signin" = signed-out, opens Clerk. */
  mode: "add" | "signin";
  busy: boolean;
}

export interface UseInviteArgs {
  getToken: () => Promise<string | null>;
  isSignedIn: boolean;
  /** True once the viewer has a handle (past the Phase B gate). */
  hasHandle: boolean;
}

export interface UseInviteResult {
  /** Render full-screen (blocks the app) when non-null. */
  interstitial: InviteInterstitialState | null;
  /** One-shot toast; App shows it then calls clearToast(). */
  toast: InviteToast | null;
  clearToast: () => void;
  /** Friendly "couldn't find @handle" error (dismissable). */
  notFound: { handle: string } | null;
  /** Signed-in none: the user tapped Add → form the friendship (one call). */
  accept: () => Promise<void>;
  /** Dismiss the not-found error. */
  dismiss: () => void;
}

export function useInvite({ getToken, isSignedIn, hasHandle }: UseInviteArgs): UseInviteResult {
  const [inviteHandle, setInviteHandle] = useState<string | null>(null);
  const [interstitial, setInterstitial] = useState<InviteInterstitialState | null>(null);
  const [toast, setToast] = useState<InviteToast | null>(null);
  const [notFound, setNotFound] = useState<{ handle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Track which (handle, signed-state) we've already resolved so the effect
  // doesn't re-fetch on every render (getToken identity churn).
  const resolvedFor = useRef<string | null>(null);

  // ---- Boot: read ?friend=, reconcile with the stash. ----
  useEffect(() => {
    let urlHandle: string | null = null;
    try {
      urlHandle = new URLSearchParams(window.location.search).get("friend");
    } catch {
      /* no window.location — non-fatal */
    }
    const stored = readStashedInvite();
    const handle = urlHandle ?? stored;
    // Stash BEFORE any redirect so it survives the OAuth round-trip even if the
    // redirect drops the query param.
    if (urlHandle && urlHandle !== stored) stashInvite(urlHandle);
    if (handle) setInviteHandle(handle);
  }, []);

  function consume(handle: string) {
    clearStashedInvite();
    stripInviteFromUrl();
    resolvedFor.current = null;
    setInviteHandle((h) => (h === handle ? null : h));
    setInterstitial(null);
  }

  // ---- Resolve when ready (signed-out, or signed-in-with-handle). ----
  const ready = !isSignedIn || hasHandle;
  useEffect(() => {
    if (!inviteHandle || !ready) return;
    const key = `${inviteHandle}|${isSignedIn ? "in" : "out"}`;
    if (resolvedFor.current === key) return;
    resolvedFor.current = key;
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      const r = await getProfile(token, inviteHandle);
      if (cancelled) return;
      if (!r.ok) {
        // 404 = unknown handle OR blocked (indistinguishable → no leak).
        setNotFound({ handle: inviteHandle });
        consume(inviteHandle);
        return;
      }
      const profile = r.data;
      const friendship = profile.friendship ?? "none";
      // Own link (only reachable signed-in; signed-out sees "none").
      if (friendship === "self") {
        setToast({ kind: "self", handle: inviteHandle });
        consume(inviteHandle);
        return;
      }
      const rel = friendship === "friends"
        ? "friends"
        : friendship === "pending_incoming" || friendship === "pending_outgoing"
          ? "pending"
          : "none";
      const action = resolveInvite(rel, inviteHandle);
      switch (action.kind) {
        case "already_friends":
          setToast({ kind: "already", handle: action.handle });
          consume(action.handle);
          return;
        case "accept_pending": {
          // Signed-in only (pending is viewer-relative; signed-out saw "none").
          const ar = await acceptInvite(await getToken(), action.handle);
          if (cancelled) return;
          // 404 (race: blocked/gone) → friendly error, no leak; else added.
          if (!ar.ok && ar.err.kind === "http" && ar.err.status === 404) {
            setNotFound({ handle: action.handle });
          } else {
            setToast({ kind: "added", handle: action.handle });
          }
          consume(action.handle);
          return;
        }
        case "interstitial":
          setInterstitial({ profile, handle: action.handle, mode: isSignedIn ? "add" : "signin", busy: false });
          return; // await user action (do NOT consume)
        case "silent":
        case "not_found":
          // not_found/silent: no leak. Silent (blocked) collapses to the same
          // friendly error here since the wire can't distinguish; use the
          // closure handle (silent intentionally doesn't echo one).
          setNotFound({ handle: inviteHandle });
          consume(inviteHandle);
          return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteHandle, ready, isSignedIn, hasHandle, getToken]);

  async function accept() {
    if (!interstitial || busy) return;
    setBusy(true);
    const handle = interstitial.handle;
    const token = await getToken();
    const r = await acceptInvite(token, handle);
    setBusy(false);
    if (r.ok) {
      setToast({ kind: "added", handle });
      consume(handle);
    } else if (r.err.kind === "http" && r.err.status === 404) {
      // Race: handle gone / blocked mid-flow → friendly error, no leak.
      setNotFound({ handle });
      consume(handle);
    }
    // Network failure: leave the interstitial up so the user can retry.
  }

  function dismiss() {
    // Consume whichever surface is showing (interstitial "Not now" or the
    // not-found error) and drop the invite.
    const h = interstitial?.handle ?? notFound?.handle;
    if (!h) return;
    setInterstitial(null);
    setNotFound(null);
    consume(h);
  }

  return {
    interstitial: interstitial ? { ...interstitial, busy } : null,
    toast,
    clearToast: () => setToast(null),
    notFound,
    accept,
    dismiss,
  };
}
