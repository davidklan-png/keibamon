import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ADR-0007 Phase 3 — socialClient helper contract tests.
//
// These don't exercise the Worker; they assert the client (a) targets the
// right path + method + Authorization header, (b) handles the no-token case
// for authed routes, and (c) tolerates a missing token on the PUBLIC profile
// route (the only GET that signed-out users can hit).

import { cheer, getProfile, follow } from "./socialClient";

const ORIG_FETCH = globalThis.fetch;

function mockFetch(): {
  fetch: ReturnType<typeof vi.fn>;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = f as unknown as typeof globalThis.fetch;
  return { fetch: f, calls };
}

describe("socialClient Phase 3 helpers", () => {
  beforeEach(() => {
    // Empty base — calls go to relative paths, easy to assert.
    vi.stubEnv("VITE_SOCIAL_API_BASE", "");
  });
  afterEach(() => {
    globalThis.fetch = ORIG_FETCH;
    vi.unstubAllEnvs();
  });

  it("cheer posts to /api/social/tickets/:id/cheer with Bearer token", async () => {
    const { calls } = mockFetch();
    const r = await cheer("tok-abc", "kb-1");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/social/tickets/kb-1/cheer");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
  });

  it("cheer encodes the ticket id (special chars)", async () => {
    const { calls } = mockFetch();
    await cheer("tok", "kb with space");
    expect(calls[0].url).toBe("/api/social/tickets/kb%20with%20space/cheer");
  });

  it("cheer without a token returns {ok:false, err:{kind:'no_token'}}", async () => {
    const { calls } = mockFetch();
    const r = await cheer(null, "kb-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.kind).toBe("no_token");
    expect(calls).toHaveLength(0);
  });

  it("follow targets /api/social/follow/:userId", async () => {
    const { calls } = mockFetch();
    const r = await follow("tok", "u-target");
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("/api/social/follow/u-target");
    expect(calls[0].init.method).toBe("POST");
  });

  it("getProfile works WITHOUT a token (public route) and omits Authorization", async () => {
    const { calls } = mockFetch();
    const r = await getProfile(null, "alyssa");
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/social/users/alyssa");
    const headers = calls[0].init.headers as Record<string, string> | undefined;
    // No Authorization header is added when token is null.
    expect(headers?.Authorization).toBeUndefined();
  });

  it("getProfile WITH a token sends Authorization", async () => {
    const { calls } = mockFetch();
    await getProfile("tok", "alyssa");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });
});
