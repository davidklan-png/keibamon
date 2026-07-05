// ADR-0007 — thin client for the social Worker.
//
// Phase 1: /api/social/me (profile upsert + age self-attestation).
// Phase 2: /api/social/tickets (CRUD). The server is the source of truth
// for committed tickets; localStorage mirrors the GET response so the feed
// renders instantly on next load (read-through cache).
//
// Offline-first: every call rejects to a typed failure so callers can queue
// or fall back. The My Tickets UI must not block on the social backend being
// up — a failed commit is held in a localStorage retry queue (see App.tsx
// `commit`) and flushed on the next signed-in load.

import type { CommittedTicket } from "../lib/types";

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

/** Phase 3: public profile shape (server never sends clerk_user_id/email/age_verified). */
export interface PublicProfile {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
  created_at: number;
  follower_count: number;
  followee_count: number;
  is_following?: boolean;
  tickets?: CommittedTicket[];
}

/** Phase 3: a followed user with at least one ticket on a race/card. */
export interface FriendsAvatar {
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
}

/** Fetch failure tagged so callers can distinguish offline from auth. */
export type SocialError =
  | { kind: "no_token" }
  | { kind: "network" }
  | { kind: "http"; status: number };

async function authedFetch(
  token: string | null,
  path: string,
  init: RequestInit,
): Promise<{ ok: true; res: Response } | { ok: false; err: SocialError }> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      cache: "no-store",
    });
    return { ok: true, res };
  } catch {
    return { ok: false, err: { kind: "network" } };
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * POST /api/social/me with the Clerk JWT. Body optional (e.g. {age_verified:1}).
 * Resolves to null on any failure — callers MUST tolerate null.
 *
 * (Phase 1 surface — kept here alongside the Phase 2 ticket calls.)
 *
 * Phase 3: body extended to accept handle / display_name / avatar.
 */
export async function postMe(
  token: string | null,
  body?: { age_verified?: number; handle?: string | null; display_name?: string | null; avatar?: string | null },
): Promise<SocialProfile | null> {
  if (!token) return null;
  const r = await authedFetch(token, "/api/social/me", {
    method: "POST",
    body: body ? JSON.stringify(body) : "{}",
  });
  if (!r.ok || !r.res.ok) return null;
  return (await r.res.json()) as SocialProfile;
}

/** Result shape for the social actions below. */
export type SocialResult<T> =
  | { ok: true; data: T }
  | { ok: false; err: SocialError };

/** Phase 3: POST /api/social/me returning a typed result (so callers can
 * distinguish a handle collision from network failure). */
export async function postMeTyped(
  token: string | null,
  body: { age_verified?: number; handle?: string | null; display_name?: string | null; avatar?: string | null },
): Promise<SocialResult<SocialProfile>> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  const r = await authedFetch(token, "/api/social/me", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (r.res.status === 409) return { ok: false, err: { kind: "http", status: 409 } };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: (await r.res.json()) as SocialProfile };
}

