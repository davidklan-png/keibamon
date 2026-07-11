// Router + HTTP handlers for every /api/social/* route. Split out of
// index.ts 2026-07-08 (mechanical, no behavior change). Handlers own
// method/auth/validation/rate-limit decisions; the data layers live in
// auth.ts / tickets.ts / social.ts / impressions.ts.

import { ensureCaller, upsertUser, verifyToken } from "./auth";
import { Env, RATE_WINDOW, json } from "./core";
import {
  listImpressions,
  parseImpressionsBody,
  replaceImpressions,
} from "./impressions";
import {
  addReport,
  blockExistsEitherDirection,
  blockUser,
  buildProfile,
  friendsOnCard,
  friendsOnRace,
  rateLimitCheck,
  unblockUser,
  userByHandle,
  userById,
} from "./social";
import {
  acceptRequest,
  declineRequest,
  friendshipState,
  listFriends,
  listPendingIncoming,
  listPendingOutgoing,
  removeFriend,
  requestFriend,
  searchUsers,
  severEdgesBothDirections,
} from "./friends";
import { insertNotification, listNotifications, markAllRead, markRead, unreadCount } from "./notifications";
import {
  activeShareForTicket,
  buildShareFeed,
  congratsCount,
  congratulate,
  createShare,
  getShare,
  getShareForViewer,
  parseAudience,
  promoteShareWin,
  retractShare,
  shareVisibleTo,
  unCongratulate,
  widenShare,
} from "./shares";
import { addComment, deleteComment, getComment, listComments, priorCommenters } from "./comments";
import {
  PatchBody,
  decodeTicket,
  findTicket,
  insertTicket,
  listTickets,
  parseTicketBody,
  patchTicket,
} from "./tickets";

const TICKET_PATH = /^\/api\/social\/tickets(\/([^/]+))?$/;
const TICKET_SHARE_PATH = /^\/api\/social\/tickets\/([^/]+)\/share$/;
const BLOCK_PATH = /^\/api\/social\/block\/([^/]+)$/;
const PROFILE_PATH = /^\/api\/social\/users\/([^/]+)$/;
const RACE_FRIENDS_PATH = /^\/api\/social\/races\/([^/]+)\/friends$/;
const FEED_PATH = "/api/social/feed";
// Friend Interactions Phase 4 — notification bell (read side).
const NOTIFICATIONS_PATH = "/api/social/notifications";
const NOTIFICATIONS_READ_PATH = "/api/social/notifications/read";
const NOTIFICATIONS_UNREAD_PATH = "/api/social/notifications/unread-count";
const FRIENDS_ON_CARD_PATH = "/api/social/friends/on-card";
const REPORT_PATH = "/api/social/report";
// Friend Interactions Phase 1 — friend graph + handle search. ORDER MATTERS in
// the router: the more-specific accept path and the bare list path must be
// tried before the parameterized /friends/:id and /users/:handle patterns.
const FRIEND_REQUEST_ACCEPT_PATH = /^\/api\/social\/friends\/request\/([^/]+)\/accept$/;
const FRIEND_REQUEST_PATH = /^\/api\/social\/friends\/request\/([^/]+)$/;
const FRIENDS_LIST_PATH = "/api/social/friends";
const FRIEND_PATH = /^\/api\/social\/friends\/([^/]+)$/;
const USER_SEARCH_PATH = "/api/social/users/search";
// Social UX Fixes (Phase B) — handle-availability probe for the onboarding
// typeahead. Exact path (must precede the parameterized /users/:handle).
const HANDLE_AVAILABLE_PATH = "/api/social/handle-available";
// Friend Interactions Phase 2 — shared tickets. retract before /:id; the bare
// /shares path only matches POST (create-or-widen).
const SHARES_PATH = "/api/social/shares";
const SHARE_RETRACT_PATH = /^\/api\/social\/shares\/([^/]+)\/retract$/;
const SHARE_COMMENTS_PATH = /^\/api\/social\/shares\/([^/]+)\/comments$/;
const SHARE_CONGRATS_PATH = /^\/api\/social\/shares\/([^/]+)\/congratulate$/;
const SHARE_PATH = /^\/api\/social\/shares\/([^/]+)$/;
const COMMENT_PATH = /^\/api\/social\/comments\/([^/]+)$/;
// ADR-0018: account-backed impression marks. GET = the caller's full map;
// PUT = transactional full-replace. Lives under /me/ because impressions are
// strictly per-user and never public.
const IMPRESSIONS_PATH = "/api/social/me/impressions";

