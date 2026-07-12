// NotificationBell — Friend Interactions Phase 4.
//
// The global bell: an unread badge + a panel listing recent notifications.
// Self-contained (fetches its own unread count on mount + a 60s interval, and
// the list when opened) so it can mount in any header without prop-drilling the
// count. Tap an item → mark-it-read + onDeepLink(n) (the parent maps the type to
// a screen). Opening the panel marks what it displays as read (bubble = "new
// since last look") — it zeroes optimistically and reconciles from the next
// poll; the explicit mark-all button shares the same path. In-app only
// (push-ready schema, no push in v1). ~90-day retention is server-side (the
// sweep cron prunes).
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  getNotifications,
  getUnreadCount,
  markNotificationsRead,
  type NotificationView,
} from "../auth/socialClient";

export interface NotificationBellProps {
  getToken: () => Promise<string | null>;
  /** Map a notification to a navigation (parent decides the screen). */
  onDeepLink: (n: NotificationView) => void;
}

export function NotificationBell({ getToken, onDeepLink }: NotificationBellProps) {
  const { t, tFmt } = useI18n();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<NotificationView[] | null>(null);
  // True while a mark-on-open / mark-all is in flight (open → server mark →
  // reconcile). Suppresses stale 60s-poll responses issued before the server's
  // markAll landed, so a cleared bubble can't resurrect after the user looked.
  const markingRef = useRef(false);

  const refreshCount = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await getUnreadCount(token);
    // Drop a count that predates an in-flight mark — the bubble already zeroed
    // optimistically and the mark's own reconcile is authoritative.
    if (r.ok && !markingRef.current) setCount(r.data.count);
  }, [getToken]);

  useEffect(() => {
    void refreshCount();
    const id = window.setInterval(() => void refreshCount(), 60000);
    return () => window.clearInterval(id);
  }, [refreshCount]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const token = await getToken();
    if (!token) return;
    const r = await getNotifications(token);
    setList(r.ok ? r.data : []);
    // Opening the panel marks what it displays as read — the bubble is
    // "new since last look," so it clears once the user has looked. Fires the
    // existing server markAll path; the count zeroes optimistically and is
    // reconciled by the read after the mark lands.
    void markViewed();
  }

  /**
   * Mark everything currently visible as read (used by both panel-open and the
   * explicit "mark all read" button). Zeroes the badge optimistically, marks
   * server-side, then reconciles from the server. `markingRef` spans the whole
   * sequence so a stale 60s poll (or a concurrent re-open) can't resurrect the
   * cleared badge before the server reflects the mark.
   */
  async function markViewed() {
    setCount(0);
    markingRef.current = true;
    const token = await getToken();
    if (!token) {
      markingRef.current = false;
      return;
    }
    await markNotificationsRead(token);
    markingRef.current = false;
    setList((prev) => (prev ?? []).map((n) => ({ ...n, read_at: n.read_at ?? 1 })));
    // Reconcile: reads 0 (just marked), or any count for notifications newer
    // than this view. Suppressed if a newer view began in the meantime.
    const ur = await getUnreadCount(token);
    if (ur.ok && !markingRef.current) setCount(ur.data.count);
  }

  async function openItem(n: NotificationView) {
    const token = await getToken();
    if (token && n.read_at == null) {
      await markNotificationsRead(token, n.id);
      setCount((c) => Math.max(0, c - 1));
      setList((prev) => (prev ?? []).map((x) => (x.id === n.id ? { ...x, read_at: 1 } : x)));
    }
    setOpen(false);
    onDeepLink(n);
  }

  return (
    <div className="notif-bell">
      <button
        type="button"
        className="notif-bell-btn lang-toggle"
        onClick={() => void toggle()}
        aria-label={t("notifications.title")}
      >
        <span aria-hidden="true">🔔</span>
        {count > 0 && <span className="notif-badge">{count > 9 ? "9+" : count}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label={t("notifications.title")}>
          <div className="notif-panel-head">
            <strong>{t("notifications.title")}</strong>
            {count > 0 && (
              <button className="notif-mark-all" onClick={() => void markViewed()}>
                {t("notifications.markAllRead")}
              </button>
            )}
          </div>
          {list === null && <p className="empty">…</p>}
          {list !== null && list.length === 0 && (
            <p className="empty">{t("notifications.empty")}</p>
          )}
          {(list ?? []).map((n) => {
            const who = n.actor_handle ? `@${n.actor_handle}` : n.actor_display_name ?? "";
            const text = tFmt(`notifications.${n.type}`, { who });
            return (
              <button
                key={n.id}
                type="button"
                className={`notif-row${n.read_at == null ? " unread" : ""}`}
                onClick={() => void openItem(n)}
              >
                <span className="notif-text">{text}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
