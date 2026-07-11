// Social primitives: cheers (legacy, replaced by congratulate in Phase 3),
// block/report, public profile. Split out of index.ts 2026-07-08.
//
// Friend Interactions Phase 2 — LEGACY FOLLOW SYSTEM REMOVED. The asymmetric
// `follows` table + /follow endpoints + follower/followee/is_following profile
// fields were deleted in this phase (beta: aggressive legacy elimination). The
// social graph is now the mutual-friend `social_edges` model (Phase 1). A block
// still severs friend edges in both directions (wired at the route layer via
// friends.severEdgesBothDirections). friends-on-race/card are STUBBED empty
// here — they were the last follows-based reads and must not serve the old
// visibility model; Phase 3 re-points them to mutual-friends + share-gating.
//
// cheers remain ONLY until Phase 3 ships congratulate (their replacement), per
// the same-phase deletion rule. profiles: public fields only (handle,
// display_name, avatar); clerk_user_id / email / age_verified NEVER leave the
// Worker. rate limits: per-user per-minute bucket in D1.

import { NOW, RATE_LIMITS, RATE_WINDOW, TicketWithSocial, UserRow } from "./core";
import { decodeTicket } from "./tickets";

/** Public-safe user projection. NEVER include clerk_user_id, email, age_verified. */
export function publicUser(u: UserRow, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: u.id,
    handle: u.handle,
    display_name: u.display_name,
    avatar: u.avatar,
    created_at: u.created_at,
    ...(extra ?? {}),
  };
}

/** Rate-limit check; returns true if the action is allowed (and records it). */
export async function rateLimitCheck(
  db: D1Database,
  userId: string,
  action: string,
): Promise<boolean> {
  const limit = RATE_LIMITS[action];
  if (!limit) return true; // unknown action: don't block
  const bucket = Math.floor(NOW() / RATE_WINDOW);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (user_id, action, bucket, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id, action, bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(userId, action, bucket)
    .first<{ count: number }>();
  // row.count is the post-increment value; allow iff it's within the limit.
  return (row?.count ?? 0) <= limit;
}

export async function userById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

export async function userByHandle(db: D1Database, handle: string): Promise<UserRow | null> {
  // Case-insensitive: handles are unique on lower(handle) (0010's
  // idx_users_handle_ci_unique), which this predicate seeks directly. Public
  // profile routing must not split "Bob" and "bob" into two users.
  return db
    .prepare(`SELECT * FROM users WHERE lower(handle) = lower(?)`)
    .bind(handle)
    .first<UserRow>();
}

// Friend Interactions Phase 3: the legacy `cheers` system is DELETED in this
// phase (congratulate replaces it). No cheer functions remain.

// ---- block + report -------------------------------------------------------

/** Returns true if EITHER user has blocked the other (block is symmetric for
 *  the purpose of social interaction guards — either side blocks the pair). */
export async function blockExistsEitherDirection(
  db: D1Database,
  aId: string,
  bId: string,
): Promise<boolean> {
  if (aId === bId) return false;
  const row = await db
    .prepare(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?)
           OR (blocker_id = ? AND blocked_id = ?)`,
    )
    .bind(aId, bId, bId, aId)
    .first<{ "1": number }>();
  return !!row;
}

/** Insert-or-nothing block. Idempotent. Severing of the friend graph in both
 *  directions is done at the route layer (friends.severEdgesBothDirections) to
 *  keep the friends→social import acyclic. */
export async function blockUser(
  db: D1Database,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(blocker_id, blocked_id) DO NOTHING`,
    )
    .bind(blockerId, blockedId, NOW())
    .run();
}

