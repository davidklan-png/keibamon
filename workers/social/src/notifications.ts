// Friend Interactions — notification log. WRITE side (Phase 1-3) + READ side
// (Phase 4: the bell). The notifications table (migrations/0011) shipped early
// because social events record notifications as they happen; Phase 4 surfaces
// them: listNotifications + unreadCount + markRead/markAllRead + a 90-day
// retention prune (ridden on the existing settle sweep cron).
//
// InsertNotification is intentionally tiny and fire-and-forget: callers fan out
// notifications AFTER the load-bearing mutation has committed, and a failed
// insert (e.g. transient D1 error) MUST NOT fail the user's action — a missed
// bell is a lesser evil than a dropped friend-request. Errors are swallowed and
// logged via the returned boolean so callers can observe in tests.

import { NOTIF_SUBJECT_TYPES, NOTIF_TYPES, NOW, NotificationRow } from "./core";

export interface NewNotification {
  userId: string;
  type: string;
  actorId: string | null;
  subjectType: string;
  subjectId: string;
}

/** A notification joined with its actor's public fields (for the bell list). */
export interface NotificationView {
  id: string;
  type: string;
  actor_id: string | null;
  actor_handle: string | null;
  actor_display_name: string | null;
  actor_avatar: string | null;
  subject_type: string;
  subject_id: string;
  created_at: number;
  read_at: number | null;
}

/**
 * Append one notification row. Returns true on success, false on any error
 * (bad enum, D1 failure) — callers ignore the result for user-facing flows.
 */
export async function insertNotification(
  db: D1Database,
  n: NewNotification,
): Promise<boolean> {
  if (!NOTIF_TYPES.has(n.type as never)) return false;
  if (!NOTIF_SUBJECT_TYPES.has(n.subjectType as never)) return false;
  try {
    await db
      .prepare(
        `INSERT INTO notifications (id, user_id, type, actor_id, subject_type, subject_id, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(crypto.randomUUID(), n.userId, n.type, n.actorId, n.subjectType, n.subjectId, NOW())
      .run();
    return true;
  } catch {
    return false;
  }
}

// ---- READ side (Phase 4 bell) ---------------------------------------------

/** The bell list: newest-first, cap 50, with the actor's public fields. */
export async function listNotifications(db: D1Database, userId: string): Promise<NotificationView[]> {
  const { results } = await db
    .prepare(
      `SELECT n.id, n.type, n.actor_id, n.subject_type, n.subject_id, n.created_at, n.read_at,
              u.handle AS actor_handle, u.display_name AS actor_display_name, u.avatar AS actor_avatar
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC
        LIMIT 50`,
    )
    .bind(userId)
    .all<NotificationRow & { actor_handle: string | null; actor_display_name: string | null; actor_avatar: string | null }>();
  return results.map((r) => ({
    id: r.id,
    type: r.type,
    actor_id: r.actor_id,
    actor_handle: r.actor_handle,
    actor_display_name: r.actor_display_name,
    actor_avatar: r.actor_avatar,
    subject_type: r.subject_type,
    subject_id: r.subject_id,
    created_at: r.created_at,
    read_at: r.read_at,
  }));
}

/** Unread count for the bell badge. */
export async function unreadCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Mark one notification read (owner-scoped; idempotent). */
export async function markRead(db: D1Database, userId: string, id: string): Promise<void> {
  await db
    .prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`)
    .bind(NOW(), id, userId)
    .run();
}

/** Mark all of the caller's notifications read. */
export async function markAllRead(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`)
    .bind(NOW(), userId)
    .run();
}

/**
 * 90-day retention prune — ridden on the settle sweep cron so no new timer is
 * needed. Best-effort: a failure must never block settlement. Returns the count
 * deleted (for observability).
 */
export async function pruneOldNotifications(db: D1Database): Promise<number> {
  const cutoff = NOW() - 90 * 24 * 60 * 60;
  try {
    const { meta } = await db
      .prepare(`DELETE FROM notifications WHERE created_at < ?`)
      .bind(cutoff)
      .run();
    return (meta as { changes?: number } | null)?.changes ?? 0;
  } catch {
    return 0;
  }
}

