// notifDeepLinkTarget — classification of a notification tap into a deep-link
// target. Pure; pins the routing so App's handler stays a thin wrapper.
import { describe, it, expect } from "vitest";
import { notifDeepLinkTarget } from "./notifDeepLink";

const N = (type: string, subject_type: string, subject_id = "sh-1") => ({
  type,
  subject_type,
  subject_id,
});

describe("notifDeepLinkTarget", () => {
  it("routes owner-side share notifications to ownerShare (→ My Tickets detail)", () => {
    expect(notifDeepLinkTarget(N("congratulation_received", "share"))).toEqual({
      kind: "ownerShare",
      subjectId: "sh-1",
    });
    expect(notifDeepLinkTarget(N("comment_on_your_ticket", "share"))).toEqual({
      kind: "ownerShare",
      subjectId: "sh-1",
    });
  });

  it("routes friend-side share notifications to friendShare (→ Friends share-detail)", () => {
    expect(notifDeepLinkTarget(N("ticket_shared_with_you", "share"))).toEqual({
      kind: "friendShare",
      subjectId: "sh-1",
    });
    expect(notifDeepLinkTarget(N("friends_ticket_won", "share"))).toEqual({
      kind: "friendShare",
      subjectId: "sh-1",
    });
    expect(notifDeepLinkTarget(N("comment_on_ticket_you_commented", "share"))).toEqual({
      kind: "friendShare",
      subjectId: "sh-1",
    });
  });

  it("routes friend-request notifications to friendRequest (→ Friends list)", () => {
    expect(notifDeepLinkTarget(N("friend_request_received", "user", "u-1"))).toEqual({
      kind: "friendRequest",
    });
    expect(notifDeepLinkTarget(N("friend_request_accepted", "user", "u-1"))).toEqual({
      kind: "friendRequest",
    });
  });

  it("falls back to the Friends tab for a non-share / non-request subject", () => {
    expect(notifDeepLinkTarget(N("something", "ticket", "tk-1"))).toEqual({ kind: "fallback" });
    expect(notifDeepLinkTarget(N("something", "user", "u-9"))).toEqual({ kind: "fallback" });
  });

  it("treats an unknown share type as friendShare — the subject is still a share to open", () => {
    expect(notifDeepLinkTarget(N("mystery_type", "share"))).toEqual({
      kind: "friendShare",
      subjectId: "sh-1",
    });
  });

  it("does not treat a share without a subject_id as navigable (→ fallback)", () => {
    expect(notifDeepLinkTarget(N("friends_ticket_won", "share", ""))).toEqual({
      kind: "fallback",
    });
  });
});