export async function router(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // /api/social/me — Phase 1 identity (+ Phase 3 handle/dn/avatar patch).
  if (pathname === "/api/social/me") {
    return handleMe(request, env, cors);
  }

  // /api/social/me/impressions — ADR-0018 account-backed marks (GET full map,
  // PUT transactional full-replace). Auth required.
  if (pathname === IMPRESSIONS_PATH) {
    return handleImpressions(request, env, cors);
  }

  // /api/social/friends/request/:id/accept — Friend Interactions: accept a
  // friend request. (Tried before /friends/request/:id and /friends/:id.)
  const friendAcceptMatch = FRIEND_REQUEST_ACCEPT_PATH.exec(pathname);
  if (friendAcceptMatch) {
    return handleFriendAccept(request, env, cors, decodeURIComponent(friendAcceptMatch[1]));
  }
  // /api/social/friends/request/:id — POST = send request, DELETE = decline.
  const friendReqMatch = FRIEND_REQUEST_PATH.exec(pathname);
  if (friendReqMatch) {
    return handleFriendRequest(request, env, cors, decodeURIComponent(friendReqMatch[1]));
  }
  // /api/social/friends — GET = friends list + pending in/out (badged count).
  if (pathname === FRIENDS_LIST_PATH) {
    return handleFriendsList(request, env, cors);
  }
  // /api/social/friends/on-card — Phase 3 today's-card strip. MUST precede the
  // parameterized /friends/:id below or "on-card" would be captured as an id.
  if (pathname === FRIENDS_ON_CARD_PATH) {
    return handleFriendsOnCard(request, env, cors, url);
  }
  // /api/social/friends/:id — DELETE = remove friend (silent, mutual).
  const friendMatch = FRIEND_PATH.exec(pathname);
  if (friendMatch) {
    return handleFriendRemove(request, env, cors, decodeURIComponent(friendMatch[1]));
  }

  // /api/social/shares — POST = share a ticket (create-or-widen; idempotent).
  if (pathname === SHARES_PATH && request.method === "POST") {
    return handleShare(request, env, cors);
  }
  // /api/social/shares/:id/retract — POST = retract (silent). Before /:id.
  const shareRetractMatch = SHARE_RETRACT_PATH.exec(pathname);
  if (shareRetractMatch) {
    return handleShareRetract(request, env, cors, decodeURIComponent(shareRetractMatch[1]));
  }
  // /api/social/shares/:id/comments — GET list (audience) / POST add (audience).
  const shareCommentsMatch = SHARE_COMMENTS_PATH.exec(pathname);
  if (shareCommentsMatch) {
    return handleShareComments(request, env, cors, decodeURIComponent(shareCommentsMatch[1]));
  }
  // /api/social/shares/:id/congratulate — POST = congratulate / DELETE = undo.
  const shareCongratsMatch = SHARE_CONGRATS_PATH.exec(pathname);
  if (shareCongratsMatch) {
    return handleShareCongrats(request, env, cors, decodeURIComponent(shareCongratsMatch[1]));
  }
  // /api/social/shares/:id — PATCH = widen audience, GET = detail.
  const shareMatch = SHARE_PATH.exec(pathname);
  if (shareMatch) {
    return handleShareMod(request, env, cors, decodeURIComponent(shareMatch[1]));
  }
  // /api/social/comments/:id — DELETE = owner-or-author delete.
  const commentMatch = COMMENT_PATH.exec(pathname);
  if (commentMatch) {
    return handleCommentDelete(request, env, cors, decodeURIComponent(commentMatch[1]));
  }

  // /api/social/block/:userId — Phase 4 block graph (POST = block, DELETE = unblock).
  const blockMatch = BLOCK_PATH.exec(pathname);
  if (blockMatch) {
    return handleBlock(request, env, cors, decodeURIComponent(blockMatch[1]));
  }

  // /api/social/report — Phase 4 moderation intake.
  if (pathname === REPORT_PATH) {
    return handleReport(request, env, cors);
  }

  // /api/social/tickets/:id/share — Friend Interactions: owner's active share
  // (drives the My Tickets detail share-later/retract affordance).
  const ticketShareMatch = TICKET_SHARE_PATH.exec(pathname);
  if (ticketShareMatch) {
    return handleTicketShare(request, env, cors, decodeURIComponent(ticketShareMatch[1]));
  }

  // /api/social/tickets and /api/social/tickets/:id — Phase 2 persistence.
  // (/tickets/:id/cheer was removed with the cheer system; /tickets/:id/share is
  // matched above, so the bare /:id here is unambiguous.)
  const ticketMatch = TICKET_PATH.exec(pathname);
  if (ticketMatch) {
    return handleTickets(request, env, cors, ticketMatch[2] ?? null);
  }

  // /api/social/feed — Phase 3 feed.
  if (pathname === FEED_PATH) {
    return handleFeed(request, env, cors);
  }

  // Friend Interactions Phase 4 — notification bell (read side).
  if (pathname === NOTIFICATIONS_PATH && request.method === "GET") {
    return handleNotifications(request, env, cors);
  }
  if (pathname === NOTIFICATIONS_UNREAD_PATH && request.method === "GET") {
    return handleNotificationsUnread(request, env, cors);
  }
  if (pathname === NOTIFICATIONS_READ_PATH && request.method === "POST") {
    return handleNotificationsRead(request, env, cors);
  }

  // /api/social/races/:raceKey/friends — Phase 3 friends-on-race.
  const raceFriendsMatch = RACE_FRIENDS_PATH.exec(pathname);
  if (raceFriendsMatch) {
    return handleRaceFriends(request, env, cors, decodeURIComponent(raceFriendsMatch[1]));
  }

  // /api/social/users/search — Friend Interactions: handle search. MUST precede
  // /users/:handle or "search" would be captured as a handle.
  if (pathname === USER_SEARCH_PATH) {
    return handleUserSearch(request, env, cors, url);
  }

  // /api/social/handle-available — Phase B onboarding availability probe.
  // Exact path; registered here before /users/:handle for safety.
  if (pathname === HANDLE_AVAILABLE_PATH && request.method === "GET") {
    return handleHandleAvailable(request, env, cors, url);
  }

  // /api/social/users/:handle — Phase 3 public profile.
  const profileMatch = PROFILE_PATH.exec(pathname);
  if (profileMatch) {
    return handleProfile(request, env, cors, decodeURIComponent(profileMatch[1]));
  }

  // Only the route prefixes above are served here. /api/live stays on
  // the racing Worker; everything else is 404 (no collision with racing origin).
  return json({ error: "not_found" }, 404, cors);
}

