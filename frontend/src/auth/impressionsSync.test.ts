// ============================================================================
// impressionsSync tests (ADR-0018).
//
// Split into two layers:
//   1. PURE — mergeImpressions, rowsToMap. Node env, no React, no jsdom.
//      These pin the LWW semantics exactly so a future refactor of the hook
//      can't silently change the merge.
//   2. HOOK — useImpressionsSync. jsdom + fake timers; asserts the one-time
//      sign-in GET+merge+PUT and the debounced steady-state PUT.
//
// The fetch calls in the hook tests are stubbed via globalThis.fetch — the
// hook uses the same authedFetch pattern as socialClient (no separate mock
// module). getToken is injected via the auth prop so no Clerk dependency.
// ============================================================================
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mergeImpressions,
  rowsToMap,
  getMyImpressions,
  putMyImpressions,
  type ServerImpressionRow,
} from "./impressionsSync";
import type { ImpressionMap } from "../lib/impressions";

// ---------------------------------------------------------------------------
// PURE — mergeImpressions.
// ---------------------------------------------------------------------------

describe("mergeImpressions — LWW union", () => {
  it("returns local unchanged when server is empty", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
    };
    expect(mergeImpressions(local, {})).toEqual(local);
  });

  it("returns server unchanged when local is empty", () => {
    const server: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
    };
    expect(mergeImpressions({}, server)).toEqual(server);
  });

  it("returns {} when both maps are empty", () => {
    expect(mergeImpressions({}, {})).toEqual({});
  });

  it("takes the union when keys are disjoint", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
    };
    const server: ImpressionMap = {
      "r2|B": { mark: "like", umaban: 2, odds_when_marked: null, odds_snapshot_at: null, formed_at: 200 },
    };
    const merged = mergeImpressions(local, server);
    expect(Object.keys(merged).sort()).toEqual(["r1|A", "r2|B"]);
  });

  it("same key, server newer → server wins", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "like", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
    };
    const server: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: 3.2, odds_snapshot_at: "t", formed_at: 200 },
    };
    const merged = mergeImpressions(local, server);
    expect(merged["r1|A"]).toEqual(server["r1|A"]);
  });

  it("same key, local newer → local wins", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: 3.2, odds_snapshot_at: "t", formed_at: 200 },
    };
    const server: ImpressionMap = {
      "r1|A": { mark: "like", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
    };
    const merged = mergeImpressions(local, server);
    expect(merged["r1|A"]).toEqual(local["r1|A"]);
  });

  it("same key, tie on formed_at → LOCAL wins (device is source of truth)", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 500 },
    };
    const server: ImpressionMap = {
      "r1|A": { mark: "like", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 500 },
    };
    const merged = mergeImpressions(local, server);
    expect(merged["r1|A"].mark).toBe("anchor");
  });

  it("does NOT mutate either input (immutability)", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
    };
    const server: ImpressionMap = {
      "r2|B": { mark: "like", umaban: 2, odds_when_marked: null, odds_snapshot_at: null, formed_at: 200 },
    };
    const localSnap = JSON.parse(JSON.stringify(local));
    const serverSnap = JSON.parse(JSON.stringify(server));
    mergeImpressions(local, server);
    expect(local).toEqual(localSnap);
    expect(server).toEqual(serverSnap);
  });

  it("mixes server-newer, local-newer, and disjoint keys in one merge", () => {
    const local: ImpressionMap = {
      "r1|A": { mark: "like", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 }, // server newer
      "r1|B": { mark: "anchor", umaban: 2, odds_when_marked: null, odds_snapshot_at: null, formed_at: 500 }, // local newer
      "r1|C": { mark: "avoid", umaban: 3, odds_when_marked: null, odds_snapshot_at: null, formed_at: 50 }, // local-only
    };
    const server: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 300 },
      "r1|B": { mark: "like", umaban: 2, odds_when_marked: null, odds_snapshot_at: null, formed_at: 100 },
      "r1|D": { mark: "priceHorse", umaban: 4, odds_when_marked: null, odds_snapshot_at: null, formed_at: 70 }, // server-only
    };
    const merged = mergeImpressions(local, server);
    expect(merged["r1|A"].mark).toBe("anchor"); // server won (300 > 100)
    expect(merged["r1|B"].mark).toBe("anchor"); // local won (500 > 100)
    expect(merged["r1|C"].mark).toBe("avoid"); // local-only
    expect(merged["r1|D"].mark).toBe("priceHorse"); // server-only
    expect(Object.keys(merged).sort()).toEqual(["r1|A", "r1|B", "r1|C", "r1|D"]);
  });
});

