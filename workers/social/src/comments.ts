// Friend Interactions Phase 3 — comments.
//
// Single-level (no nesting in v1), anchored to a SHARE so they're audience-
// scoped and a retract hides them with it. Soft-delete backs owner-deletes-any
// + author-deletes-own. The route enforces audience membership (viewer must be
// in the share's audience to read/write); this module is the data layer.

import { NOW } from "./core";

export interface CommentRow {
  id: string;
  share_id: string;
  author_id: string;
  body: string;
  created_at: number;
  deleted_at: number | null;
}

export interface CommentView {
  id: string;
  share_id: string;
  author: { id: string; handle: string | null; display_name: string | null; avatar: string | null };
  /** Empty string when soft-deleted (the card renders a "[deleted]" placeholder). */
  body: string;
  created_at: number;
  deleted: boolean;
  /** True when the viewer authored the comment (author-delete affordance). */
  mine: boolean;
}

/** Insert a comment. Returns null on CHECK (body length) / FK violation. */
export async function addComment(
  db: D1Database,
  shareId: string,
  authorId: string,
  body: string,
): Promise<CommentRow | null> {
  const id = crypto.randomUUID();
  const now = NOW();
  try {
    await db
      .prepare(
        `INSERT INTO comments (id, share_id, author_id, body, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(id, shareId, authorId, body, now)
      .run();
  } catch {
    return null;
  }
  return { id, share_id: shareId, author_id: authorId, body, created_at: now, deleted_at: null };
}

/** List a share's comments oldest-first (single-level thread). Deleted comments
 *  are kept (so counts/reply context stay coherent) with body cleared. */
export async function listComments(db: D1Database, shareId: string, viewerId: string): Promise<CommentView[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.share_id, c.author_id, c.body, c.created_at, c.deleted_at,
              u.handle AS author_handle, u.display_name AS author_display_name, u.avatar AS author_avatar
         FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.share_id = ?
        ORDER BY c.created_at ASC`,
    )
    .bind(shareId)
    .all<CommentRow & { author_handle: string | null; author_display_name: string | null; author_avatar: string | null }>();
  return results.map((r) => ({
    id: r.id,
    share_id: r.share_id,
    author: {
      id: r.author_id,
      handle: r.author_handle,
      display_name: r.author_display_name,
      avatar: r.author_avatar,
    },
    body: r.deleted_at ? "" : r.body,
    created_at: r.created_at,
    deleted: !!r.deleted_at,
    mine: r.author_id === viewerId,
  }));
}

/**
 * Soft-delete a comment. `actorId` may delete if they are the AUTHOR or the
 * share OWNER (owner-deletes-any). Returns true iff a row was deleted.
 */
export async function deleteComment(
  db: D1Database,
  commentId: string,
  actorId: string,
  shareOwnerId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT author_id FROM comments WHERE id = ?`)
    .bind(commentId)
    .first<{ author_id: string }>();
  if (!row) return false;
  if (row.author_id !== actorId && shareOwnerId !== actorId) return false;
  const { meta } = await db
    .prepare(`UPDATE comments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .bind(NOW(), commentId)
    .run();
  return ((meta as { changes?: number } | null)?.changes ?? 0) > 0;
}

/** Count of live (non-deleted) comments on a share — for the feed/card badge. */
export async function commentCount(db: D1Database, shareId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM comments WHERE share_id = ? AND deleted_at IS NULL`)
    .bind(shareId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Fetch a comment's {share_id, author_id} — enough for the delete route to
 *  resolve the share owner (owner-deletes-any) without leaking body content. */
export async function getComment(
  db: D1Database,
  commentId: string,
): Promise<{ id: string; share_id: string; author_id: string } | null> {
  return db
    .prepare(`SELECT id, share_id, author_id FROM comments WHERE id = ?`)
    .bind(commentId)
    .first<{ id: string; share_id: string; author_id: string }>();
}

/** Distinct prior commenters on a share (excluding `except`), for the
 *  "comment on a ticket you commented on" reply notification. */
export async function priorCommenters(db: D1Database, shareId: string, except: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT author_id FROM comments
        WHERE share_id = ? AND deleted_at IS NULL AND author_id <> ?`,
    )
    .bind(shareId, except)
    .all<{ author_id: string }>();
  return results.map((r) => r.author_id);
}
