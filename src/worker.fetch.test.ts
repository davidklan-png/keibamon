// ============================================================================
// Fetch-handler test for the invite splash → app redirect in src/worker.js.
//
// The first real fetch-handler coverage for the worker. Drives the default
// export's `fetch` with a stubbed ASSETS binding so we can assert the
// `/?friend=<handle>` → `/app/?friend=<handle>` forwarding (the safety net for
// invite links already in the wild) without serving real static assets.
//
// Pattern mirrors src/worker.scheduled.test.ts (opaque default import of the
// JS worker entry; the untyped import is fine because we cast the handler).
// ============================================================================
import { describe, it, expect } from "vitest";
// worker.js is the hand-written Cloudflare Worker entry (JS, not TS) — wrangler
// bundles it for deploy; tsc has no .d.ts for it. Driven opaquely via the cast.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error TS7016: no declaration file for the JS worker entry
import worker from "./worker.js";

const fetch = (
  worker as { fetch: (req: Request, env: unknown) => Promise<Response> }
).fetch;

/** Minimal env: only ASSETS is touched by the splash/app paths under test. */
function env(): { ASSETS: { fetch: (req: Request) => Response } } {
  return {
    ASSETS: {
      fetch: () =>
        new Response("splash-or-spa", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    },
  };
}

describe("worker fetch — invite splash redirect", () => {
  it("forwards /?friend=<handle> to /app/?friend=<handle> (307)", async () => {
    const res = await fetch(
      new Request("https://keibamon.com/?friend=alyssa"),
      env(),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://keibamon.com/app/?friend=alyssa",
    );
  });

  it("preserves the friend value exactly (encoded chars pass through)", async () => {
    const res = await fetch(
      new Request("https://keibamon.com/?friend=a%20b"),
      env(),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://keibamon.com/app/?friend=a%20b",
    );
  });

  it("preserves any other query params alongside friend", async () => {
    const res = await fetch(
      new Request("https://keibamon.com/?friend=bo&utm=invite"),
      env(),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://keibamon.com/app/?friend=bo&utm=invite",
    );
  });

  it("does NOT redirect / without a friend param (splash is served)", async () => {
    const res = await fetch(new Request("https://keibamon.com/"), env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("splash-or-spa");
  });

  it("does NOT redirect /app/ — leaves the app shell to ASSETS", async () => {
    // The app already lives at /app/; a friend param there must be consumed by
    // the SPA, not bounced.
    const res = await fetch(
      new Request("https://keibamon.com/app/?friend=alyssa"),
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("splash-or-spa");
  });
});

// Static splash assets (index.html, live.html, helper.html, updates.html) are
// served directly by the ASSETS binding — the Worker only runs for paths that
// aren't files. updates.html is a hand-maintained release-notes page linked
// from the hero version badge; pin that it falls through to ASSETS (200) and is
// never intercepted or redirected.
describe("worker fetch — static splash assets", () => {
  it("serves /updates.html from ASSETS (200, not redirected)", async () => {
    const res = await fetch(
      new Request("https://keibamon.com/updates.html"),
      env(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("splash-or-spa");
  });

  it("serves / (splash home) from ASSETS when no friend param is present", async () => {
    const res = await fetch(new Request("https://keibamon.com/"), env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("splash-or-spa");
  });
});
