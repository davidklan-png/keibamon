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
  /** Friend Interactions: the viewer's friend state with this profile
   * (self|friends|pending_outgoing|pending_incoming|none). Replaces the legacy
   * follower/followee/is_following fields removed with the follow system. */
  friendship?: string;
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

// ---------------------------------------------------------------------------
// Social UX Fixes (Phase B) — @handle rules + availability probe.
//
// One source of truth for the handle format so the client (HandleSetup) and the
// server (handleMe / handleHandleAvailable) can't drift. Rules: 3–20 chars,
// [a-z0-9_], case-insensitive unique, stored lowercase.
// ---------------------------------------------------------------------------
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
export const HANDLE_RE = /^[a-z0-9_]+$/;

/** Lowercase + trim — handles are stored lowercase. */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Validate a candidate. null = valid; otherwise the rule it violated. */
export function validateHandle(
  handle: string,
): null | "short" | "long" | "charset" {
  const h = normalizeHandle(handle);
  if (h.length < HANDLE_MIN) return "short";
  if (h.length > HANDLE_MAX) return "long";
  if (!HANDLE_RE.test(h)) return "charset";
  return null;
}

/**
 * Derive a suggested handle from a display name (preferred) or the local-part
 * of an email. Strips to [a-z0-9_] + lowercases. Returns a VALID handle, or
 * null if neither seed produces one (the field just starts empty). If the
 * name yields nothing usable (e.g. all-CJK), falls back to the email prefix.
 */
export function suggestHandle(displayName: string | null, email: string | null): string | null {
  const clean = (raw: string): string | null => {
    const c = raw.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, HANDLE_MAX);
    return c.length >= HANDLE_MIN ? c : null;
  };
  const name = (displayName && displayName.trim()) || "";
  const emailPrefix = email ? (email.split("@")[0] ?? "") : "";
  return clean(name) ?? clean(emailPrefix);
}

/** GET /api/social/handle-available?h= — debounced availability probe. */
export async function checkHandleAvailable(
  token: string | null,
  handle: string,
): Promise<SocialResult<{ available: boolean; reason?: string }>> {
  const r = await authedFetch(
    token,
    `/api/social/handle-available?h=${encodeURIComponent(handle)}`,
    { method: "GET" },
  );
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await r.res.json()) as { available?: boolean; reason?: string } | null;
  return { ok: true, data: { available: !!body?.available, reason: body?.reason } };
}

/** Phase 4: POST /api/social/block/:userId — idempotent; severs friend edges both ways. */
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

// Friend Interactions Phase 3: the legacy cheer client (cheer/uncheer) was
// removed with the cheer system — congratulate replaces it (see below).

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

// ---- Friend Interactions: friend graph -----------------------------------

/** A mutual friend (friend picker / friends list). */
export interface FriendSummary {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
}

/** GET /api/social/friends — accepted friends + pending in/out + badge count. */
export async function listFriends(
  token: string | null,
): Promise<
  SocialResult<{
    friends: FriendSummary[];
    pending_incoming: FriendSummary[];
    pending_outgoing: FriendSummary[];
    pending_count: number;
  }>
