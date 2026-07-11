// Friend Interactions Phase 1 — the friend graph on `social_edges`.
//
// Model (see migrations/0011): DIRECTED edges with a mutual state, NOT a single
// symmetric row — so a future one-way follow mode is a re-enable, not a rewrite.
//   mutual friendship  = (a→b friend accepted) AND (b→a friend accepted)
//   a friend request    = one directed edge (a→b friend pending)
//   accept              = flip the pending edge to accepted AND create the
//                         reverse accepted edge ⇒ mutual
//   auto-accept         = if B already has a pending request INTO A, then A's
//                         new request to B short-circuits straight to mutual
//                         ("a request to someone who has requested you
//                         auto-accepts")
//
// Block/report stay in their own tables (Phase 4 primitives, reused). A block
// severs social_edges in both directions (wired in social.ts blockUser) and the
// request path refuses pairs blocked either way.
//
// All mutators return a discriminated result so routes can (a) map to HTTP and
// (b) fan out the right notification WITHOUT re-querying. The notification fan
// itself is invoked by the route (friends.ts stays notification-agnostic so the
// state machine is unit-testable in isolation).

import { NOW, SocialEdgeRow } from "./core";
import { blockExistsEitherDirection } from "./social";

// ---- result types (routes map these to HTTP + notification fan-out) --------

export type FriendRequestResult =
  | {
      ok: true;
      transition: "created_pending" | "auto_accepted" | "already_pending" | "already_friends";
      /** Who to notify + which notification type, if this transition fires one. */
      notify?: { type: "friend_request_received" | "friend_request_accepted"; recipientId: string };
    }
  | { ok: false; code: "cannot_friend_self" | "blocked" };

export type AcceptResult =
  | {
      ok: true;
      transition: "accepted" | "already_friends";
      notify?: { type: "friend_request_accepted"; recipientId: string };
    }
  | { ok: false; code: "cannot_friend_self" | "blocked" | "no_pending_request" };

/** Friendship state of `other` from `viewer`'s perspective (search/profile). */
export type FriendshipState = "self" | "friends" | "pending_outgoing" | "pending_incoming" | "none";

// ---- edge primitives -------------------------------------------------------

/** Read both friend-direction edges between a pair (ab = a→b, ba = b→a). */
async function readFriendEdges(
  db: D1Database,
  a: string,
  b: string,
): Promise<{ ab: SocialEdgeRow | null; ba: SocialEdgeRow | null }> {
  const [ab, ba] = await Promise.all([
    db
      .prepare(`SELECT * FROM social_edges WHERE source_id = ? AND target_id = ? AND type = 'friend'`)
      .bind(a, b)
      .first<SocialEdgeRow>(),
    db
      .prepare(`SELECT * FROM social_edges WHERE source_id = ? AND target_id = ? AND type = 'friend'`)
      .bind(b, a)
      .first<SocialEdgeRow>(),
  ]);
  return { ab, ba };
}

/** Insert-or-update a friend edge to `accepted` (creates the reverse half of a
 *  mutual pair on accept). decided_at stamps the handshake moment. */
function setFriendAccepted(db: D1Database, source: string, target: string, now: number): Promise<void> {
  return db
    .prepare(
      `INSERT INTO social_edges (source_id, target_id, type, state, created_at, decided_at)
       VALUES (?, ?, 'friend', 'accepted', ?, ?)
       ON CONFLICT(source_id, target_id, type) DO UPDATE SET state = 'accepted', decided_at = excluded.decided_at`,
    )
    .bind(source, target, now, now)
    .run()
    .then(() => undefined);
}

/** Insert a fresh pending request edge (caller has already ruled out the
 *  idempotent / auto-accept cases). */
function insertPending(db: D1Database, source: string, target: string, now: number): Promise<void> {
  return db
    .prepare(
      `INSERT INTO social_edges (source_id, target_id, type, state, created_at, decided_at)
       VALUES (?, ?, 'friend', 'pending', ?, NULL)
       ON CONFLICT(source_id, target_id, type) DO UPDATE SET state = 'pending', decided_at = NULL`,
    )
    .bind(source, target, now)
    .run()
    .then(() => undefined);
}