async function handleMe(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) {
    return json({ error: "unauthorized" }, 401, cors);
  }
  const patch: {
    age_verified?: number | null;
    handle?: string | null;
    display_name?: string | null;
    avatar?: string | null;
  } = {};
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as {
        age_verified?: unknown;
        handle?: unknown;
        display_name?: unknown;
        avatar?: unknown;
      };
      if (typeof body.age_verified === "number") patch.age_verified = body.age_verified;
      // Phase 3 / Social UX Fixes (Phase B): handle rules are 3–20 chars,
      // [a-z0-9_], case-insensitive unique, STORED LOWERCASE. Lowercase the
      // input first (so "Bob" becomes "bob"), then validate length + charset.
      // null clears the handle; an empty/under-length/over-length/invalid
      // string is rejected. The DB enforces CI uniqueness via
      // idx_users_handle_ci_unique (migration 0010); this is the format gate.
      if (typeof body.handle === "string") {
        const h = body.handle.trim().toLowerCase();
        if (h.length < 3 || h.length > 20) {
          return json({ error: "bad_handle" }, 400, cors);
        }
        if (!/^[a-z0-9_]+$/.test(h)) {
          return json({ error: "bad_handle" }, 400, cors);
        }
        patch.handle = h;
      } else if (body.handle === null) {
        patch.handle = null;
      }
      if (typeof body.display_name === "string") {
        const d = body.display_name.trim();
        if (d.length > 64) return json({ error: "bad_display_name" }, 400, cors);
        patch.display_name = d;
      } else if (body.display_name === null) {
        patch.display_name = null;
      }
      if (typeof body.avatar === "string") {
        if (body.avatar.length > 2048) return json({ error: "bad_avatar" }, 400, cors);
        patch.avatar = body.avatar;
      } else if (body.avatar === null) {
        patch.avatar = null;
      }
    } catch {
      // Empty / non-JSON body is fine — treat as upsert-only.
    }
  }
  const result = await upsertUser(env.DB, verified.sub, patch);
  if (!result.ok) {
    if (result.code === "handle_taken") {
      return json({ error: "handle_taken" }, 409, cors);
    }
    return json({ error: "server_error" }, 500, cors);
  }
  return json(result.row, 200, cors);
}

async function handleImpressions(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const caller = await ensureCaller(env, cors, verified.sub);
  if ("res" in caller) return caller.res;
  const userId = caller.user.id;

  if (request.method === "GET") {
    const rows = await listImpressions(env.DB, userId);
    return json({ impressions: rows }, 200, cors);
  }

  // PUT
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_body" }, 400, cors);
  }
  const parsed = parseImpressionsBody(body, userId, Date.now());
  if (!parsed.ok) return json({ error: parsed.code }, 400, cors);
  await replaceImpressions(env.DB, userId, parsed.items);
  return json({ ok: true }, 200, cors);
}

