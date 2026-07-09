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
  addCheer,
  addReport,
  blockExistsEitherDirection,
  blockUser,
  buildFeed,
  buildProfile,
  cheerCount,
  followUser,
  friendsOnCard,
  friendsOnRace,
  rateLimitCheck,
  removeCheer,
  unblockUser,
  unfollowUser,
  userByHandle,
  userById,
} from "./social";
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
const TICKET_CHEER_PATH = /^\/api\/social\/tickets\/([^/]+)\/cheer$/;
const FOLLOW_PATH = /^\/api\/social\/follow\/([^/]+)$/;
const BLOCK_PATH = /^\/api\/social\/block\/([^/]+)$/;
const PROFILE_PATH = /^\/api\/social\/users\/([^/]+)$/;
const RACE_FRIENDS_PATH = /^\/api\/social\/races\/([^/]+)\/friends$/;
const FEED_PATH = "/api/social/feed";
const FRIENDS_ON_CARD_PATH = "/api/social/friends/on-card";
const REPORT_PATH = "/api/social/report";
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

  // /api/social/follow/:userId — Phase 3 follow graph.
  const followMatch = FOLLOW_PATH.exec(pathname);
  if (followMatch) {
    return handleFollow(request, env, cors, decodeURIComponent(followMatch[1]));
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

  // /api/social/tickets/:id/cheer — Phase 3 cheers.
  const cheerMatch = TICKET_CHEER_PATH.exec(pathname);
  if (cheerMatch) {
    return handleCheer(request, env, cors, decodeURIComponent(cheerMatch[1]));
  }

  // /api/social/tickets and /api/social/tickets/:id — Phase 2 persistence.
  const ticketMatch = TICKET_PATH.exec(pathname);
  if (ticketMatch && !TICKET_CHEER_PATH.exec(pathname)) {
    return handleTickets(request, env, cors, ticketMatch[2] ?? null);
  }

  // /api/social/feed — Phase 3 feed.
  if (pathname === FEED_PATH) {
    return handleFeed(request, env, cors);
  }

  // /api/social/friends/on-card — Phase 3 today's-card strip.
  if (pathname === FRIENDS_ON_CARD_PATH) {
    return handleFriendsOnCard(request, env, cors, url);
  }

  // /api/social/races/:raceKey/friends — Phase 3 friends-on-race.
  const raceFriendsMatch = RACE_FRIENDS_PATH.exec(pathname);
  if (raceFriendsMatch) {
    return handleRaceFriends(request, env, cors, decodeURIComponent(raceFriendsMatch[1]));
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
      // Phase 3: handle/dn/avatar. Empty string clears; null also accepted.
      if (typeof body.handle === "string") {
        const h = body.handle.trim();
        if (h.length === 0 || h.length > 32) {
          return json({ error: "bad_handle" }, 400, cors);
        }
        if (!/^[a-zA-Z0-9_]+$/.test(h)) {
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

async function handleFollow(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  targetId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  if (targetId === caller.id) {
    return json({ error: "cannot_follow_self" }, 403, cors);
  }
  // 404 if the target user doesn't exist (don't leak existence via 200).
  const target = await userById(env.DB, targetId);
  if (!target) return json({ error: "not_found" }, 404, cors);

  // Phase 4: a block in EITHER direction forbids follow. The block check
  // happens after the 404 so a missing user still surfaces as not_found,
  // not as a leaky 403.
  const blocked = await blockExistsEitherDirection(env.DB, caller.id, targetId);
  if (blocked) {
    return json({ error: "blocked" }, 403, cors);
  }

  if (request.method === "POST") {
    const allowed = await rateLimitCheck(env.DB, caller.id, "follow");
    if (!allowed) {
      return json(
        { error: "rate_limited" },
        429,
        cors,
        { "Retry-After": String(RATE_WINDOW) },
      );
    }
    await followUser(env.DB, caller.id, targetId);
    return json({ ok: true }, 200, cors);
  }
  // DELETE
  const allowed = await rateLimitCheck(env.DB, caller.id, "follow");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }
  await unfollowUser(env.DB, caller.id, targetId);
  return json({ ok: true }, 200, cors);
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

async function handleCheer(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  ticketId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;

  const ticket = await findTicket(env.DB, ticketId);
  if (!ticket) return json({ error: "not_found" }, 404, cors);

  // Won-only (Decision table): cheering is a celebration, not pre-race hype.
  if (ticket.state !== "won") {
    return json({ error: "not_won" }, 409, cors);
  }
  // Self-cheer forbidden (Decision 2).
  if (ticket.user_id === caller.id) {
    return json({ error: "cannot_cheer_own_ticket" }, 409, cors);
  }
  // Phase 4: a block in EITHER direction forbids cheer (same rule as follow).
  const blocked = await blockExistsEitherDirection(env.DB, caller.id, ticket.user_id);
  if (blocked) {
    return json({ error: "blocked" }, 403, cors);
  }

  const allowed = await rateLimitCheck(env.DB, caller.id, "cheer");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }

  if (request.method === "POST") {
    await addCheer(env.DB, ticketId, caller.id);
  } else {
    await removeCheer(env.DB, ticketId, caller.id);
  }
  const [count, byMe] = await Promise.all([
    cheerCount(env.DB, ticketId),
    request.method === "POST"
      ? Promise.resolve(true)
      : Promise.resolve(false),
  ]);
  // For POST, the PK dedupe guarantees the row exists, so cheeredByMe=true
  // is correct without a re-read. For DELETE, even if the row didn't exist
  // (idempotent uncheer), the user is not cheering now.
  return json({ count, cheeredByMe: byMe }, 200, cors);
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
  const tickets = await buildFeed(env.DB, caller.id);
  return json({ tickets }, 200, cors);
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
