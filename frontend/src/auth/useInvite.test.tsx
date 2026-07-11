// @vitest-environment jsdom
// ============================================================================
// useInvite — HOOK-layer tests (Social UX Fixes, Phase C).
//
// The pure resolver + persistence helpers are pinned in inviteResolver.test.ts.
// This file exercises the hook's DEFERRED-PATH orchestration end-to-end: a
// logged-out stranger opens ?friend=alyssa → "Sign in to add" interstitial →
// (simulated signup + handle setup) → re-resolves to "Add" → one tap →
// friendship toast. Mocks only socialClient's getProfile + acceptInvite; the
// resolver + sessionStorage persistence run for real.
//
// Harness pattern: real createRoot + <Harness/> + React 19 act(), mirroring
// impressionsSync.hook.test.tsx (no @testing-library in this repo).
// ============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";

// React 19 act() needs this flag to flush effects synchronously in tests.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock only the network layer; the resolver + persistence run for real.
vi.mock("./socialClient", () => ({
  getProfile: vi.fn(),
  acceptInvite: vi.fn(),
}));
import { useInvite } from "./useInvite";
import { getProfile, acceptInvite } from "./socialClient";
import { INVITE_STORAGE_KEY } from "./inviteResolver";

const mockedGetProfile = vi.mocked(getProfile);
const mockedAcceptInvite = vi.mocked(acceptInvite);

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Flush microtasks inside act() so the hook's async setStates are absorbed
 *  without the "update not wrapped in act" warning. */
async function actFlush(): Promise<void> {
  await React.act(async () => {
    await flushMicrotasks();
  });
}

interface HarnessApi {
  invite: ReturnType<typeof useInvite>;
  setIsSignedIn: (v: boolean) => void;
  setHasHandle: (v: boolean) => void;
}

function makeHarness(apiRef: { current: HarnessApi | null }) {
  function Harness() {
    const [isSignedIn, setIsSignedIn] = React.useState(false);
    const [hasHandle, setHasHandle] = React.useState(false);
    const getToken = React.useCallback(async () => "test.jwt", []);
    const invite = useInvite({ getToken, isSignedIn, hasHandle });
    apiRef.current = { invite, setIsSignedIn, setHasHandle };
    return null;
  }
  return Harness;
}

