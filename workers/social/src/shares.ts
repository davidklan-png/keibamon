// Friend Interactions Phase 2 — shared tickets + audience + the friend feed.
//
// A share is the privacy gate: a ticket is invisible to friends until the owner
// shares it. One ACTIVE share per ticket (partial unique index in 0012); sharing
// again WIDENS the audience (idempotent), retracting soft-deletes it. The
// snapshot is frozen at share time — the live ticket row is never mutated, so
// there is no two-way sync and the shared card is stable.
//
// FEED = the viewer's own live shares + their MUTUAL FRIENDS' live shares
// (audience-respected, blocks filtered). Own shares are included and flagged
// `is_own` so the client badges them "You" with read-only reaction counts and a
// tap-through to the owner engagement surface. This REPLACES the legacy
// auto-feed in a clean cut: only explicitly-shared tickets appear.

import { AUDIENCE_MODES, NOW, ShareRow } from "./core";
import { areFriends, listFriends } from "./friends";
import { insertNotification } from "./notifications";

export type AudienceMode = "all_friends" | "selected";

export interface ShareOwner {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
}

/** A feed item: the immutable ticket snapshot + the owning friend + metadata.
 *  multiplier (returned/cost) is the win's odds framing — NO currency leaves the
 *  server for a win (congrats/comment counts + multiplier only).
 *
 *  `is_own` marks the viewer's own share (Item 4): own shares now appear in the
 *  feed too, badged "You" on the client with read-only reaction counts and a
 *  tap-through to the owner engagement surface (My Tickets detail). `ticket_id`
 *  is exposed so that own-item tap-through can route to the ticket detail. */
export interface FeedItem {
  id: string;
  /** The shared ticket's id (the live tickets row), for own-item routing. */
  ticket_id: string;
  ticket: Record<string, unknown> | null;
  owner: ShareOwner;
  audience_mode: AudienceMode;
  is_win: boolean;
  /** True when this share is the viewer's own (always visible; client badges it). */
  is_own: boolean;
  /** returned/cost for win items (odds framing); null otherwise. */
  multiplier: number | null;
  congrats_count: number;
  congratulated_by_me: boolean;
  comment_count: number;
  created_at: number;
}

/** A feed row joined with owner + ticket (cost/returned) + congratulate/comment
 *  aggregates. Shared by the feed + detail queries + the decoder. */
type FeedRow = ShareRow & {
  owner_handle: string | null;
  owner_display_name: string | null;
  owner_avatar: string | null;
  ticket_cost: number | null;
  ticket_returned: number | null;
  congrats_count: number;
  congratulated_by_me: number;
  comment_count: number;
};

// ---- audience resolution ---------------------------------------------------

/**
 * Resolve a share's recipient set, validated against the mutual-friend graph.
 * 'all_friends' → every current mutual friend (dynamic). 'selected' → the
 * intersection of the supplied list with the owner's mutual friends (non-friends
 * are silently dropped — you can only share to actual friends).
 */
export async function resolveAudience(
  db: D1Database,
  ownerId: string,
  mode: AudienceMode,
  selected: string[],
): Promise<string[]> {
  if (mode === "all_friends") {
    const friends = await listFriends(db, ownerId);
    return friends.map((f) => f.id);
  }
  // selected: keep only actual mutual friends.
  const out: string[] = [];
  for (const id of selected) {
    if (id === ownerId) continue;
    if (await areFriends(db, ownerId, id)) out.push(id);
  }
  return out;
}

// ---- read helpers ----------------------------------------------------------

/** The active (non-retracted) share for a ticket, if any. */
export async function activeShareForTicket(
  db: D1Database,
  ticketId: string,
  ownerId: string,
): Promise<ShareRow | null> {
  return db
    .prepare(
      `SELECT * FROM shares WHERE ticket_id = ? AND owner_id = ? AND retracted_at IS NULL`,
    )
    .bind(ticketId, ownerId)
    .first<ShareRow>();
}

export async function getShare(db: D1Database, shareId: string): Promise<ShareRow | null> {
  return db.prepare(`SELECT * FROM shares WHERE id = ?`).bind(shareId).first<ShareRow>();
}

// ---- write: create / widen / retract --------------------------------------

export interface ShareResult {
  share: ShareRow;
  /** Recipients notified by THIS call (fresh on create; only new on widen). */
  notified: string[];
}

