// Phase 3 — social primitives (follows, cheers, rate limits, profile, feed)
// + Phase 4 — block + report primitives. Split out of index.ts 2026-07-08
// (mechanical, no behavior change).
//
// Phase 3 social model:
//   - follows: asymmetric Twitter-style graph. INSERT ... DO NOTHING makes a
//     repeat follow idempotent. self-follow blocked at the handler level
//     (CHECK constraint is the backstop).
//   - cheers: 1 row per (ticket_id, user_id). Count is COUNT(*) from the
//     cheers table — never a denormalized counter (Decision 1: correctness
//     over speed; the 45s client poll hides any read latency). Self-cheer
//     forbidden (Decision 2); uncheer supported (Decision 3).
//   - profiles: public fields only (handle, display_name, avatar, counts).
//     clerk_user_id / email / age_verified NEVER leave the Worker.
//   - rate limits: per-user per-minute bucket in D1 (Decision 8). Phase 4
//     replaces with a real token bucket in KV.
//
// Phase 4 block model — asymmetric + one-way (Twitter model): INSERT means
// `blocker` has blocked `blocked`. A block:
//   1. Severs existing follows in BOTH directions (A blocks B → A unfollows
//      B AND B unfollows A).
//   2. Prevents future follow/cheer between the pair, in either direction
//      (A can't follow or cheer B; B can't follow or cheer A).
//   3. Filters the blocked user's tickets out of the BLOCKER's feed (one-way
//      — the blocked user can still see the blocker's tickets, mirroring the
//      "I don't want to see them" intent of a block).
//
// Report is write-only: rows land in `reports` for later moderation review
// (Phase 4 backlog — no review UI ships in this phase).

import { NOW, RATE_LIMITS, RATE_WINDOW, TicketWithSocial, UserRow } from "./core";
import { decodeTicket } from "./tickets";

/** Public-safe user projection. NEVER include clerk_user_id, email, age_verified. */
export function publicUser(u: UserRow, extra?: { follower_count?: number; followee_count?: number; is_following?: boolean }): Record<string, unknown> {
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

/** Insert-or-nothing follow. Idempotent — a repeat follow is a no-op 200. */
export async function followUser(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO follows (follower_id, followee_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(follower_id, followee_id) DO NOTHING`,
    )
    .bind(followerId, followeeId, NOW())
    .run();
}

export async function unfollowUser(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`,
    )
    .bind(followerId, followeeId)
    .run();
}

export async function isFollowing(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?`,
    )
    .bind(followerId, followeeId)
    .first<{ "1": number }>();
  return !!row;
}

export async function followerCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function followeeCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Count of cheers on a ticket (Decision 1: COUNT(*), never a denormalized column). */
export async function cheerCount(db: D1Database, ticketId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM cheers WHERE ticket_id = ?`)
    .bind(ticketId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function hasCheered(
  db: D1Database,
  ticketId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM cheers WHERE ticket_id = ? AND user_id = ?`)
    .bind(ticketId, userId)
    .first<{ "1": number }>();
  return !!row;
}

/**
 * Insert-or-nothing cheer. Returns the post-call count + cheeredByMe state.
 * Caller enforces won-only + self-cheer rules before calling.
 */
export async function addCheer(
  db: D1Database,
  ticketId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cheers (ticket_id, user_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(ticket_id, user_id) DO NOTHING`,
    )
    .bind(ticketId, userId, NOW())
    .run();
}

export async function removeCheer(
  db: D1Database,
  ticketId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM cheers WHERE ticket_id = ? AND user_id = ?`)
    .bind(ticketId, userId)
    .run();
}

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

/** Insert-or-nothing block + sever existing follows both ways. Idempotent. */
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
  // Sever follows in both directions. Two DELETEs, not one — the pair is
  // asymmetric (follower/followee) so each direction needs its own clause.
  await db
    .prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`)
    .bind(blockerId, blockedId)
    .run();
  await db
    .prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`)
    .bind(blockedId, blockerId)
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
  return decodeTicket(row, {
    owner,
    cheers: row.cheers_count ?? 0,
    cheeredByMe: !!row.cheered_by_me,
  });
}

/**
 * Feed: caller's own tickets + followees' tickets, newest first, cap 100.
 * Each ticket carries owner + cheers count + cheeredByMe.
 *
 * Phase 4: filters out tickets owned by users the caller has blocked
 * (one-way — the blocked user can still see the blocker's tickets).
 */
export async function buildFeed(
  db: D1Database,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.user_id, t.serial, t.race_key, t.payload, t.state,
              t.payout_base, t.returned, t.created_at, t.placings,
              u.handle AS owner_handle,
              u.display_name AS owner_display_name,
              u.avatar AS owner_avatar,
              COALESCE(c.n, 0) AS cheers_count,
              (me.ticket_id IS NOT NULL) AS cheered_by_me
         FROM tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN (SELECT ticket_id, COUNT(*) AS n FROM cheers GROUP BY ticket_id) c
           ON c.ticket_id = t.id
         LEFT JOIN cheers me ON me.ticket_id = t.id AND me.user_id = ?
        WHERE (t.user_id = ?
           OR t.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?))
           AND NOT EXISTS (
             SELECT 1 FROM blocks
              WHERE blocker_id = ? AND blocked_id = t.user_id
           )
        ORDER BY t.created_at DESC
        LIMIT 100`,
    )
    .bind(userId, userId, userId, userId)
    .all<TicketWithSocial>();
  const out: Record<string, unknown>[] = [];
  for (const row of results) {
    const decoded = decodeSocialTicket(row);
    if (decoded) out.push(decoded);
  }
  return out;
}