async function handleTickets(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  id: string | null,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  // Ensure the caller has a user row (Phase 1 upsert on first touch). Cheap
  // and keeps the FK valid even if the client skipped POST /api/social/me.
  const caller = await ensureCaller(env, cors, verified.sub);
  if ("res" in caller) return caller.res;
  const userId = caller.user.id;

  if (id === null) {
    // /api/social/tickets
    if (request.method === "GET") {
      const rows = await listTickets(env.DB, userId);
      return json({ tickets: rows }, 200, cors);
    }
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_body" }, 400, cors);
      }
      // Rate-limit ticket POSTs (Decision 8).
      const allowed = await rateLimitCheck(env.DB, userId, "ticket");
      if (!allowed) {
        return json(
          { error: "rate_limited" },
          429,
          cors,
          { "Retry-After": String(RATE_WINDOW) },
        );
      }
      const parsed = parseTicketBody(body);
      if (!parsed.ok) {
        return json({ error: parsed.code }, 400, cors);
      }
      const result = await insertTicket(env.DB, userId, parsed.ticket);
      if (!result.ok) {
        // Cross-user id collision → 404, shaped exactly like "doesn't exist"
        // so the endpoint can't be probed to learn which ids are taken
        // (anti-oracle). Settled-ticket edit guard → 409. The conditional
        // upsert's unreachable no-row case → 500.
        if (result.code === "not_found") {
          return json({ error: "not_found" }, 404, cors);
        }
        if (result.code === "server_error") {
          return json({ error: "server_error" }, 500, cors);
        }
        return json({ error: result.code }, 409, cors);
      }
      const decoded = decodeTicket(result.row);
      return json(decoded ?? { ok: true }, 200, cors);
    }
    return json({ error: "method_not_allowed" }, 405, cors);
  }

  // /api/social/tickets/:id
  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_body" }, 400, cors);
    }
    const patch: PatchBody =
      body && typeof body === "object" ? (body as PatchBody) : {};
    const result = await patchTicket(env.DB, id, userId, patch);
    if (result.status === 200) {
      // Friend Interactions Phase 3: a settle reaching the client fast-path
      // promotes an active share. The sweep also promotes, but it idempotent-
      // skips an already-settled row — so without this call, a client-settled
      // shared win would never flip is_win / notify the audience. Fire-and-
      // forget: a notify failure must not fail the settle response.
      await promoteShareWin(env.DB, id, (result.row as { state?: string }).state === "won").catch(() => {});
      return json(result.row, 200, cors);
    }
    const status = result.status;
    return json(
      { error: status === 404 ? "not_found" : "forbidden" },
      status,
      cors,
    );
  }
  return json({ error: "method_not_allowed" }, 405, cors);
}

/**
 * Phase 4 — /api/social/block/:userId.
 *   POST   = block (idempotent; severs follows both ways)
 *   DELETE = unblock (idempotent)
 *
 * Self-block is forbidden (CHECK constraint is the backstop). A 404 for a
 * missing target user is reported as `not_found` (block existence is private;
 * we don't leak it via a different status).
 */
async function handleBlock(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  targetId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  if (targetId === caller.id) {
    return json({ error: "cannot_block_self" }, 403, cors);
  }
  // 404 if the target user doesn't exist (don't leak existence via 200).
  const target = await userById(env.DB, targetId);
  if (!target) return json({ error: "not_found" }, 404, cors);

  // Rate-limit (Phase 4: block gets 30/min — generous, but capped so a
  // compromised token can't DOS the blocks table).
  const allowed = await rateLimitCheck(env.DB, caller.id, "block");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }

  if (request.method === "POST") {
    await blockUser(env.DB, caller.id, targetId);
    // Friend Interactions: a block also removes any friendship / pending
    // request between the pair (severEdgesBothDirections). Done at the route
    // layer (not inside social.ts blockUser) to keep the friends→social import
    // one-way and acyclic.
    await severEdgesBothDirections(env.DB, caller.id, targetId);
  } else {
    await unblockUser(env.DB, caller.id, targetId);
  }
  return json({ ok: true }, 200, cors);
}

/**
 * Phase 4 — POST /api/social/report.
 * Body: { target_type: "ticket" | "user", target_id: string, reason: string }
 *
 * Write-only: rows land in `reports` for later moderation review. No UI for
 * review ships in Phase 4 (backlog item). Reason is capped at 500 chars to
 * keep the table cheap; reporters who need more room can file a ticket.
 */