/**
 * Create a share, or — if an active share for the ticket already exists — widen
 * its audience (idempotent). Captures `snapshot` on a fresh create; on widen the
 * existing snapshot is preserved (the shared card never changes post-hoc).
 * Notification fan-out is deduped against already-notified recipients, so a
 * widen only tells the NEW audience.
 */
export async function createShare(
  db: D1Database,
  ownerId: string,
  ticketId: string,
  snapshot: string,
  mode: AudienceMode,
  selected: string[],
): Promise<ShareResult> {
  const existing = await activeShareForTicket(db, ticketId, ownerId);
  if (existing) {
    return widenShare(db, existing, mode, selected);
  }
  const id = crypto.randomUUID();
  const now = NOW();
  await db
    .prepare(
      `INSERT INTO shares (id, ticket_id, owner_id, audience_mode, snapshot, is_win, retracted_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
    )
    .bind(id, ticketId, ownerId, mode, snapshot, now)
    .run();
  const recipients = await resolveAudience(db, ownerId, mode, selected);
  if (mode === "selected") {
    await writeSelectedAudience(db, id, recipients);
  }
  const notified = await notifyShareAudience(db, id, ownerId, recipients);
  const share: ShareRow = {
    id,
    ticket_id: ticketId,
    owner_id: ownerId,
    audience_mode: mode,
    snapshot,
    is_win: 0,
    retracted_at: null,
    created_at: now,
  };
  return { share, notified };
}

/**
 * Widen an existing share's audience (also the create-when-exists path). For
 * 'selected', the validated recipient list REPLACES the explicit audience; for
 * 'all_friends' the audience is dynamic so share_audience is cleared. Notifies
 * only recipients not already notified for this share.
 */
export async function widenShare(
  db: D1Database,
  share: ShareRow,
  mode: AudienceMode,
  selected: string[],
): Promise<ShareResult> {
  await db
    .prepare(`UPDATE shares SET audience_mode = ? WHERE id = ?`)
    .bind(mode, share.id)
    .run();
  await db.prepare(`DELETE FROM share_audience WHERE share_id = ?`).bind(share.id).run();
  const recipients = await resolveAudience(db, share.owner_id, mode, selected);
  if (mode === "selected") {
    await writeSelectedAudience(db, share.id, recipients);
  }
  const notified = await notifyShareAudience(db, share.id, share.owner_id, recipients);
  return { share: { ...share, audience_mode: mode }, notified };
}

/** Retract a share (owner-only at the route layer). Silent: drops from all feeds
 *  + Phase 3 hides its comments. No notification. Idempotent. */
export async function retractShare(db: D1Database, shareId: string, ownerId: string): Promise<void> {
  await db
    .prepare(`UPDATE shares SET retracted_at = ? WHERE id = ? AND owner_id = ? AND retracted_at IS NULL`)
    .bind(NOW(), shareId, ownerId)
    .run();
}

/** Insert the explicit selected-audience rows. Caller passes the ALREADY-
 *  friend-validated recipient list (from resolveAudience), so no per-row check. */
async function writeSelectedAudience(db: D1Database, shareId: string, recipients: string[]): Promise<void> {
  for (const id of recipients) {
    await db
      .prepare(
        `INSERT INTO share_audience (share_id, user_id) VALUES (?, ?) ON CONFLICT(share_id, user_id) DO NOTHING`,
      )
      .bind(shareId, id)
      .run();
  }
}

/**
 * Fan out ticket_shared_with_you to recipients who haven't already been notified
 * for this share. Returns the ids actually notified this call. Dedupe is via the
 * notifications table (the source of truth for "who was told"), so a widen only
 * reaches new audience members.
 */
export async function notifyShareAudience(
  db: D1Database,
  shareId: string,
  actorId: string,
  recipients: string[],
): Promise<string[]> {
  if (recipients.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT user_id FROM notifications
        WHERE type = 'ticket_shared_with_you' AND subject_id = ?`,
    )
    .bind(shareId)
    .all<{ user_id: string }>();
  const already = new Set(results.map((r) => r.user_id));
  const fresh = recipients.filter((r) => !already.has(r));
  for (const r of fresh) {
    await insertNotification(db, {
      userId: r,
      type: "ticket_shared_with_you",
      actorId,
      subjectType: "share",
      subjectId: shareId,
    });
  }
  return fresh;
}

// ---- congratulate (win-card reaction; replaces legacy cheer) ---------------

/** Resolve the audience of an EXISTING share: dynamic mutual friends for
 *  all_friends, or the stored share_audience rows for selected. Used by win
 *  fan-out + share-time notify (which goes through resolveAudience instead). */
