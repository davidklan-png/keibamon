import React, { createContext, useContext, useEffect, useState } from "react";
import { useUser, useAuth as useClerkAuth, useClerk } from "@clerk/clerk-react";

// ADR-0007 Phase 1 — single auth surface for the app.
//
// Why a context instead of calling Clerk hooks directly in App.tsx:
//   1. AuthGate/SignInScreen/AgeGate stay pure of Clerk imports, so they can
//      be exercised with `renderToStaticMarkup` (the i18n.test.tsx style)
//      without dragging Clerk's runtime into the test.
//   2. When VITE_CLERK_PUBLISHABLE_KEY is unset, main.tsx still renders App
//      (no ClerkProvider ancestor). Hooks like useUser() would throw then, so
//      AuthProvider falls back to a no-op value — soft fail in dev, never a
//      hard crash. Build is unaffected.
//
// Phase 1 stores the 20+ self-attestation in localStorage keyed by Clerk user
// id. Phase 2 will move this to the social D1 row (GET /api/social/me) once
// the worker is live; the localStorage read keeps the gate from re-showing on
// reload in the meantime.

export interface AuthState {
  isSignedIn: boolean;
  /** Clerk user id (string), or null when signed out / Clerk unavailable. */
  userId: string | null;
  /** True iff the user has self-attested 20+ (Phase 1: local flag). */
  ageVerified: boolean;
  /** Resolves a fresh Clerk JWT, or null when signed out / unavailable. */
  getToken: () => Promise<string | null>;
  /** Open Clerk's hosted sign-in modal. No-op when Clerk is unavailable. */
  openSignIn: () => void;
  /**
   * Flip the local age-verified flag. The durable write (POST /api/social/me)
   * is the caller's responsibility (AgeGate does it). Best-effort: never
   * throws.
   */
  setAgeVerified: (v: boolean) => Promise<void>;
}

const NOOP_VALUE: AuthState = {
  isSignedIn: false,
  userId: null,
  ageVerified: false,
  getToken: async () => null,
  openSignIn: () => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(
        "[auth] openSignIn() called without Clerk configured. Set VITE_CLERK_PUBLISHABLE_KEY.",
      );
    }
  },
  setAgeVerified: async () => {
    /* Clerk unavailable — no-op. */
  },
};

const AuthContext = createContext<AuthState>(NOOP_VALUE);

export const useAuth = (): AuthState => useContext(AuthContext);

export const CLERK_ENABLED = !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // Constant at module load — same branch every render, so the conditional
  // return below does not violate the Rules of Hooks.
  if (!CLERK_ENABLED) {
    return <AuthContext.Provider value={NOOP_VALUE}>{children}</AuthContext.Provider>;
  }
  return <ClerkAuthInner>{children}</ClerkAuthInner>;
}

function ageKey(userId: string): string {
  return `kbm.age_verified.${userId}`;
}

function readAgeVerified(userId: string | null): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(ageKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeAgeVerified(userId: string | null, v: boolean): void {
  if (!userId) return;
  try {
    localStorage.setItem(ageKey(userId), v ? "1" : "0");
  } catch {
    /* localStorage unavailable — in-memory flag still flips. */
  }
}

function ClerkAuthInner({ children }: { children: React.ReactNode }) {
  const { user } = useUser();
  const { getToken } = useClerkAuth();
  const clerk = useClerk();

  const userId = user?.id ?? null;
  const [ageVerified, setAgeVerifiedState] = useState<boolean>(() =>
    readAgeVerified(userId),
  );

  // Re-read the cached flag if the signed-in user changes.
  useEffect(() => {
    setAgeVerifiedState(readAgeVerified(userId));
  }, [userId]);

  const value: AuthState = {
    isSignedIn: !!user,
    userId,
    ageVerified,
    getToken: async () => {
      try {
        return (await getToken()) ?? null;
      } catch {
        return null;
      }
    },
    openSignIn: () => {
      try {
        clerk.openSignIn();
      } catch {
        /* Clerk modal unavailable — no-op. */
      }
    },
    setAgeVerified: async (v: boolean) => {
      setAgeVerifiedState(v);
      writeAgeVerified(userId, v);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
