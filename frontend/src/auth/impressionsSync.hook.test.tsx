// @vitest-environment jsdom
// ============================================================================
// useImpressionsSync — HOOK-layer tests.
//
// The pure + client-IO tests in impressionsSync.test.ts run in the node env
// (no jsdom, no React runtime). This file covers the actual hook behavior:
// the one-time sign-in GET→merge→setImpressions→PUT flow, with the async
// timing the #13 bug lived in.
//
// #13 specifically: a local write landing AFTER the sign-in effect mounted
// but BEFORE the GET resolves must end up in the merge-PUT body. Before the
// fix, the PUT recomputed the merge from the effect closure's stale
// `impressions` (the snapshot at sign-in render) and silently dropped the
// in-flight mark — self-healing only ~2s later via the debounced steady-state
// PUT. The fix reads from impressionsRef.current instead, which tracks every
// commit.
//
// Harness pattern: a real createRoot + a wrapper <Harness/> component that
// holds the impressions + auth state the hook reads. State setters are
// exposed to the test via a ref so we can drive them imperatively inside
// act(). No @testing-library in this repo; React 19's `act` from "react"
// + ReactDOMClient.createRoot is the minimal surface.
// ============================================================================
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { useImpressionsSync } from "./impressionsSync";
import type { ImpressionMap } from "../lib/impressions";

// React 19 act() requires this global flag so it knows it's running in a
// test environment that flushes effects synchronously. Without it, act warns
// and effects don't reliably fire inside the callback.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A deferred GET response the test resolves manually to control timing. */
interface FetchController {
  fetch: typeof fetch;
  resolveGet: (v: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }) => void;
  /** Captured PUT bodies, in call order. */
  puts: { token: string; body: unknown }[];
  /** Captured GET calls (for assertion). */
  gets: number;
}