export async function unblockUser(
  db: D1Database,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?`)
    .bind(blockerId, blockedId)
    .run();
}

/** Write a report row. Returns true on success. Caller validates fields + rate. */
export async function addReport(
  db: D1Database,
  reporterId: string,
  targetType: "ticket" | "user",
  targetId: string,
  reason: string,
): Promise<boolean> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, reporterId, targetType, targetId, reason, NOW())
      .run();
    return true;
  } catch {
    // FK violation (target user doesn't exist) or CHECK — caller has already
    // validated; treat any error as a soft failure.
    return false;
  }
}

// ---- profile --------------------------------------------------------------

/** Decode a TicketWithSocial into the client's CommittedTicket shape. */
function decodeSocialTicket(row: TicketWithSocial): Record<string, unknown> | null {
  // owner per Decision 9: client derives TicketOwner; server sends flat fields.
  const owner =
    row.owner_handle || row.owner_display_name
      ? {
          id: row.user_id,
          handle: row.owner_handle,
          display_name: row.owner_display_name,
          avatar: row.owner_avatar,
        }
      : null;
  return decodeTicket(row, { owner });
}

/**
 * Public profile: a user's public-safe fields + their tickets (newest first).
 * Friend Interactions: follower/followee/is_following removed with the follow
 * system (the route overlays `friendship`); the legacy cheer overlay + its JOINs
 * removed with cheer (congratulate is share-scoped, not ticket-scoped).
 */
export async function buildProfile(
  db: D1Database,
  profileUser: UserRow,
  viewerUserId: string | null,
): Promise<Record<string, unknown>> {
  void viewerUserId;
  const { results: ticketsRaw } = await db
    .prepare(
      `SELECT t.id, t.user_id, t.serial, t.race_key, t.payload, t.state,
              t.payout_base, t.returned, t.created_at, t.placings,
              u.handle AS owner_handle,
              u.display_name AS owner_display_name,
              u.avatar AS owner_avatar
         FROM tickets t
         JOIN users u ON u.id = t.user_id
        WHERE t.user_id = ?
        ORDER BY t.created_at DESC
        LIMIT 50`,
    )
    .bind(profileUser.id)
    .all<TicketWithSocial>();
  const tickets: Record<string, unknown>[] = [];
  for (const row of ticketsRaw) {
    const decoded = decodeSocialTicket(row);
    if (decoded) tickets.push(decoded);
  }
  return {
    ...publicUser(profileUser),
    tickets,
  };
}

// ---- friends-on-race / friends-on-card (STUBBED — Phase 3 re-point) --------

export interface FriendsAvatars {
  count: number;
  avatars: { handle: string | null; display_name: string | null; avatar: string | null }[];
}

export interface FriendsCardResult extends FriendsAvatars {
  perRace: Record<string, FriendsAvatars>;
}

/**
 * Friends-on-race (Phase 3 re-point): mutual friends who have a LIVE, VISIBLE
 * share on a ticket whose race is `raceKey`. Share-gated (no auto-exposure) +
 * audience-respected + block-filtered. This replaces the Phase-2 stub, which
 * replaced the legacy follow-based read — the last auto-exposure surface, now
 * consistent with the friend feed.
 */
export async function friendsOnRace(
  db: D1Database,
  userId: string,
  raceKey: string,
): Promise<FriendsAvatars> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.handle, u.display_name, u.avatar
         FROM shares s
         JOIN tickets t ON t.id = s.ticket_id
         JOIN users u ON u.id = s.owner_id
        WHERE s.retracted_at IS NULL
          AND t.race_key = ?
          AND s.owner_id <> ?
          AND s.owner_id IN (
                SELECT target_id FROM social_edges
                 WHERE source_id = ? AND type = 'friend' AND state = 'accepted')
          AND s.owner_id IN (
                SELECT source_id FROM social_edges
                 WHERE target_id = ? AND type = 'friend' AND state = 'accepted')
          AND (s.audience_mode = 'all_friends' OR EXISTS (
                SELECT 1 FROM share_audience sa WHERE sa.share_id = s.id AND sa.user_id = ?))
          AND NOT EXISTS (
                SELECT 1 FROM blocks
                 WHERE (blocker_id = ? AND blocked_id = s.owner_id)
                    OR (blocker_id = s.owner_id AND blocked_id = ?))`,
    )
    .bind(raceKey, userId, userId, userId, userId, userId, userId)
    .all<{ handle: string | null; display_name: string | null; avatar: string | null }>();
  return { count: results.length, avatars: results.slice(0, 8) };
}

/**
 * Friends-on-card (Phase 3 re-point): card-level count/avatars + a per-race
 * breakdown, in one query over share-gated mutual-friend visibility. Mirrors
 * friendsOnRace but across `raceKeys`.
 */
export async function friendsOnCard(
  db: D1Database,
  userId: string,
  raceKeys: string[],
): Promise<FriendsCardResult> {
  if (raceKeys.length === 0) return { count: 0, avatars: [], perRace: {} };
  const placeholders = raceKeys.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT s.owner_id, t.race_key, u.handle, u.display_name, u.avatar
         FROM shares s
         JOIN tickets t ON t.id = s.ticket_id
         JOIN users u ON u.id = s.owner_id
        WHERE s.retracted_at IS NULL
          AND t.race_key IN (${placeholders})
          AND s.owner_id <> ?
          AND s.owner_id IN (
                SELECT target_id FROM social_edges
                 WHERE source_id = ? AND type = 'friend' AND state = 'accepted')
          AND s.owner_id IN (
                SELECT source_id FROM social_edges
                 WHERE target_id = ? AND type = 'friend' AND state = 'accepted')
          AND (s.audience_mode = 'all_friends' OR EXISTS (
                SELECT 1 FROM share_audience sa WHERE sa.share_id = s.id AND sa.user_id = ?))
          AND NOT EXISTS (
                SELECT 1 FROM blocks
                 WHERE (blocker_id = ? AND blocked_id = s.owner_id)
                    OR (blocker_id = s.owner_id AND blocked_id = ?))`,
    )
    .bind(...raceKeys, userId, userId, userId, userId, userId, userId)
    .all<{
      owner_id: string;
      race_key: string;
      handle: string | null;
      display_name: string | null;
      avatar: string | null;
    }>();
  type Avatar = { handle: string | null; display_name: string | null; avatar: string | null };
  const byRace = new Map<string, Map<string, Avatar>>();
  const cardFriends = new Map<string, Avatar>();
  for (const r of results) {
    const a: Avatar = { handle: r.handle, display_name: r.display_name, avatar: r.avatar };
    cardFriends.set(r.owner_id, a);
    let bucket = byRace.get(r.race_key);
    if (!bucket) {
      bucket = new Map();
      byRace.set(r.race_key, bucket);
    }
    bucket.set(r.owner_id, a);
  }
  const perRace: Record<string, FriendsAvatars> = {};
  for (const [rk, friends] of byRace) {
    const arr = [...friends.values()];
    perRace[rk] = { count: arr.length, avatars: arr.slice(0, 8) };
  }
  const cardArr = [...cardFriends.values()];
  return { count: cardArr.length, avatars: cardArr.slice(0, 8), perRace };
}