export async function getShareAudience(db: D1Database, share: ShareRow): Promise<string[]> {
  if (share.audience_mode === "all_friends") {
    const friends = await listFriends(db, share.owner_id);
    return friends.map((f) => f.id);
  }
  const { results } = await db
    .prepare(`SELECT user_id FROM share_audience WHERE share_id = ?`)
    .bind(share.id)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** Insert-or-nothing congratulate. PK (share_id, user_id) enforces one-per-user-
 *  per-win. Self-congrulate is allowed at the data layer; the route forbids it. */
export async function congratulate(db: D1Database, shareId: string, userId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO congratulations (share_id, user_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(share_id, user_id) DO NOTHING`,
    )
    .bind(shareId, userId, NOW())
    .run();
}

export async function unCongratulate(db: D1Database, shareId: string, userId: string): Promise<void> {
  await db
    .prepare(`DELETE FROM congratulations WHERE share_id = ? AND user_id = ?`)
    .bind(shareId, userId)
    .run();
}

export async function congratsCount(db: D1Database, shareId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM congratulations WHERE share_id = ?`)
    .bind(shareId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---- win promotion (settle sweep → share feed entry) -----------------------

/**
 * Phase 3 win promotion — called by the settle sweep when a ticket settles.
 * If the ticket has an active share:
 *   - settling to 'won'  → flip shares.is_win=1 + fan out friends_ticket_won to
 *     the audience (once — guarded by the is_win flip so re-sweeps don't spam).
 *   - a correction away from 'won' → clear is_win (silent).
 * A ticket has at most one active share (partial unique idx), so no owner arg.
 */
export async function promoteShareWin(db: D1Database, ticketId: string, isWin: boolean): Promise<void> {
  const share = await db
    .prepare(`SELECT * FROM shares WHERE ticket_id = ? AND retracted_at IS NULL`)
    .bind(ticketId)
    .first<ShareRow>();
  if (!share) return;
  if (isWin && !share.is_win) {
    await db.prepare(`UPDATE shares SET is_win = 1 WHERE id = ?`).bind(share.id).run();
    const audience = await getShareAudience(db, { ...share, is_win: 1 });
    for (const uid of audience) {
      await insertNotification(db, {
        userId: uid,
        type: "friends_ticket_won",
        actorId: share.owner_id,
        subjectType: "share",
        subjectId: share.id,
      });
    }
  } else if (!isWin && share.is_win) {
    await db.prepare(`UPDATE shares SET is_win = 0 WHERE id = ?`).bind(share.id).run();
  }
}

// ---- feed ------------------------------------------------------------------

/**
 * The friend feed: the viewer's OWN live shares plus their mutual friends' live
 * shares visible to the viewer (all_friends, or selected with viewer in the
 * audience), excluding blocked pairs. Own shares are always visible (the owner
 * is their own audience) and flagged `is_own`. Reverse-chronological, cap 100.
 *
 * Replaces the legacy auto-feed (clean cut): only explicitly-shared tickets.
 */
export async function buildShareFeed(db: D1Database, viewerId: string): Promise<FeedItem[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.ticket_id, s.owner_id, s.audience_mode, s.snapshot, s.is_win,
              s.retracted_at, s.created_at,
              u.handle AS owner_handle, u.display_name AS owner_display_name, u.avatar AS owner_avatar,
              t.cost AS ticket_cost, t.returned AS ticket_returned,
              COALESCE(cg.n, 0) AS congrats_count,
              (cgme.share_id IS NOT NULL) AS congratulated_by_me,
              COALESCE(cm.n, 0) AS comment_count
         FROM shares s
         JOIN users u ON u.id = s.owner_id
         LEFT JOIN tickets t ON t.id = s.ticket_id
         LEFT JOIN (SELECT share_id, COUNT(*) AS n FROM congratulations GROUP BY share_id) cg ON cg.share_id = s.id
         LEFT JOIN congratulations cgme ON cgme.share_id = s.id AND cgme.user_id = ?
         LEFT JOIN (SELECT share_id, COUNT(*) AS n FROM comments WHERE deleted_at IS NULL GROUP BY share_id) cm ON cm.share_id = s.id
        WHERE s.retracted_at IS NULL
          AND (
                s.owner_id = ?
                OR (
                  s.owner_id IN (
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
                            OR (blocker_id = s.owner_id AND blocked_id = ?))
                )
          )
        ORDER BY s.created_at DESC
        LIMIT 100`,
    )
    // bind order: cgme.user_id (LEFT JOIN), own-share, mutual-source, mutual-target,
    // share_audience, blocks×2 — all viewer. (7 binds, same arity as before: the
    // former `owner_id <> ?` became `owner_id = ?` inside the OR.)
    .bind(viewerId, viewerId, viewerId, viewerId, viewerId, viewerId, viewerId)
    .all<FeedRow>();
  return results.map((row) => decodeFeedItem(row, viewerId));
}

/** Detail view of a single share (deep-link target). Viewer must be in the
 *  audience or be the owner; visibility is enforced at the route layer. */
export async function getShareForViewer(
  db: D1Database,
  shareId: string,
  viewerId: string,
): Promise<FeedItem | null> {
  const row = await db
    .prepare(
      `SELECT s.id, s.ticket_id, s.owner_id, s.audience_mode, s.snapshot, s.is_win,
              s.retracted_at, s.created_at,
              u.handle AS owner_handle, u.display_name AS owner_display_name, u.avatar AS owner_avatar,
              t.cost AS ticket_cost, t.returned AS ticket_returned,
              COALESCE(cg.n, 0) AS congrats_count,
              (cgme.share_id IS NOT NULL) AS congratulated_by_me,
              COALESCE(cm.n, 0) AS comment_count
         FROM shares s
         JOIN users u ON u.id = s.owner_id
         LEFT JOIN tickets t ON t.id = s.ticket_id
         LEFT JOIN (SELECT share_id, COUNT(*) AS n FROM congratulations GROUP BY share_id) cg ON cg.share_id = s.id
         LEFT JOIN congratulations cgme ON cgme.share_id = s.id AND cgme.user_id = ?
         LEFT JOIN (SELECT share_id, COUNT(*) AS n FROM comments WHERE deleted_at IS NULL GROUP BY share_id) cm ON cm.share_id = s.id
        WHERE s.id = ? AND s.retracted_at IS NULL`,
    )
    .bind(viewerId, shareId)
    .first<FeedRow>();
  if (!row) return null;
  return decodeFeedItem(row, viewerId);
}

/** Does `viewerId` satisfy this share's audience? (owner always sees own share.) */
export async function shareVisibleTo(db: D1Database, share: ShareRow, viewerId: string): Promise<boolean> {
  if (share.owner_id === viewerId) return true;
  if (share.retracted_at !== null) return false;
  const friends = await areFriends(db, share.owner_id, viewerId);
  if (!friends) return false;
  if (share.audience_mode === "all_friends") return true;
  const row = await db
    .prepare(`SELECT 1 FROM share_audience WHERE share_id = ? AND user_id = ?`)
    .bind(share.id, viewerId)
    .first<{ "1": number }>();
  return !!row;
}

function decodeFeedItem(row: FeedRow, viewerId: string): FeedItem {
  let ticket: Record<string, unknown> | null = null;
  try {
    ticket = JSON.parse(row.snapshot) as Record<string, unknown>;
  } catch {
    ticket = null;
  }
  const isWin = !!row.is_win;
  // Win framing = multiplier (returned/cost), NOT currency. Rounded to 1 dp.
  const multiplier =
    isWin && typeof row.ticket_returned === "number" && typeof row.ticket_cost === "number" && row.ticket_cost > 0
      ? Math.round((row.ticket_returned / row.ticket_cost) * 10) / 10
      : null;
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    ticket,
    owner: {
      id: row.owner_id,
      handle: row.owner_handle,
      display_name: row.owner_display_name,
      avatar: row.owner_avatar,
    },
    audience_mode: row.audience_mode as AudienceMode,
    is_own: row.owner_id === viewerId,
    is_win: isWin,
    multiplier,
    congrats_count: row.congrats_count ?? 0,
    congratulated_by_me: !!row.congratulated_by_me,
    comment_count: row.comment_count ?? 0,
    created_at: row.created_at,
  };
}

/** Parse + validate a share body's audience spec. Returns null on invalid. */
export function parseAudience(body: unknown): { mode: AudienceMode; selected: string[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { mode?: unknown; selected?: unknown };
  if (typeof b.mode !== "string" || !AUDIENCE_MODES.has(b.mode as never)) return null;
  const mode = b.mode as AudienceMode;
  let selected: string[] = [];
  if (mode === "selected") {
    if (!Array.isArray(b.selected)) return null;
    selected = b.selected.filter((s): s is string => typeof s === "string" && s.length > 0);
    // selected requires at least one recipient (validated to friends later).
    if (selected.length === 0) return null;
  }
  return { mode, selected };
}