> {
  const r = await authedFetch(token, "/api/social/friends", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as {
    friends?: FriendSummary[];
    pending_incoming?: FriendSummary[];
    pending_outgoing?: FriendSummary[];
    pending_count?: number;
  } | null;
  return {
    ok: true,
    data: {
      friends: Array.isArray(body?.friends) ? body!.friends : [],
      pending_incoming: Array.isArray(body?.pending_incoming) ? body!.pending_incoming : [],
      pending_outgoing: Array.isArray(body?.pending_outgoing) ? body!.pending_outgoing : [],
      pending_count: body?.pending_count ?? 0,
    },
  };
}

/** Handle search (typeahead): GET /api/social/users/search?q=. */
export async function searchUsers(
  token: string | null,
  q: string,
): Promise<SocialResult<(FriendSummary & { friendship: string })[]>> {
  const r = await authedFetch(token, `/api/social/users/search?q=${encodeURIComponent(q)}`, {
    method: "GET",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { results?: (FriendSummary & { friendship: string })[] } | null;
  return { ok: true, data: Array.isArray(body?.results) ? body!.results : [] };
}

/** POST /api/social/friends/request/:id — send a friend request (idempotent). */
export async function requestFriend(
  token: string | null,
  targetId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/friends/request/${encodeURIComponent(targetId)}`, { method: "POST" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** DELETE /api/social/friends/request/:id — decline the request from :id (silent). */
export async function declineFriendRequest(
  token: string | null,
  fromId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/friends/request/${encodeURIComponent(fromId)}`, { method: "DELETE" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** POST /api/social/friends/request/:id/accept — accept a pending request. */
export async function acceptFriendRequest(
  token: string | null,
  fromId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/friends/request/${encodeURIComponent(fromId)}/accept`, { method: "POST" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/**
 * POST /api/social/friends/invite/:handle — Social UX Fixes (Phase C).
 * Pre-approved one-tap friend: the invite link is the inviter's consent, so a
 * single call forms the mutual friendship. `transition` is "created" (now
 * friends) or "already_friends"; a 404 covers both unknown handle and a block
 * (no-leak — indistinguishable).
 */
export async function acceptInvite(
  token: string | null,
  handle: string,
): Promise<SocialResult<{ transition: "created" | "already_friends"; now_friends: boolean }>> {
  const r = await authedFetch(token, `/api/social/friends/invite/${encodeURIComponent(handle)}`, { method: "POST" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await r.res.json()) as { transition?: "created" | "already_friends"; now_friends?: boolean };
  return { ok: true, data: { transition: body.transition ?? "created", now_friends: !!body.now_friends } };
}


/** DELETE /api/social/friends/:id — remove a friend (silent, mutual). */
export async function removeFriend(
  token: string | null,
  userId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/friends/${encodeURIComponent(userId)}`, { method: "DELETE" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

// ---- Friend Interactions: shared tickets ---------------------------------

export type AudienceMode = "all_friends" | "selected";

/** One item in the share-gated friend feed: an immutable ticket snapshot from a
 *  friend (or your own share — Item 4), plus owner + share metadata. is_win is
 *  false until Phase 3. `is_own` marks the viewer's own share (badged "You",
 *  read-only reaction counts, tap-through to My Tickets detail). */
export interface FeedItem {
  id: string;
  /** The shared ticket's id; drives own-item tap-through to My Tickets detail. */
  ticket_id: string;
  ticket: CommittedTicket | null;
  owner: { id: string; handle: string | null; display_name: string | null; avatar: string | null };
  audience_mode: AudienceMode;
  is_own: boolean;
  is_win: boolean;
  /** Win multiplier (returned/cost) — odds framing, NOT currency. Null unless a win. */
  multiplier: number | null;
  congrats_count: number;
  congratulated_by_me: boolean;
  comment_count: number;
  created_at: number;
}

/** GET /api/social/feed — friends' shared tickets (share-gated; clean cut). */
export async function getFeed(token: string | null): Promise<SocialResult<{ items: FeedItem[] }>> {
  const r = await authedFetch(token, "/api/social/feed", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { items?: FeedItem[] } | null;
  return { ok: true, data: { items: Array.isArray(body?.items) ? body!.items : [] } };
}

export interface ShareOutcome {
  id: string;
  audience_mode: AudienceMode;
  notified_count: number;
  created_at: number;
}

/** POST /api/social/shares — share a ticket (create-or-widen; saves if needed). */
export async function postShare(
  token: string | null,
  body: { ticket: CommittedTicket; mode: AudienceMode; selected?: string[] },
): Promise<SocialResult<ShareOutcome>> {
  const r = await authedFetch(token, "/api/social/shares", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const out = (await readJson(r.res)) as ShareOutcome | null;
  if (!out) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, data: out };
}

/** PATCH /api/social/shares/:id — widen the audience (owner-only). */
export async function patchShare(
  token: string | null,
  shareId: string,
  body: { mode: AudienceMode; selected?: string[] },
): Promise<SocialResult<ShareOutcome>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const out = (await readJson(r.res)) as ShareOutcome | null;
  if (!out) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, data: out };
}

/** POST /api/social/shares/:id/retract — silent removal (owner-only). */
export async function retractShare(
  token: string | null,
  shareId: string,
): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}/retract`, {
    method: "POST",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/**
 * DELETE /api/social/tickets/:id — Social UX Fixes. Soft-deletes the ticket
 * (server-side) and retracts its active share as a cascade so it vanishes from
 * friends' feeds. `retracted_share` reports whether the cascade fired (drives
 * the toast copy). 404 = unknown; 403 = not owner.
 */
export async function deleteTicket(
  token: string | null,
  ticketId: string,
): Promise<SocialResult<{ ok: true; retracted_share: boolean }>> {
  const r = await authedFetch(token, `/api/social/tickets/${encodeURIComponent(ticketId)}`, {
    method: "DELETE",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await r.res.json()) as { retracted_share?: boolean };
  return { ok: true, data: { ok: true, retracted_share: !!body.retracted_share } };
}

/** GET /api/social/shares/:id — share detail (audience-gated). */
export async function getShare(token: string | null, shareId: string): Promise<SocialResult<FeedItem>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}`, { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const item = (await readJson(r.res)) as FeedItem | null;
  if (!item) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, data: item };
}

/** The owner's active share for a ticket (drives share-later/retract on the
 *  My Tickets detail view). {shared:false} when the ticket isn't shared. */
export async function getMyShareForTicket(
  token: string | null,
  ticketId: string,
): Promise<SocialResult<{ shared: false } | { shared: true; id: string; audience_mode: AudienceMode }>> {
  const r = await authedFetch(token, `/api/social/tickets/${encodeURIComponent(ticketId)}/share`, { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { shared?: boolean; id?: string; audience_mode?: AudienceMode } | null;
  if (body?.shared && body.id && body.audience_mode) {
    return { ok: true, data: { shared: true, id: body.id, audience_mode: body.audience_mode } };
  }
  return { ok: true, data: { shared: false } };
}

// ---- Friend Interactions Phase 3 — comments + congratulate ---------------

export interface CommentView {
  id: string;
  share_id: string;
  author: { id: string; handle: string | null; display_name: string | null; avatar: string | null };
  body: string;
  created_at: number;
  deleted: boolean;
  mine: boolean;
}

/** GET /api/social/shares/:id/comments — the single-level thread (audience-only). */
export async function listComments(token: string | null, shareId: string): Promise<SocialResult<CommentView[]>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}/comments`, { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { comments?: CommentView[] } | null;
  return { ok: true, data: Array.isArray(body?.comments) ? body!.comments : [] };
}

/** POST /api/social/shares/:id/comments — body ≤500 chars (caller trims + validates). */
export async function addComment(
  token: string | null,
  shareId: string,
  body: string,
): Promise<SocialResult<CommentView>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const view = (await readJson(r.res)) as CommentView | null;
  if (!view) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, data: view };
}

/** DELETE /api/social/comments/:id — owner-of-share or author. */
export async function deleteComment(token: string | null, commentId: string): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, `/api/social/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
}

/** POST /api/social/shares/:id/congratulate — one per user per win; returns the count. */
export async function congratulate(
  token: string | null,
  shareId: string,
): Promise<SocialResult<{ count: number; congratulatedByMe: true }>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}/congratulate`, { method: "POST" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number } | null;
  return { ok: true, data: { count: body?.count ?? 0, congratulatedByMe: true } };
}

/** DELETE /api/social/shares/:id/congratulate — undo (idempotent). */
export async function unCongratulate(
  token: string | null,
  shareId: string,
): Promise<SocialResult<{ count: number; congratulatedByMe: false }>> {
  const r = await authedFetch(token, `/api/social/shares/${encodeURIComponent(shareId)}/congratulate`, { method: "DELETE" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number } | null;
  return { ok: true, data: { count: body?.count ?? 0, congratulatedByMe: false } };
}

// ---- Friend Interactions Phase 4 — notification bell ---------------------

export interface NotificationView {
  id: string;
  type: string;
  actor_id: string | null;
  actor_handle: string | null;
  actor_display_name: string | null;
  actor_avatar: string | null;
  subject_type: string; // 'user' | 'share' | 'ticket' | 'comment' | 'friend_request'
  subject_id: string;
  created_at: number;
  read_at: number | null;
}

/** GET /api/social/notifications — the bell list (newest-first, cap 50). */
export async function getNotifications(token: string | null): Promise<SocialResult<NotificationView[]>> {
  const r = await authedFetch(token, "/api/social/notifications", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { notifications?: NotificationView[] } | null;
  return { ok: true, data: Array.isArray(body?.notifications) ? body!.notifications : [] };
}

/** GET /api/social/notifications/unread-count — the bell badge. */
export async function getUnreadCount(token: string | null): Promise<SocialResult<{ count: number }>> {
  const r = await authedFetch(token, "/api/social/notifications/unread-count", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { count?: number } | null;
  return { ok: true, data: { count: body?.count ?? 0 } };
}

/** POST /api/social/notifications/read — mark one ({id}) or all read. */
export async function markNotificationsRead(token: string | null, id?: string): Promise<SocialResult<{ ok: true }>> {
  const r = await authedFetch(token, "/api/social/notifications/read", {
    method: "POST",
    body: id ? JSON.stringify({ id }) : "{}",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  return { ok: true, data: { ok: true } };
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

/** Phase 3: GET /api/social/friends/on-card?race=k1&race=k2... — today's-card strip.
 *  Stage 5: the batch endpoint also returns a per-race breakdown, so the
 *  MyTickets snapshot refresh needs ONE request (not 1 + up-to-12). */
export async function getFriendsOnCard(
  token: string | null,
  raceKeys: string[],
): Promise<
  SocialResult<{
    count: number;
    avatars: FriendsAvatar[];
    perRace: Record<string, { count: number; avatars: FriendsAvatar[] }>;
  }>
> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  const qs = raceKeys.map((k) => `race=${encodeURIComponent(k)}`).join("&");
  const r = await authedFetch(token, `/api/social/friends/on-card${qs ? `?${qs}` : ""}`, {
    method: "GET",
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as {
    count?: number;
    avatars?: FriendsAvatar[];
    perRace?: Record<string, { count?: number; avatars?: FriendsAvatar[] }>;
  } | null;
  const perRace: Record<string, { count: number; avatars: FriendsAvatar[] }> = {};
  if (body?.perRace) {
    for (const [rk, v] of Object.entries(body.perRace)) {
      perRace[rk] = { count: v?.count ?? 0, avatars: Array.isArray(v?.avatars) ? v!.avatars : [] };
    }
  }
  return {
    ok: true,
    data: {
      count: body?.count ?? 0,
      avatars: Array.isArray(body?.avatars) ? body!.avatars : [],
      perRace,
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
 * Friend Interactions Phase 3: the legacy claps/cheers PATCH fields are gone
 * (cheer was removed; congratulate is share-scoped, toggled via congratulate()).
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