async function handleReport(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  let body: { target_type?: unknown; target_id?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_body" }, 400, cors);
  }

  if (body.target_type !== "ticket" && body.target_type !== "user") {
    return json({ error: "bad_target_type" }, 400, cors);
  }
  if (typeof body.target_id !== "string" || !body.target_id) {
    return json({ error: "bad_target_id" }, 400, cors);
  }
  if (typeof body.reason !== "string") {
    return json({ error: "bad_reason" }, 400, cors);
  }
  const reason = body.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    return json({ error: "bad_reason" }, 400, cors);
  }

  const allowed = await rateLimitCheck(env.DB, caller.id, "report");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }

  const ok = await addReport(
    env.DB,
    caller.id,
    body.target_type,
    body.target_id,
    reason,
  );
  if (!ok) return json({ error: "server_error" }, 500, cors);
  return json({ ok: true }, 200, cors);
}

async function handleFeed(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  // Friend Interactions Phase 2 — CLEAN CUT: the feed is now share-gated. Only
  // friends' explicitly-shared tickets appear (buildShareFeed). The legacy
  // auto-feed (own + followees' committed tickets) is gone and NOT migrated.
  const items = await buildShareFeed(env.DB, caller.id);
  return json({ items }, 200, cors);
}

async function handleProfile(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  handle: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  // JWT OPTIONAL — a signed-out viewer can read a public profile.
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  let viewerId: string | null = null;
  if (verified) {
    const v = await ensureCaller(env, cors, verified.sub);
    if ("res" in v) return v.res;
    viewerId = v.user.id;
  }

  const profileUser = await userByHandle(env.DB, handle);
  if (!profileUser || !profileUser.handle) {
    return json({ error: "not_found" }, 404, cors);
  }
  const profile = await buildProfile(env.DB, profileUser, viewerId);
  // Friend Interactions: surface the viewer's friendship state so the profile's
  // Add-friend / Accept / Pending button renders the right affordance. A
  // logged-out viewer sees "none".
  (profile as Record<string, unknown>).friendship = viewerId
    ? await friendshipState(env.DB, viewerId, profileUser.id)
    : "none";
  return json(profile, 200, cors);
}

async function handleRaceFriends(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  raceKeyRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  // raceKey arrives URL-encoded; the regex already captured the raw segment,
  // and decodeURIComponent was applied by the router. Pipe chars are part of
  // the key ("date|venue|Rn|name") — they're fine.
  void raceKeyRaw;
  return json(await friendsOnRace(env.DB, caller.id, raceKeyRaw), 200, cors);
}

async function handleFriendsOnCard(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  // The client supplies the current snapshot's raceKeys via ?race= query
  // params (?race=k1&race=k2...). Empty list = empty result.
  const raceKeys = url.searchParams.getAll("race").filter(Boolean);
  return json(await friendsOnCard(env.DB, caller.id, raceKeys), 200, cors);
}

// ---------------------------------------------------------------------------
// Friend Interactions Phase 1 — friend graph handlers.
// ---------------------------------------------------------------------------

/**
 * /api/social/friends/request/:id
 *   POST   = send a friend request (idempotent; auto-accepts on mutual)
 *   DELETE = decline the request FROM :id (silent to the sender)
 *
 * Age-gated. The notification this transition implies is fanned out here (not
 * in friends.ts) so the state machine stays notification-agnostic + unit-testable.
 */
async function handleFriendRequest(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  targetId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  if (targetId === caller.id) return json({ error: "cannot_friend_self" }, 403, cors);
  // 404 (not "leaky 200") when the target doesn't exist.
  const target = await userById(env.DB, targetId);
  if (!target) return json({ error: "not_found" }, 404, cors);

  if (request.method === "POST") {
    const allowed = await rateLimitCheck(env.DB, caller.id, "friend_request");
    if (!allowed) {
      return json({ error: "rate_limited" }, 429, cors, { "Retry-After": String(RATE_WINDOW) });
    }
    const result = await requestFriend(env.DB, caller.id, targetId);
    if (!result.ok) {
      // blocked (cannot_friend_self already short-circuited above)
      return json({ error: result.code }, 403, cors);
    }
    // Fan out the notification the transition implies. created_pending always
    // notifies: it only fires when no prior edge existed, so a duplicate-while-
    // pending (which returns already_pending, no notify) can't reach here, and a
    // re-request after a decline/remove is a genuinely new request that deserves
    // a fresh bell entry. (The friend_request rate limit bounds abuse.)
    if (result.notify) {
      const { type, recipientId } = result.notify;
      await insertNotification(env.DB, {
        userId: recipientId,
        type,
        actorId: caller.id,
        subjectType: "user",
        subjectId: caller.id,
      });
    }
    return json(
      { ok: true, transition: result.transition, now_friends: result.transition === "auto_accepted" },
      200,
      cors,
    );
  }

  // DELETE = decline (silent, idempotent).
  await declineRequest(env.DB, caller.id, targetId);
  return json({ ok: true }, 200, cors);
}