function renderHarness() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const apiRef: { current: HarnessApi | null } = { current: null };
  const Harness = makeHarness(apiRef);
  React.act(() => {
    root.render(<Harness />);
  });
  return {
    apiRef,
    cleanup: () => {
      React.act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function setUrl(search: string): void {
  window.history.replaceState(null, "", search ? `/${search}` : "/");
}

describe("useInvite — deferred deep-link path (Phase C)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    setUrl("?friend=alyssa");
    mockedGetProfile.mockReset();
    mockedAcceptInvite.mockReset();
  });
  afterEach(() => {
    sessionStorage.clear();
    setUrl("");
  });

  it("stranger → stashes invite → 'Sign in to add' interstitial; survives into signup", async () => {
    mockedGetProfile.mockResolvedValue({
      ok: true,
      data: { id: "u-a", handle: "alyssa", display_name: "Alyssa", avatar: null, friendship: "none", created_at: 0 },
    });
    const { apiRef, cleanup } = renderHarness();
    await actFlush();

    // Signed-out → "none" → signin interstitial.
    expect(apiRef.current!.invite.interstitial?.mode).toBe("signin");
    expect(apiRef.current!.invite.interstitial?.handle).toBe("alyssa");
    // The invite is stashed BEFORE any redirect (survives the OAuth round-trip).
    expect(sessionStorage.getItem(INVITE_STORAGE_KEY)).toBe("alyssa");

    cleanup();
  });

  it("after signup + handle setup, re-resolves to 'Add' → one tap → friendship toast", async () => {
    mockedGetProfile.mockResolvedValue({
      ok: true,
      data: { id: "u-a", handle: "alyssa", display_name: "Alyssa", avatar: null, friendship: "none", created_at: 0 },
    });
    mockedAcceptInvite.mockResolvedValue({ ok: true, data: { transition: "created", now_friends: true } });

    const { apiRef, cleanup } = renderHarness();
    await actFlush();
    expect(apiRef.current!.invite.interstitial?.mode).toBe("signin");

    // Simulate: user signed in + completed handle setup (Phase B gate passes).
    React.act(() => {
      apiRef.current!.setIsSignedIn(true);
      apiRef.current!.setHasHandle(true);
    });
    await actFlush();

    // Re-resolved signed-in → "Add" interstitial (friendship none).
    expect(apiRef.current!.invite.interstitial?.mode).toBe("add");
    expect(apiRef.current!.invite.toast).toBeNull();
    // The invite persisted through the auth + handle phase.
    expect(sessionStorage.getItem(INVITE_STORAGE_KEY)).toBe("alyssa");

    // One tap → acceptInvite → friendship formed.
    await React.act(async () => {
      await apiRef.current!.invite.accept();
    });
    await actFlush();

    expect(apiRef.current!.invite.interstitial).toBeNull();
    expect(apiRef.current!.invite.toast).toEqual({ kind: "added", handle: "alyssa" });
    // Consumed: stash + URL cleared.
    expect(sessionStorage.getItem(INVITE_STORAGE_KEY)).toBeNull();

    cleanup();
  });

  it("already friends → auto-resolves to 'already friends' toast, no interstitial", async () => {
    mockedGetProfile.mockResolvedValue({
      ok: true,
      data: { id: "u-a", handle: "alyssa", display_name: "Alyssa", avatar: null, friendship: "friends", created_at: 0 },
    });
    const { apiRef, cleanup } = renderHarness();
    // Signed-in-with-handle from the start.
    React.act(() => {
      apiRef.current!.setIsSignedIn(true);
      apiRef.current!.setHasHandle(true);
    });
    await actFlush();

    expect(apiRef.current!.invite.interstitial).toBeNull();
    expect(apiRef.current!.invite.toast).toEqual({ kind: "already", handle: "alyssa" });
    expect(sessionStorage.getItem(INVITE_STORAGE_KEY)).toBeNull();

    cleanup();
  });

  it("pending request either direction → auto-accept → 'added' toast", async () => {
    mockedGetProfile.mockResolvedValue({
      ok: true,
      data: { id: "u-a", handle: "alyssa", display_name: "Alyssa", avatar: null, friendship: "pending_incoming", created_at: 0 },
    });
    mockedAcceptInvite.mockResolvedValue({ ok: true, data: { transition: "created", now_friends: true } });
    const { apiRef, cleanup } = renderHarness();
    React.act(() => {
      apiRef.current!.setIsSignedIn(true);
      apiRef.current!.setHasHandle(true);
    });
    await actFlush();

    expect(apiRef.current!.invite.toast).toEqual({ kind: "added", handle: "alyssa" });
    expect(mockedAcceptInvite).toHaveBeenCalledWith("test.jwt", "alyssa");

    cleanup();
  });

  it("unknown handle (404) → friendly not-found, invite consumed (no leak)", async () => {
    mockedGetProfile.mockResolvedValue({ ok: false, err: { kind: "http", status: 404 } });
    const { apiRef, cleanup } = renderHarness();
    React.act(() => {
      apiRef.current!.setIsSignedIn(true);
      apiRef.current!.setHasHandle(true);
    });
    await actFlush();

    expect(apiRef.current!.invite.notFound).toEqual({ handle: "alyssa" });
    expect(apiRef.current!.invite.interstitial).toBeNull();
    expect(sessionStorage.getItem(INVITE_STORAGE_KEY)).toBeNull();

    cleanup();
  });

  it("a stashed invite (no URL param) is picked up on boot — survives a redirect that dropped ?friend=", async () => {
    // Simulate the post-redirect state: the URL lost the param, but the stash held it.
    sessionStorage.setItem(INVITE_STORAGE_KEY, "alyssa");
    setUrl("");
    mockedGetProfile.mockResolvedValue({
      ok: true,
      data: { id: "u-a", handle: "alyssa", display_name: "Alyssa", avatar: null, friendship: "friends", created_at: 0 },
    });
    const { apiRef, cleanup } = renderHarness();
    React.act(() => {
      apiRef.current!.setIsSignedIn(true);
      apiRef.current!.setHasHandle(true);
    });
    await actFlush();

    // The stashed invite resolved (already-friends toast) even with no URL param.
    expect(apiRef.current!.invite.toast).toEqual({ kind: "already", handle: "alyssa" });

    cleanup();
  });
});