/** Phase 3: POST /api/social/follow/:userId (idempotent). */
export async function follow(
  token: string | null,
  userId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/follow/${encodeURIComponent(userId)}`, {
    method: "POST",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** Phase 3: DELETE /api/social/follow/:userId (idempotent). */
export async function unfollow(
  token: string | null,
  userId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/follow/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** Phase 4: POST /api/social/block/:userId — idempotent; severs follows both ways. */
export async function block(
  token: string | null,
  userId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/block/${encodeURIComponent(userId)}`, {
    method: "POST",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** Phase 4: DELETE /api/social/block/:userId — idempotent unblock. */
export async function unblock(
  token: string | null,
  userId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/block/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** Phase 4: POST /api/social/report — write-only moderation intake. */
export async function report(
  token: string | null,
  body: { target_type: "ticket" | "user"; target_id: string; reason: string },
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/report`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** Phase 3: POST /api/social/tickets/:id/cheer. Returns authoritative count. */
export async function cheer(
  token: string | null,
  ticketId: string,
): Promise<SocialResult<{ count: number; cheeredByMe: true }>> {
  const r = await authedFetch(token, `/api/social/tickets/${encodeURIComponent(ticketId)}/cheer`, {
    method: "POST",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number };
  return { ok: true, data: { count: body.count ?? 0, cheeredByMe: true } };
}

/** Phase 3: DELETE /api/social/tickets/:id/cheer (toggle off). */
export async function uncheer(
  token: string | null,
  ticketId: string,
): Promise<SocialResult<{ count: number; cheeredByMe: false }>> {
  const r = await authedFetch(token, `/api/social/tickets/${encodeURIComponent(ticketId)}/cheer`, {
    method: "DELETE",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number };
  return { ok: true, data: { count: body.count ?? 0, cheeredByMe: false } };
}

/** Phase 3: public profile. token OPTIONAL — signed-out viewers can read. */
export async function getProfile(
  token: string | null,
  handle: string,
): Promise<SocialResult<PublicProfile>> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${base()}/api/social/users/${encodeURIComponent(handle)}`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, err: { kind: "http", status: res.status } };
    const body = (await readJson(res)) as PublicProfile;
    return { ok: true, data: body };
  } catch {
    return { ok: false, err: { kind: "network" } };
  }
}

/** Phase 3: GET /api/social/feed — caller's own + followees' tickets. */
export async function getFeed(
  token: string | null,
): Promise<SocialResult<{ tickets: CommittedTicket[] }>> {
  const r = await authedFetch(token, "/api/social/feed", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { tickets?: CommittedTicket[] } | null;
  const tickets = body?.tickets;
  if (!Array.isArray(tickets)) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, data: { tickets } };
}

/** Phase 3: GET /api/social/races/:raceKey/friends — count + cap-8 avatars. */
export async function getFriendsOnRace(
  token: string | null,
  raceKey: string,
): Promise<SocialResult<{ count: number; avatars: FriendsAvatar[] }>> {
  const r = await authedFetch(
    token,
    `/api/social/races/${encodeURIComponent(raceKey)}/friends`,
    { method: "GET" },
  );
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number; avatars?: FriendsAvatar[] } | null;
  return {
    ok: true,
    data: {
      count: body?.count ?? 0,
      avatars: Array.isArray(body?.avatars) ? body!.avatars : [],
    },
  };
}

/** Phase 3: GET /api/social/friends/on-card?race=k1&race=k2... — today's-card strip. */
export async function getFriendsOnCard(
  token: string | null,
  raceKeys: string[],
): Promise<SocialResult<{ count: number; avatars: FriendsAvatar[] }>> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  const qs = raceKeys.map((k) => `race=${encodeURIComponent(k)}`).join("&");
  const r = await authedFetch(token, `/api/social/friends/on-card${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number; avatars?: FriendsAvatar[] } | null;
  return {
    ok: true,
    data: {
      count: body?.count ?? 0,
      avatars: Array.isArray(body?.avatars) ? body!.avatars : [],
    },
  };
}

/**
 * GET /api/social/tickets — the caller's committed-ticket feed (newest first).
 * Resolves to null on any failure so the caller can fall back to the cache.
 */
export async function listTickets(
  token: string | null,
): Promise<
  | { ok: true; tickets: CommittedTicket[] }
  | { ok: false; err: SocialError }
> {
  const r = await authedFetch(token, "/api/social/tickets", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { tickets?: CommittedTicket[] } | null;
  const tickets = body?.tickets;
  if (!Array.isArray(tickets)) {
    return { ok: false, err: { kind: "http", status: 200 } };
  }
  return { ok: true, tickets };
}

/**
 * POST /api/social/tickets — commit a ticket (insert). On 409/id-collision
 * the Worker upserts; callers treat the returned ticket as canonical.
 */
export async function postTicket(
  token: string | null,
  body: CommittedTicket,
): Promise<
  | { ok: true; ticket: CommittedTicket }
  | { ok: false; err: SocialError }
> {
  const r = await authedFetch(token, "/api/social/tickets", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const ticket = (await readJson(r.res)) as CommittedTicket | null;
  if (!ticket) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, ticket };
}

/**
 * PATCH /api/social/tickets/:id — settle (state + returned).
 *
 * Phase 3: claps are no longer a PATCH field. Cheers are now server
 * COUNT(*) from the cheers table; the client toggles them via cheer()/uncheer().
 */
export async function patchTicket(
  token: string | null,
  id: string,
  patch: {
    state?: "won" | "miss" | "open" | "refunded";
    returned?: number | null;
    placings?: { pos: number; umabans: number[] }[];
  },
): Promise<
  | { ok: true; ticket: CommittedTicket }
  | { ok: false; err: SocialError }
> {
  const r = await authedFetch(token, `/api/social/tickets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const ticket = (await readJson(r.res)) as CommittedTicket | null;
  if (!ticket) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, ticket };
}