// ---- the state machine -----------------------------------------------------

/**
 * Send a friend request from `source` to `target`. Idempotent: a repeat request
 * while one is already pending (or already friends) is a no-op success.
 * Auto-accepts when `target` already has a pending request into `source`.
 * Routes check target existence (404) + self before calling.
 */
export async function requestFriend(
  db: D1Database,
  source: string,
  target: string,
): Promise<FriendRequestResult> {
  if (source === target) return { ok: false, code: "cannot_friend_self" };
  const blocked = await blockExistsEitherDirection(db, source, target);
  if (blocked) return { ok: false, code: "blocked" };

  const { ab, ba } = await readFriendEdges(db, source, target);
  const now = NOW();

  // Already mutual friends — idempotent no-op.
  if (ab?.state === "accepted" && ba?.state === "accepted") {
    return { ok: true, transition: "already_friends" };
  }
  // Auto-accept: target already requested source (ba pending). Collapse to mutual.
  if (ba?.state === "pending") {
    await Promise.all([
      setFriendAccepted(db, source, target, now), // a→b (the half being created)
      setFriendAccepted(db, target, source, now), // b→a (the pending one, now accepted)
    ]);
    // target's pending request was effectively accepted → notify target.
    return { ok: true, transition: "auto_accepted", notify: { type: "friend_request_accepted", recipientId: target } };
  }
  // Source already has an outstanding (pending) or half-accepted request → idempotent.
  if (ab && (ab.state === "pending" || ab.state === "accepted")) {
    return { ok: true, transition: "already_pending" };
  }
  // Fresh request.
  await insertPending(db, source, target, now);
  return { ok: true, transition: "created_pending", notify: { type: "friend_request_received", recipientId: target } };
}

/**
 * `accepter` accepts `requester`'s pending request. Requires requester→accepter
 * pending. Idempotent if already friends; 404-shaped if no pending request.
 */
export async function acceptRequest(
  db: D1Database,
  accepter: string,
  requester: string,
): Promise<AcceptResult> {
  if (accepter === requester) return { ok: false, code: "cannot_friend_self" };
  const blocked = await blockExistsEitherDirection(db, accepter, requester);
  if (blocked) return { ok: false, code: "blocked" };

  const { ab, ba } = await readFriendEdges(db, accepter, requester); // ba = requester→accepter
  if (ab?.state === "accepted" && ba?.state === "accepted") {
    return { ok: true, transition: "already_friends" };
  }
  if (!ba || ba.state !== "pending") {
    return { ok: false, code: "no_pending_request" };
  }
  const now = NOW();
  await Promise.all([
    setFriendAccepted(db, requester, accepter, now), // flip the pending half
    setFriendAccepted(db, accepter, requester, now), // create the reverse half ⇒ mutual
  ]);
  return { ok: true, transition: "accepted", notify: { type: "friend_request_accepted", recipientId: requester } };
}

/** Decline is SILENT to the sender: just delete the pending edge. Idempotent. */
export async function declineRequest(db: D1Database, decliner: string, requester: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM social_edges
        WHERE source_id = ? AND target_id = ? AND type = 'friend' AND state = 'pending'`,
    )
    .bind(requester, decliner)
    .run();
}

/** Remove is SILENT + MUTUAL: delete both friend-direction edges. Idempotent. */
export async function removeFriend(db: D1Database, a: string, b: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM social_edges
        WHERE type = 'friend'
          AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`,
    )
    .bind(a, b, b, a)
    .run();
}

// ---- reads (friends list, pending, search, profile state) ------------------

/** True iff a and b are mutual friends (both directions friend+accepted). */
export async function areFriends(db: D1Database, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const { ab, ba } = await readFriendEdges(db, a, b);
  return ab?.state === "accepted" && ba?.state === "accepted";
}