/** /api/social/friends/request/:id/accept — accept a pending request. Age-gated. */
async function handleFriendAccept(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  requesterId: string,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  if (requesterId === caller.id) return json({ error: "cannot_friend_self" }, 403, cors);
  const requester = await userById(env.DB, requesterId);
  if (!requester) return json({ error: "not_found" }, 404, cors);

  const result = await acceptRequest(env.DB, caller.id, requesterId);
  if (!result.ok) {
    if (result.code === "no_pending_request") return json({ error: "not_found" }, 404, cors);
    return json({ error: result.code }, 403, cors); // blocked
  }
  if (result.notify) {
    await insertNotification(env.DB, {
      userId: result.notify.recipientId,
      type: result.notify.type,
      actorId: caller.id,
      subjectType: "user",
      subjectId: caller.id,
    });
  }
  return json({ ok: true, transition: result.transition, now_friends: result.transition === "accepted" }, 200, cors);
}

/** /api/social/friends — GET friends + pending in/out (+ pending_count badge). */
async function handleFriendsList(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  const [friends, pendingIncoming, pendingOutgoing] = await Promise.all([
    listFriends(env.DB, caller.id),
    listPendingIncoming(env.DB, caller.id),
    listPendingOutgoing(env.DB, caller.id),
  ]);
  return json(
    {
      friends,
      pending_incoming: pendingIncoming,
      pending_outgoing: pendingOutgoing,
      pending_count: pendingIncoming.length,
    },
    200,
    cors,
  );
}

/** /api/social/friends/:id — DELETE = remove friend (silent, mutual, idempotent). */
async function handleFriendRemove(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  userId: string,
): Promise<Response> {
  if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  if (userId === caller.id) return json({ error: "cannot_remove_self" }, 403, cors);
  await removeFriend(env.DB, caller.id, userId);
  return json({ ok: true }, 200, cors);
}

/** /api/social/users/search?q= — exact/prefix handle search (typeahead). */
async function handleUserSearch(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  const results = await searchUsers(env.DB, url.searchParams.get("q") ?? "", caller.id);
  return json({ results }, 200, cors);
}

/**
 * GET /api/social/handle-available?h=<candidate> — Social UX Fixes (Phase B).
 * Debounced availability probe for the handle-onboarding typeahead. Auth
 * required (the user is signed in during onboarding). Applies the SAME rules
 * as handleMe (lowercase, 3–20, [a-z0-9_]) and reports whether the candidate
 * is free. The caller's OWN handle (if any) counts as available so a rename
 * to the current handle doesn't read as taken. Never 400s on a bad format —
 * returns {available:false, reason:"invalid"} so the client can tell "invalid
 * format" apart from "taken".
 */
async function handleHandleAvailable(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const h = (url.searchParams.get("h") ?? "").trim().toLowerCase();
  if (h.length < 3 || h.length > 20 || !/^[a-z0-9_]+$/.test(h)) {
    return json({ available: false, reason: "invalid" }, 200, cors);
  }
  const existing = await userByHandle(env.DB, h);
  const available = !existing || existing.clerk_user_id === verified.sub;
  return json({ available }, 200, cors);
}

// ---------------------------------------------------------------------------
// Friend Interactions Phase 2 — shared tickets.
// ---------------------------------------------------------------------------

/**
 * POST /api/social/shares — share a ticket (create-or-widen; idempotent with
 * save). Body: { ticket: CommittedTicket, mode, selected? }. Saves the ticket
 * if not already saved, then publishes it to the chosen friend audience, creates
 * the feed entry, and notifies each recipient in-app. Re-sharing widens.
 */
