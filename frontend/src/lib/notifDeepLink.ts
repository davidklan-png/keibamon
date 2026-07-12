/**
 * Notification deep-link routing — maps a notification to the screen + subject
 * the bell should open when the user taps it ("see the event immediately,"
 * not just a tab switch).
 *
 * Kept pure + decoupled from NotificationView so the classification is unit-
 * testable without rendering App. App's async handler consumes the result:
 * ownerShare needs a share→ticket resolution (getShare) before opening the
 * My Tickets detail; the others route directly.
 *
 * Split rationale:
 *   - ownerShare (your own share: congratulation_received, comment_on_your_ticket)
 *     → the owner engagement surface (My Tickets detail), matching Item 4's
 *     own-share routing.
 *   - friendShare (a friend's share: shared/won/commented-on) → the Friends
 *     share-detail pane for subject_id.
 *   - friendRequest → the Friends list so the user can accept/see the person.
 *   - fallback → the Friends tab (feed).
 */
export type NotifDeepLink =
  | { kind: "ownerShare"; subjectId: string }
  | { kind: "friendShare"; subjectId: string }
  | { kind: "friendRequest" }
  | { kind: "fallback" };

/** The notification shape this router needs (structural — any supertype works). */
export interface NotifLike {
  type: string;
  subject_type: string;
  subject_id: string;
}

const OWNER_SHARE_TYPES = new Set(["congratulation_received", "comment_on_your_ticket"]);

export function notifDeepLinkTarget(n: NotifLike): NotifDeepLink {
  const sid = n.subject_id;
  if (n.subject_type === "share" && sid) {
    return OWNER_SHARE_TYPES.has(n.type)
      ? { kind: "ownerShare", subjectId: sid }
      : { kind: "friendShare", subjectId: sid };
  }
  if (
    n.type === "friend_request_received" ||
    n.type === "friend_request_accepted" ||
    n.subject_type === "friend_request"
  ) {
    return { kind: "friendRequest" };
  }
  return { kind: "fallback" };
}