function makeFetchController(): FetchController {
  let resolveGet!: (v: {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }) => void;
  const getPromise = new Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>((res) => {
    resolveGet = res;
  });
  const puts: { token: string; body: unknown }[] = [];
  let gets = 0;

  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    if (url.includes("/impressions") && method === "GET") {
      gets++;
      return getPromise;
    }
    if (url.includes("/impressions") && method === "PUT") {
      const headers = init.headers as Record<string, string>;
      puts.push({
        token: headers.Authorization,
        body: JSON.parse(init.body as string),
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, resolveGet, puts, gets };
}

/** Wrapper that exposes its state setters via the passed-in api ref. */
interface HarnessApi {
  setImpressions: (next: ImpressionMap) => void;
  setSignedIn: (signedIn: boolean) => void;
}

function makeHarness(apiRef: { current: HarnessApi | null }) {
  function Harness() {
    const [impressions, setImpressions] = React.useState<ImpressionMap>({});
    const [isSignedIn, setIsSignedIn] = React.useState(false);
    // getToken is stable across renders — the hook doesn't depend on its identity.
    const getToken = React.useCallback(async () => "test.jwt", []);
    apiRef.current = { setImpressions, setSignedIn: setIsSignedIn };
    useImpressionsSync(impressions, setImpressions, { isSignedIn, getToken });
    return null;
  }
  return Harness;
}

/** Flush ALL pending microtasks + one macrotask. The sign-in effect's async
 *  IIFE (getToken → getMyImpressions → fetch) chains several awaits, so a
 *  single Promise.resolve() flush isn't enough; setTimeout(0) drains them. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("useImpressionsSync — #13 stale-closure fix", () => {
  it("a local write between sign-in effect-mount and GET-resolution lands in the merge-PUT body", async () => {
    // Server carries one mark from another device. The test will make a
    // DIFFERENT local mark WHILE the GET is in flight, then assert both
    // end up in the merge-PUT body.
    const serverMark: ImpressionMap = {
      "r1|Server": {
        mark: "like",
        umaban: 1,
        odds_when_marked: null,
        odds_snapshot_at: null,
        formed_at: 100,
      },
    };
    const lateLocalMark: ImpressionMap = {
      "r1|Late": {
        mark: "anchor",
        umaban: 2,
        odds_when_marked: null,
        odds_snapshot_at: null,
        formed_at: 500,
      },
    };

    const fc = makeFetchController();
    vi.stubGlobal("fetch", fc.fetch);

    const apiRef = { current: null as HarnessApi | null };
    const Harness = makeHarness(apiRef);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    // 1. Mount signed-out. No GET, no PUT.
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
    expect(fc.puts).toHaveLength(0);

    // 2. Flip to signed-in. The sign-in effect fires its async IIFE
    //    (getToken → GET → ...). The GET is deferred via fc.resolveGet, so
    //    it stays pending until step 4 — guaranteeing the late mark in
    //    step 3 lands DURING the GET-resolution window (the #13 scenario),
    //    regardless of exactly when getToken's microtask fires.
    await React.act(async () => {
      apiRef.current!.setSignedIn(true);
      await flushMicrotasks();
    });

    // 3. THE #13 SCENARIO — make a local mark AFTER the effect mounted but
    //    BEFORE the GET resolves. Before the fix, the closure's `impressions`
    //    was the empty {} from the sign-in render, so the PUT body missed
    //    this mark. After the fix, impressionsRef.current tracks this commit.
    await React.act(async () => {
      apiRef.current!.setImpressions(lateLocalMark);
      await flushMicrotasks();
    });

    // 3. THE #13 SCENARIO — make a local mark AFTER the effect mounted but
    //    BEFORE the GET resolves. Before the fix, the closure's `impressions`
    //    was the empty {} from the sign-in render, so the PUT body missed
    //    this mark. After the fix, impressionsRef.current tracks this commit.
    await React.act(async () => {
      apiRef.current!.setImpressions(lateLocalMark);
    });

    // 4. Resolve the GET with the server map. The sign-in effect resumes,
    //    merges, setImpressions(merged), and PUTs the merged result.
    await React.act(async () => {
      fc.resolveGet({
        ok: true,
        status: 200,
        json: async () => ({
          impressions: [
            {
              comp_key: "r1|Server",
              mark: "like",
              umaban: 1,
              odds_when_marked: null,
              odds_snapshot_at: null,
              formed_at: 100,
            },
          ],
        }),
      });
      // Let the awaited GET promise + the downstream PUT resolve.
      await flushMicrotasks();
      await flushMicrotasks();
    });

    // 5. THE ASSERTION — the merge-PUT body includes BOTH marks (union).
    //    The first PUT is the merge-PUT from the sign-in flow (the steady-
    //    state debounced PUT is on a 2000ms timer that never fires in this
    //    test's wall-clock window).
    expect(fc.puts.length).toBeGreaterThanOrEqual(1);
    const mergePut = fc.puts[0];
    expect(mergePut).toBeDefined();
    const body = mergePut.body as { impressions: ImpressionMap };
    // The late local mark — THE #13 bug assertion. Old code dropped this.
    expect(body.impressions["r1|Late"]).toBeDefined();
    expect(body.impressions["r1|Late"].mark).toBe("anchor");
    // The server mark — present via the union merge.
    expect(body.impressions["r1|Server"]).toBeDefined();
    expect(body.impressions["r1|Server"].mark).toBe("like");

    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("baseline: when no write happens during GET, the merge-PUT carries only the union (no spurious marks)", async () => {
    // Sanity check the harness: without the #13 race, the PUT body is just
    // the union of (empty local + server). This guards against a future
    // change that accidentally synthesizes marks.
    const serverMark: ImpressionMap = {
      "r1|OnlyServer": {
        mark: "like",
        umaban: 1,
        odds_when_marked: null,
        odds_snapshot_at: null,
        formed_at: 100,
      },
    };

    const fc = makeFetchController();
    vi.stubGlobal("fetch", fc.fetch);

    const apiRef = { current: null as HarnessApi | null };
    const Harness = makeHarness(apiRef);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
    await React.act(async () => {
      apiRef.current!.setSignedIn(true);
    });
    // No local write during GET.
    await React.act(async () => {
      fc.resolveGet({
        ok: true,
        status: 200,
        json: async () => ({
          impressions: [
            {
              comp_key: "r1|OnlyServer",
              mark: "like",
              umaban: 1,
              odds_when_marked: null,
              odds_snapshot_at: null,
              formed_at: 100,
            },
          ],
        }),
      });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(fc.puts).toHaveLength(1);
    const body = fc.puts[0].body as { impressions: ImpressionMap };
    expect(Object.keys(body.impressions)).toEqual(["r1|OnlyServer"]);

    await React.act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