// ---------------------------------------------------------------------------
// PURE — rowsToMap.
// ---------------------------------------------------------------------------

describe("rowsToMap — server row → client map conversion", () => {
  it("converts each row to the Impression shape keyed by comp_key", () => {
    const rows: ServerImpressionRow[] = [
      {
        comp_key: "r1|HorseA",
        mark: "anchor",
        umaban: 1,
        odds_when_marked: 3.2,
        odds_snapshot_at: "2026-07-02T10:00:00Z",
        formed_at: 1_700_000_000_000,
      },
    ];
    const map = rowsToMap(rows);
    expect(map["r1|HorseA"]).toEqual({
      mark: "anchor",
      umaban: 1,
      odds_when_marked: 3.2,
      odds_snapshot_at: "2026-07-02T10:00:00Z",
      formed_at: 1_700_000_000_000,
    });
  });

  it("drops rows with empty comp_key or empty mark (defensive)", () => {
    const rows: ServerImpressionRow[] = [
      { comp_key: "", mark: "like", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
      { comp_key: "r1|A", mark: "", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
      { comp_key: "r1|B", mark: "like", umaban: 2, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
    ];
    const map = rowsToMap(rows);
    expect(Object.keys(map)).toEqual(["r1|B"]);
  });

  it("coerces null umaban to 0 (defensive — server may NULL umaban)", () => {
    const rows: ServerImpressionRow[] = [
      { comp_key: "r1|A", mark: "like", umaban: null, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
    ];
    expect(rowsToMap(rows)["r1|A"].umaban).toBe(0);
  });

  it("coerces null odds fields to null (the documented client shape)", () => {
    const rows: ServerImpressionRow[] = [
      { comp_key: "r1|A", mark: "like", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
    ];
    const v = rowsToMap(rows)["r1|A"];
    expect(v.odds_when_marked).toBeNull();
    expect(v.odds_snapshot_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLIENT I/O — getMyImpressions + putMyImpressions (fetch stubbed).
// ---------------------------------------------------------------------------

function stubFetch(impl: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  return vi.fn(async (url: string, init: RequestInit) => impl(url, init)) as unknown as typeof fetch;
}

describe("getMyImpressions / putMyImpressions — fetch wrappers", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("getMyImpressions returns no_token when token is null", async () => {
    const r = await getMyImpressions(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.kind).toBe("no_token");
  });

  it("getMyImpressions parses {impressions: rows} → ImpressionMap", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          impressions: [
            { comp_key: "r1|A", mark: "anchor", umaban: 1, odds_when_marked: 3.2, odds_snapshot_at: "t", formed_at: 1 },
          ],
        }),
      })),
    );
    const r = await getMyImpressions("good.jwt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data["r1|A"].mark).toBe("anchor");
    }
  });

  it("getMyImpressions returns network on fetch throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const r = await getMyImpressions("good.jwt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.kind).toBe("network");
  });

  it("getMyImpressions returns http on non-200 status", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    const r = await getMyImpressions("good.jwt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err).toEqual({ kind: "http", status: 500 });
  });

  it("getMyImpressions returns http when body lacks impressions array", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) })),
    );
    const r = await getMyImpressions("good.jwt");
    expect(r.ok).toBe(false);
  });

  it("putMyImpressions sends PUT with the map as body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }) as unknown as typeof fetch,
    );
    const map: ImpressionMap = {
      "r1|A": { mark: "anchor", umaban: 1, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
    };
    const r = await putMyImpressions("good.jwt", map);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/social/me/impressions");
    expect(calls[0].init.method).toBe("PUT");
    expect(calls[0].init.body).toBe(JSON.stringify({ impressions: map }));
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer good.jwt");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("putMyImpressions returns no_token when token is null", async () => {
    const r = await putMyImpressions(null, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.err.kind).toBe("no_token");
  });
});
