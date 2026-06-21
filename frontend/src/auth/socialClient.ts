// ADR-0007 Phase 1 — thin client for the social Worker's /api/social/me.
//
// Offline-first: every call swallows its own errors. The My Tickets UI must
// not block on the social backend being up. Profile upsert and age_verified
// writes are best-effort; the Worker is the source of truth once Phase 2
// moves ticket persistence server-side.

/** Base URL of the social Worker, no trailing slash. Empty → same-origin. */
export function base(): string {
  const v = (import.meta.env.VITE_SOCIAL_API_BASE as string | undefined) ?? "";
  // Tolerate a stray trailing slash so builds don't silently break.
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

export interface SocialProfile {
  id: string;
  clerk_user_id: string;
  handle?: string | null;
  display_name?: string | null;
  avatar?: string | null;
  age_verified: number;
  created_at: number;
}

/**
 * POST /api/social/me with the Clerk JWT. Body optional (e.g. {age_verified:1}).
 * Resolves to null on any failure — callers MUST tolerate null.
 */
export async function postMe(
  token: string | null,
  body?: { age_verified?: number },
): Promise<SocialProfile | null> {
  if (!token) return null;
  const url = `${base()}/api/social/me`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : "{}",
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as SocialProfile;
  } catch {
    return null;
  }
}