export async function friendshipState(db: D1Database, viewer: string, other: string): Promise<FriendshipState> {
  if (viewer === other) return "self";
  const { ab, ba } = await readFriendEdges(db, viewer, other);
  if (ab?.state === "accepted" && ba?.state === "accepted") return "friends";
  if (ab?.state === "pending") return "pending_outgoing";
  if (ba?.state === "pending") return "pending_incoming";
  return "none";
}

export interface FriendSummary {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
}

/** Mutual friends of `userId` (both directions friend+accepted). */
export async function listFriends(db: D1Database, userId: string): Promise<FriendSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, u.avatar
         FROM users u
        WHERE u.id IN (
                SELECT target_id FROM social_edges
                 WHERE source_id = ? AND type = 'friend' AND state = 'accepted')
          AND u.id IN (
                SELECT source_id FROM social_edges
                 WHERE target_id = ? AND type = 'friend' AND state = 'accepted')
        ORDER BY u.handle`,
    )
    .bind(userId, userId)
    .all<FriendSummary>();
  return results;
}

/** Pending requests INTO `userId` (who has asked to be your friend). */
export async function listPendingIncoming(db: D1Database, userId: string): Promise<FriendSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, u.avatar
         FROM social_edges e JOIN users u ON u.id = e.source_id
        WHERE e.target_id = ? AND e.type = 'friend' AND e.state = 'pending'
        ORDER BY e.created_at DESC`,
    )
    .bind(userId)
    .all<FriendSummary>();
  return results;
}

/** Pending requests FROM `userId` (who you've asked, awaiting answer). */
export async function listPendingOutgoing(db: D1Database, userId: string): Promise<FriendSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, u.avatar
         FROM social_edges e JOIN users u ON u.id = e.target_id
        WHERE e.source_id = ? AND e.type = 'friend' AND e.state = 'pending'
        ORDER BY e.created_at DESC`,
    )
    .bind(userId)
    .all<FriendSummary>();
  return results;
}

export interface SearchHit extends FriendSummary {
  friendship: FriendshipState;
}

/**
 * Handle search: exact OR prefix match on lower(handle). Returns public fields
 * + the viewer's friendship state with each hit. Excludes the viewer + users in
 * a block relationship with the viewer (either direction). Cap 20 — typeahead
 * sized, not an exhaustive directory (no public directory in v1).
 *
 * Prefix LIKE covers exact match (an exact handle is a prefix of itself), so a
 * single `handle LIKE 'q%' || '%'` predicate satisfies "exact or prefix".
 */
export async function searchUsers(
  db: D1Database,
  query: string,
  viewerId: string,
): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 1 || q.length > 32) return [];
  const { results } = await db
    .prepare(
      `SELECT id, handle, display_name, avatar
         FROM users
        WHERE handle IS NOT NULL
          AND lower(handle) LIKE lower(?) || '%'
          AND id <> ?
        ORDER BY (handle = ?) DESC, handle
        LIMIT 20`,
    )
    .bind(q, viewerId, q)
    .all<FriendSummary>();
  const hits: SearchHit[] = [];
  for (const r of results) {
    // Skip blocked either-direction (search must not surface blocked users).
    const blocked = await blockExistsEitherDirection(db, viewerId, r.id);
    if (blocked) continue;
    hits.push({ ...r, friendship: await friendshipState(db, viewerId, r.id) });
  }
  return hits;
}

/**
 * Delete every social_edges row between a and b in both directions. Called by
 * social.ts blockUser so a block removes friendship + any pending request
 * ("Block: removes friendship … prevents new requests"). Lives here (not in
 * social.ts) because it is edge-graph knowledge, but social.ts owns the call
 * site to keep the one-way dep (friends → social) acyclic.
 */
export async function severEdgesBothDirections(db: D1Database, a: string, b: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM social_edges
        WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)`,
    )
    .bind(a, b, b, a)
    .run();
}
