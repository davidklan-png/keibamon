// @vitest-environment jsdom
// Invite resolver unit tests (Social UX Fixes, Phase C).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resolveInvite,
  stashInvite,
  readStashedInvite,
  clearStashedInvite,
  stripInviteFromUrl,
  INVITE_STORAGE_KEY,
} from "./inviteResolver";

describe("invite resolver state machine (Phase C) — all five states", () => {
  it("none → interstitial (show the Add card)", () => {
    expect(resolveInvite("none", "alyssa")).toEqual({ kind: "interstitial", handle: "alyssa" });
  });

  it("friends → already_friends (toast + Friends tab, no add)", () => {
    expect(resolveInvite("friends", "alyssa")).toEqual({ kind: "already_friends", handle: "alyssa" });
  });

  it("pending either direction → accept_pending (one-tap accept)", () => {
    expect(resolveInvite("pending", "alyssa")).toEqual({ kind: "accept_pending", handle: "alyssa" });
  });

  it("blocked → silent (no-op, no leak — no handle echoed)", () => {
    const action = resolveInvite("blocked", "alyssa");
    expect(action).toEqual({ kind: "silent" });
    // Silent must NOT echo the handle (would leak that the handle exists).
    expect(JSON.stringify(action)).not.toContain("alyssa");
  });

  it("unknown → not_found (friendly error)", () => {
    expect(resolveInvite("unknown", "alyssa")).toEqual({ kind: "not_found", handle: "alyssa" });
  });
});

// Deferred-context persistence — must survive the OAuth round-trip + the
// handle-setup step (sessionStorage is the store; the URL param is the source
// at boot, stashed BEFORE any redirect).
describe("invite deferred-context persistence (Phase C)", () => {
  beforeEach(() => {
    // jsdom provides sessionStorage + history/location.
    sessionStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("stash → read round-trips the handle through sessionStorage", () => {
    expect(readStashedInvite()).toBeNull();
    stashInvite("alyssa");
    expect(readStashedInvite()).toBe("alyssa");
  });

  it("clear removes the stashed invite", () => {
    stashInvite("alyssa");
    clearStashedInvite();
    expect(readStashedInvite()).toBeNull();
  });

  it("uses the documented storage key", () => {
    stashInvite("alyssa");
    expect(sessionStorage.getItem(INVITE_STORAGE_KEY)).toBe("alyssa");
  });

  it("readStashedInvite is safe when sessionStorage throws (unavailable)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(readStashedInvite()).toBeNull();
  });

  it("stashInvite is safe when sessionStorage throws (no crash)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => stashInvite("alyssa")).not.toThrow();
  });

  it("stripInviteFromUrl removes ?friend= via replaceState (no reload, no history entry)", () => {
    jsdomSetSearch("?friend=alyssa&other=1");
    const replaceSpy = vi.spyOn(history, "replaceState"); // installed AFTER setting search
    stripInviteFromUrl();
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    // The replacement drops only friend=, keeps other params + pathname.
    expect(replaceSpy.mock.calls[0][2]).toBe("/?other=1");
  });

  it("stripInviteFromUrl is a no-op when there is no ?friend=", () => {
    jsdomSetSearch("");
    const replaceSpy = vi.spyOn(history, "replaceState");
    stripInviteFromUrl();
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

/** Helper: set window.location.search under jsdom (writable via href). */
function jsdomSetSearch(search: string): void {
  // jsdom's location.search is writable through the full href.
  const base = window.location.origin + window.location.pathname;
  window.history.replaceState(null, "", search ? base + search : base);
}