/** Public profile: a user's public-safe fields + their tickets (newest first). */
export async function buildProfile(
  db: D1Database,
  profileUser: UserRow,
  viewerUserId: string | null,
): Promise<Record<string, unknown>> {
  const [folls, follees, ticketsRaw] = await Promise.all([
    followerCount(db, profileUser.id),
    followeeCount(db, profileUser.id),
    db
      .prepare(
        `SELECT t.id, t.user_id, t.serial, t.race_key, t.payload, t.state,
                t.payout_base, t.returned, t.created_at, t.placings,
                u.handle AS owner_handle,
                u.display_name AS owner_display_name,
                u.avatar AS owner_avatar,
                COALESCE(c.n, 0) AS cheers_count,
                (me.ticket_id IS NOT NULL) AS cheered_by_me
           FROM tickets t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN (SELECT ticket_id, COUNT(*) AS n FROM cheers GROUP BY ticket_id) c
             ON c.ticket_id = t.id
           LEFT JOIN cheers me ON me.ticket_id = t.id AND me.user_id = ?
          WHERE t.user_id = ?
          ORDER BY t.created_at DESC
          LIMIT 50`,
      )
      // viewerUserId ?? null: a logged-out viewer binds NULL, and
      // `me.user_id = NULL` never matches → cheered_by_me = 0. One query shape.
      .bind(viewerUserId ?? null, profileUser.id)
      .all<TicketWithSocial>(),
  ]);
  const isFollowing = viewerUserId
    ? await isFollowingCheck(db, viewerUserId, profileUser.id)
    : false;
  const tickets: Record<string, unknown>[] = [];
  for (const row of ticketsRaw.results) {
    const decoded = decodeSocialTicket(row);
    if (decoded) tickets.push(decoded);
  }
  return {
    ...publicUser(profileUser, {
      follower_count: folls,
      followee_count: follees,
      is_following: isFollowing,
    }),
    tickets,
  };
}

async function isFollowingCheck(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  if (followerId === followeeId) return false;
  return isFollowing(db, followerId, followeeId);
}

export interface FriendsAvatars {
  count: number;
  avatars: { handle: string | null; display_name: string | null; avatar: string | null }[];
}

/**
 * Friends-on-card PLUS a per-race breakdown, in ONE query (Stage 5). Replaces
 * the former 1 card + up-to-12 per-race requests the MyTickets snapshot loop
 * made. The single join returns every (followed user × snapshot race they hold
 * a ticket on); card-level + perRace are grouped locally from that.
 */
export interface FriendsCardResult extends FriendsAvatars {
  perRace: Record<string, FriendsAvatars>;
}

/** Friends-on-race: followed users with ≥1 ticket on this raceKey. */
export async function friendsOnRace(
  db: D1Database,
  userId: string,
  raceKey: string,
): Promise<FriendsAvatars> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.handle, u.display_name, u.avatar
         FROM follows f
         JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ?
          AND EXISTS (
            SELECT 1 FROM tickets t
             WHERE t.user_id = f.followee_id AND t.race_key = ?
          )`,
    )
    .bind(userId, raceKey)
    .all<{ handle: string | null; display_name: string | null; avatar: string | null }>();
  return {
    count: results.length,
    avatars: results.slice(0, 8),
  };
}

/** Friends-on-card (batched): card-level count/avatars + per-race breakdown. */
export async function friendsOnCard(
  db: D1Database,
  userId: string,
  raceKeys: string[],
): Promise<FriendsCardResult> {
  if (raceKeys.length === 0) return { count: 0, avatars: [], perRace: {} };
  const placeholders = raceKeys.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT f.followee_id, t.race_key, u.handle, u.display_name, u.avatar
         FROM follows f
         JOIN tickets t ON t.user_id = f.followee_id
         JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ? AND t.race_key IN (${placeholders})`,
    )
    .bind(userId, ...raceKeys)
    .all<{
      followee_id: string;
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
    cardFriends.set(r.followee_id, a);
    let bucket = byRace.get(r.race_key);
    if (!bucket) {
      bucket = new Map();
      byRace.set(r.race_key, bucket);
    }
    bucket.set(r.followee_id, a);
  }
  const perRace: Record<string, FriendsAvatars> = {};
  for (const [rk, friends] of byRace) {
    const arr = [...friends.values()];
    perRace[rk] = { count: arr.length, avatars: arr.slice(0, 8) };
  }
  const cardArr = [...cardFriends.values()];
  return { count: cardArr.length, avatars: cardArr.slice(0, 8), perRace };
}
