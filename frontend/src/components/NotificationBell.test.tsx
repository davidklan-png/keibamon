// @vitest-environment jsdom
//
// NotificationBell — mark-on-open behavior (badge = "new since last look").
// jsdom + createRoot/act because this is interactive (open → server mark →
// reconcile), not an SSR render contract. socialClient is mocked via
// vi.hoisted so the factory can share a mutable unread-count across the mount
// poll, the mark, and the reconcile (simulating D1 consistency: marking read
// drops the server's unread count to 0).
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { setLang } from "../i18n";
import { NotificationBell } from "./NotificationBell";

// React's act() needs this flag set to skip its "not configured" warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { state, mocks } = vi.hoisted(() => ({
  // Mutable unread count; the mark mock flips it to 0 (server consistent).
  state: { unreadCount: 3 },
  mocks: {
    getNotifications: vi.fn(),
    getUnreadCount: vi.fn(),
    markNotificationsRead: vi.fn(),
  },
}));

vi.mock("../auth/socialClient", () => mocks);

beforeEach(() => {
  setLang("en");
  state.unreadCount = 3;
  mocks.getNotifications.mockImplementation(async () => ({
    ok: true,
    data: [
      {
        id: "n1",
        type: "comment_on_your_ticket",
        actor_handle: "rin",
        actor_display_name: "Rin",
        read_at: null,
      },
    ],
  }));
  mocks.getUnreadCount.mockImplementation(async () => ({
    ok: true,
    data: { count: state.unreadCount },
  }));
  mocks.markNotificationsRead.mockImplementation(async () => {
    state.unreadCount = 0; // server-side mark → unread drops to 0
    return { ok: true };
  });
  mocks.markNotificationsRead.mockClear();
  document.body.innerHTML = "";
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

function renderBell() {
  const root = createRoot(document.body);
  return root;
}

describe("NotificationBell — mark-on-open", () => {
  it("shows the unread count on mount", async () => {
    const root = renderBell();
    await act(async () => {
      root.render(
        <NotificationBell getToken={() => Promise.resolve("tok")} onDeepLink={() => {}} />,
      );
    });
    await flush();
    expect(document.querySelector(".notif-badge")?.textContent).toBe("3");
    root.unmount();
  });

  it("clears the badge + marks read server-side when the panel opens", async () => {
    const root = renderBell();
    await act(async () => {
      root.render(
        <NotificationBell getToken={() => Promise.resolve("tok")} onDeepLink={() => {}} />,
      );
    });
    await flush();
    expect(document.querySelector(".notif-badge")?.textContent).toBe("3");

    // Open the panel.
    await act(async () => {
      (document.querySelector(".notif-bell-btn") as HTMLElement).click();
    });
    await flush();

    // Server-side mark fired (the existing markAll path).
    expect(mocks.markNotificationsRead).toHaveBeenCalled();
    // Bubble cleared — the user has now "looked."
    expect(document.querySelector(".notif-badge")).toBeNull();
    root.unmount();
  });

  it("stays cleared: the next poll reconciles to the post-mark count, not the stale one", async () => {
    // Use fake timers to drive the 60s interval. After viewing, the interval's
    // refreshCount reads the post-mark count (0); the markingRef guard also
    // suppresses any stale response issued during the mark window.
    vi.useFakeTimers();
    try {
      const root = renderBell();
      await act(async () => {
        root.render(
          <NotificationBell getToken={() => Promise.resolve("tok")} onDeepLink={() => {}} />,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(document.querySelector(".notif-badge")?.textContent).toBe("3");

      // View → marks read → badge clears.
      await act(async () => {
        (document.querySelector(".notif-bell-btn") as HTMLElement).click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(document.querySelector(".notif-badge")).toBeNull();

      // Advance past the 60s poll. The server now reads 0 (marked), so the
      // badge must NOT resurrect.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(document.querySelector(".notif-badge")).toBeNull();
      root.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