async function handleShare(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_body" }, 400, cors);
  }
  const audience = parseAudience(body);
  if (!audience) return json({ error: "bad_audience" }, 400, cors);
  const parsed = parseTicketBody((body as { ticket?: unknown }).ticket);
  if (!parsed.ok) return json({ error: parsed.code }, 400, cors);

  const allowed = await rateLimitCheck(env.DB, caller.id, "share");
  if (!allowed) {
    return json({ error: "rate_limited" }, 429, cors, { "Retry-After": String(RATE_WINDOW) });
  }

  // (a) save the ticket if not already saved (idempotent edit-in-place when open).
  const save = await insertTicket(env.DB, caller.id, parsed.ticket);
  if (!save.ok) {
    if (save.code === "not_found") return json({ error: "not_found" }, 404, cors);
    if (save.code === "server_error") return json({ error: "server_error" }, 500, cors);
    return json({ error: save.code }, 409, cors);
  }
  // (b)(c)(d) publish with an immutable snapshot + feed entry + notify audience.
  // createShare widens (notifies only NEW recipients) if an active share exists.
  const result = await createShare(
    env.DB,
    caller.id,
    parsed.ticket.id,
    parsed.ticket.payload,
    audience.mode,
    audience.selected,
  );
  return json(
    {
      id: result.share.id,
      audience_mode: result.share.audience_mode,
      notified_count: result.notified.length,
      created_at: result.share.created_at,
    },
    200,
    cors,
  );
}

/**
 * /api/social/shares/:id — PATCH = widen audience (owner-only); GET = detail
 * (audience-gated; non-audience viewers get 404, never a leak).
 */
async function handleShareMod(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  shareId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  if (request.method === "GET") {
    const share = await getShare(env.DB, shareId);
    if (!share || share.retracted_at !== null || !(await shareVisibleTo(env.DB, share, caller.id))) {
      return json({ error: "not_found" }, 404, cors);
    }
    const item = await getShareForViewer(env.DB, shareId, caller.id);
    return json(item ?? { error: "not_found" }, item ? 200 : 404, cors);
  }

  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_body" }, 400, cors);
    }
    const audience = parseAudience(body);
    if (!audience) return json({ error: "bad_audience" }, 400, cors);
    const share = await getShare(env.DB, shareId);
    // 404 (not 403) for missing / retracted / non-owner so the endpoint can't be
    // probed for which share ids exist.
    if (!share || share.retracted_at !== null || share.owner_id !== caller.id) {
      return json({ error: "not_found" }, 404, cors);
    }
    const result = await widenShare(env.DB, share, audience.mode, audience.selected);
    return json(
      { id: result.share.id, audience_mode: result.share.audience_mode, notified_count: result.notified.length },
      200,
      cors,
    );
  }
  return json({ error: "method_not_allowed" }, 405, cors);
}

/** POST /api/social/shares/:id/retract — owner-only, silent. Idempotent. */
async function handleShareRetract(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  shareId: string,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;
  const share = await getShare(env.DB, shareId);
  if (!share || share.owner_id !== caller.id) return json({ error: "not_found" }, 404, cors);
  await retractShare(env.DB, shareId, caller.id);
  return json({ ok: true }, 200, cors);
}

/**
 * GET /api/social/tickets/:id/share — the owner's ACTIVE share for a ticket
 * ({shared:true,id,audience_mode} | {shared:false}). Owner-only: a non-owner
 * gets 404 (anti-oracle) so the endpoint can't probe others' share state. Drives
 * the My Tickets detail share-later/retract affordance.
 */
async function handleTicketShare(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  ticketId: string,
): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;
  const ticket = await findTicket(env.DB, ticketId);
  if (!ticket || ticket.user_id !== caller.id) return json({ error: "not_found" }, 404, cors);
  const share = await activeShareForTicket(env.DB, ticketId, caller.id);
  if (!share) return json({ shared: false }, 200, cors);
  return json({ shared: true, id: share.id, audience_mode: share.audience_mode }, 200, cors);
}

// ---------------------------------------------------------------------------
// Friend Interactions Phase 3 — comments + congratulate.
// ---------------------------------------------------------------------------

/**
 * /api/social/shares/:id/comments — GET = list (audience), POST = add (audience).
 * Commenting notifies the share owner (comment_on_your_ticket) + prior
 * commenters (comment_on_ticket_you_commented), excluding the author.
 */
