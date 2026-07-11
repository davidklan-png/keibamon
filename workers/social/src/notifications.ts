// Friend Interactions — notification log, WRITE side only.
//
// The notifications table (migrations/0011) ships in Phase 1 because friend
// events record notifications now ("sending a request notifies the recipient").
// Phase 4 adds the BELL: listNotifications + unreadCount + markRead/markAllRead
// + a 90-day retention sweep. Those live here when their phase lands.
//
// InsertNotification is intentionally tiny and fire-and-forget: callers fan out
// notifications AFTER the load-bearing mutation has committed, and a failed
// insert (e.g. transient D1 error) MUST NOT fail the user's action — a missed
// bell is a lesser evil than a dropped friend-request. Errors are swallowed and
// logged via the returned boolean so callers can observe in tests.

import { NOTIF_SUBJECT_TYPES, NOTIF_TYPES, NOW } from "./core";

export interface NewNotification {
  userId: string;
  type: string;
  actorId: string | null;
  subjectType: string;
  subjectId: string;
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