async function handleShareComments(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  shareId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;
  const share = await getShare(env.DB, shareId);
  if (!share || share.retracted_at !== null || !(await shareVisibleTo(env.DB, share, caller.id))) {
    return json({ error: "not_found" }, 404, cors);
  }

  if (request.method === "GET") {
    const comments = await listComments(env.DB, shareId, caller.id);
    return json({ comments }, 200, cors);
  }
  if (request.method === "POST") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_body" }, 400, cors);
    }
    const text = (body as { body?: unknown } | null)?.body;
    if (typeof text !== "string") return json({ error: "bad_body" }, 400, cors);
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 500) return json({ error: "bad_body" }, 400, cors);

    const allowed = await rateLimitCheck(env.DB, caller.id, "comment");
    if (!allowed) {
      return json({ error: "rate_limited" }, 429, cors, { "Retry-After": String(RATE_WINDOW) });
    }
    const comment = await addComment(env.DB, shareId, caller.id, trimmed);
    if (!comment) return json({ error: "server_error" }, 500, cors);

    // Notify owner (if not self) + prior commenters (excluding self + owner, who
    // is notified above). Fire-and-forget intent; insertNotification swallows.
    if (share.owner_id !== caller.id) {
      await insertNotification(env.DB, {
        userId: share.owner_id, type: "comment_on_your_ticket", actorId: caller.id,
        subjectType: "share", subjectId: shareId,
      });
    }
    const others = await priorCommenters(env.DB, shareId, caller.id);
    for (const uid of others) {
      if (uid === share.owner_id) continue;
      await insertNotification(env.DB, {
        userId: uid, type: "comment_on_ticket_you_commented", actorId: caller.id,
        subjectType: "share", subjectId: shareId,
      });
    }
    const view = (await listComments(env.DB, shareId, caller.id)).find((c) => c.id === comment.id);
    return json(view ?? { id: comment.id }, 200, cors);
  }
  return json({ error: "method_not_allowed" }, 405, cors);
}

/** DELETE /api/social/comments/:id — share-owner deletes any; author deletes own. */
async function handleCommentDelete(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  commentId: string,
): Promise<Response> {
  if (request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405, cors);
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;
  const comment = await getComment(env.DB, commentId);
  if (!comment) return json({ error: "not_found" }, 404, cors);
  const share = await getShare(env.DB, comment.share_id);
  if (!share) return json({ error: "not_found" }, 404, cors);
  const ok = await deleteComment(env.DB, commentId, caller.id, share.owner_id);
  return json(ok ? { ok: true } : { error: "forbidden" }, ok ? 200 : 403, cors);
}

/**
 * /api/social/shares/:id/congratulate — POST = congratulate / DELETE = undo.
 * Win-only (congratulate is a win celebration, not pre-result hype); one per
 * user per win (PK); self-congrats forbidden; audience-members only.
 */
async function handleShareCongrats(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  shareId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;
  const share = await getShare(env.DB, shareId);
  if (!share || share.retracted_at !== null || !(await shareVisibleTo(env.DB, share, caller.id))) {
    return json({ error: "not_found" }, 404, cors);
  }
  if (!share.is_win) return json({ error: "not_won" }, 409, cors);
  if (share.owner_id === caller.id) return json({ error: "cannot_congratulate_own" }, 409, cors);

  if (request.method === "POST") {
    const allowed = await rateLimitCheck(env.DB, caller.id, "congratulate");
    if (!allowed) {
      return json({ error: "rate_limited" }, 429, cors, { "Retry-After": String(RATE_WINDOW) });
    }
    // Only notify the owner on a NEW congratulate — a duplicate (PK no-op)
    // must not re-notify. Cheap: compare count before/after the insert.
    const before = await congratsCount(env.DB, shareId);
    await congratulate(env.DB, shareId, caller.id);
    const after = await congratsCount(env.DB, shareId);
    if (after > before) {
      await insertNotification(env.DB, {
        userId: share.owner_id, type: "congratulation_received", actorId: caller.id,
        subjectType: "share", subjectId: shareId,
      });
    }
    return json({ count: after, congratulatedByMe: true }, 200, cors);
  }
  // DELETE — undo (idempotent). No notification on undo.
  await unCongratulate(env.DB, shareId, caller.id);
  const count = await congratsCount(env.DB, shareId);
  return json({ count, congratulatedByMe: false }, 200, cors);
}

// ---------------------------------------------------------------------------
// Friend Interactions Phase 4 — notification bell (read side).
// ---------------------------------------------------------------------------

/** GET /api/social/notifications — the bell list (newest-first, cap 50). */
async function handleNotifications(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const notifications = await listNotifications(env.DB, callerR.user.id);
  return json({ notifications }, 200, cors);
}

/** GET /api/social/notifications/unread-count — the bell badge. */
async function handleNotificationsUnread(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const count = await unreadCount(env.DB, callerR.user.id);
  return json({ count }, 200, cors);
}

/** POST /api/social/notifications/read — mark one ({id}) or all read. */
async function handleNotificationsRead(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;
  let id: string | undefined;
  try {
    const body = (await request.json()) as { id?: unknown } | null;
    id = typeof body?.id === "string" ? body.id : undefined;
  } catch {
    /* empty / non-JSON body → mark all read */
  }
  if (id) await markRead(env.DB, caller.id, id);
  else await markAllRead(env.DB, caller.id);
  return json({ ok: true }, 200, cors);
}
