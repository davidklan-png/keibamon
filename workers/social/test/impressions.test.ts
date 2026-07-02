// ============================================================================
// ADR-0018 — /api/social/me/impressions worker route tests.
//
// Focused fake D1 supporting ONLY the SQL the impressions handler + the
// ensureCaller upsert emit. The Phase 1-4 social.test.ts fake D1 is ~500 lines
// of pattern-matching for tickets/follows/cheers/blocks/reports; pulling it in
// here would couple tests of a new surface to all of that. This file mirrors
// the SAME test patterns (vi.mock("jose"), BASE_ENV, req(), authed(), jwtSub())
// but with a minimal store: a users map + an impressions map keyed by
// (user_id, comp_key). batch() runs each statement through the same machinery
// as single prepares, so transactional full-replace (DELETE + N INSERTs) is
// exercised end-to-end.
//
// What this pins:
//   - Both GET and PUT require auth (401 on missing/invalid Bearer).
//   - GET returns [] for a user with no stored marks.
//   - PUT roundtrips: write a map → GET returns the same map.
//   - Full-replace: PUT A, then PUT B → only B remains (A is gone).
//   - PUT with empty map clears the user's marks entirely.
//   - Validation: bad mark, non-object body, missing impressions field.
//   - Method-not-allowed on POST/PATCH/DELETE.
//   - Ownership: user A's marks are never visible to user B.
// ============================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
// D1Database is a global ambient type from @cloudflare/workers-types (in
// tsconfig types[]). The `as unknown as D1Database` cast in makeFakeD1's
// return mirrors social.test.ts:575 — the focused fake only implements the
// methods the impressions handler + ensureCaller actually call; the
// structural D1Database interface (which also requires exec/withSession/dump)
// is satisfied via the double cast.

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(() => ({ __mock: "jwks" })),
}));

import { jwtVerify } from "jose";
import worker, { type Env } from "../src/index";

// ---------------------------------------------------------------------------
// Minimal fake D1.
// ---------------------------------------------------------------------------

interface FakeUserRow {
  id: string;
  clerk_user_id: string;
  age_verified: number;
  created_at: number;
}

interface FakeImpressionRow {
  user_id: string;
  comp_key: string;
  mark: string;
  umaban: number | null;
  odds_when_marked: number | null;
  odds_snapshot_at: string | null;
  formed_at: number;
  updated_at: number;
}

interface FakeD1Options {
  users?: FakeUserRow[];
  impressions?: FakeImpressionRow[];
}

function makeFakeD1(opts: FakeD1Options = {}) {
  const usersByClerk = new Map<string, FakeUserRow>();
  const usersById = new Map<string, FakeUserRow>();
  // impressions keyed by `${user_id}|${comp_key}` for O(1) PK enforcement.
  const impressions = new Map<string, FakeImpressionRow>();
  let userNonce = 0;

  for (const u of opts.users ?? []) {
    usersByClerk.set(u.clerk_user_id, u);
    usersById.set(u.id, u);
  }
  for (const i of opts.impressions ?? []) {
    impressions.set(`${i.user_id}|${i.comp_key}`, i);
  }

  // Mirrors D1PreparedStatement — fluent bind + terminal first/all/run.
  function stmt(sql: string) {
    const entry: { sql: string; bindings: unknown[] } = { sql, bindings: [] };
    const self = {
      bind: (...args: unknown[]) => {
        entry.bindings = args;
        return self;
      },
      first: async (): Promise<unknown> => (await runOne(entry.sql, entry.bindings)) ?? null,
      all: async (): Promise<{ results: unknown[] }> => ({ results: await runAll(entry.sql, entry.bindings) }),
      run: async (): Promise<{ meta: unknown }> => {
        await runOne(entry.sql, entry.bindings);
        return { meta: {} };
      },
    };
    return self;
  }

  async function runOne(sql: string, b: unknown[]): Promise<unknown> {
    const s = sql.trim();
    // ---- ensureCaller's empty-patch upsert (GET branch): INSERT ... DO NOTHING ----
    let m = /^INSERT INTO users [\s\S]*ON CONFLICT\(clerk_user_id\) DO NOTHING/i.exec(s);
    if (m) {
      const [, clerkId, createdAt] = b as [string, string, number];
      if (!usersByClerk.has(clerkId)) {
        userNonce += 1;
        const row: FakeUserRow = {
          id: `u-${userNonce}`,
          clerk_user_id: clerkId,
          age_verified: 0,
          created_at: createdAt,
        };
        usersByClerk.set(clerkId, row);
        usersById.set(row.id, row);
      }
      return null;
    }
    // ---- upsert with DO UPDATE SET (handle/dn/avatar/age_verified) — accept and store ----
    m = /^INSERT INTO users [\s\S]*ON CONFLICT\(clerk_user_id\) DO UPDATE SET[\s\S]*RETURNING \*/i.exec(s);
    if (m) {
      const [id, clerkId, ageVerified, createdAt] = b as [string, string, number, number];
      const existing = usersByClerk.get(clerkId);
      const row: FakeUserRow = existing
        ? { ...existing, age_verified: ageVerified ?? existing.age_verified }
        : {
            id: id || `u-${(userNonce += 1)}`,
            clerk_user_id: clerkId,
            age_verified: ageVerified,
            created_at: createdAt,
          };
      usersByClerk.set(clerkId, row);
      usersById.set(row.id, row);
      return row;
    }
    // ---- SELECT * FROM users WHERE clerk_user_id = ? ----
    m = /^SELECT \* FROM users WHERE clerk_user_id = \?/i.exec(s);
    if (m) {
      const clerkId = b[0] as string;
      return usersByClerk.get(clerkId) ?? null;
    }
    // ---- SELECT * FROM users WHERE id = ? ----
    m = /^SELECT \* FROM users WHERE id = \?/i.exec(s);
    if (m) {
      const id = b[0] as string;
      return usersById.get(id) ?? null;
    }
    // ---- impressions: GET (SELECT comp_key, mark, ... WHERE user_id = ?) ----
    m = /^SELECT comp_key, mark, umaban, odds_when_marked, odds_snapshot_at, formed_at, updated_at\s+FROM user_impressions\s+WHERE user_id = \?/i.exec(s);
    if (m) {
      // all() handles this path; if we land here via first(), return null.
      return null;
    }
    // ---- impressions: DELETE WHERE user_id = ? ----
    m = /^DELETE FROM user_impressions WHERE user_id = \?/i.exec(s);
    if (m) {
      const userId = b[0] as string;
      for (const key of [...impressions.keys()]) {
        if (key.startsWith(`${userId}|`)) impressions.delete(key);
      }
      return null;
    }
    // ---- impressions: INSERT (one row per call) ----
    m = /^INSERT INTO user_impressions[\s\S]*VALUES[\s\S]*\(/i.exec(s);
    if (m) {
      const [userId, compKey, mark, umaban, oddsMarked, oddsSnap, formedAt, updatedAt] = b as [
        string, string, string, number | null, number | null, string | null, number, number,
      ];
      impressions.set(`${userId}|${compKey}`, {
        user_id: userId,
        comp_key: compKey,
        mark,
        umaban,
        odds_when_marked: oddsMarked,
        odds_snapshot_at: oddsSnap,
        formed_at: formedAt,
        updated_at: updatedAt,
      });
      return null;
    }
    throw new Error(`UNHANDLED SQL: ${s}`);
  }

  async function runAll(sql: string, b: unknown[]): Promise<unknown[]> {
    const s = sql.trim();
    const m = /^SELECT comp_key, mark, umaban, odds_when_marked, odds_snapshot_at, formed_at, updated_at\s+FROM user_impressions\s+WHERE user_id = \?/i.exec(s);
    if (m) {
      const userId = b[0] as string;
      const out: FakeImpressionRow[] = [];
      for (const row of impressions.values()) {
        if (row.user_id === userId) out.push(row);
      }
      return out;
    }
    return [];
  }

  const db = {
    prepare: stmt,
    // ADR-0018: transactional full-replace. Each statement runs through the
    // same runOne/runAll machinery; on throw, the fake Map state is whatever
    // the partially-applied change left (real D1 would roll back; we don't
    // need to model rollback for these tests since validation happens BEFORE
    // replaceImpressions, so a mid-batch throw is not a tested path).
    batch: async <T = unknown>(statements: { run: () => Promise<unknown> }[]): Promise<T[]> => {
      const out: T[] = [];
      for (const st of statements) {
        await st.run();
        out.push({ meta: {} } as unknown as T);
      }
      return out;
    },
  };
  return {
    db: db as unknown as D1Database,
    usersByClerk,
    usersById,
    impressions,
  };
}

// ---------------------------------------------------------------------------
// Test harness — mirrors the Phase 1-4 social.test.ts conventions exactly.
// ---------------------------------------------------------------------------

const BASE_ENV: Omit<Env, "DB"> = {
  CLERK_ISSUER: "https://example.clerk.accounts.dev",
  ALLOWED_ORIGINS: "https://app.example.com,http://localhost:5173",
  LIVE_BASE: "https://racing.example.workers.dev",
};

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://social.example.workers.dev${path}`, init);
}

function authed(token = "good.jwt"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jwtSub(sub: string) {
  return vi.mocked(jwtVerify).mockResolvedValueOnce({
    payload: { sub },
  } as Awaited<ReturnType<typeof jwtVerify>>);
}

/** Helper: PUT body for the impressions map. */
function putBody(impressions: Record<string, unknown>): string {
  return JSON.stringify({ impressions });
}

describe("social Worker — ADR-0018 /api/social/me/impressions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Auth branching.
  // -------------------------------------------------------------------------

  it("returns 401 on GET with no Authorization header", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(req("/api/social/me/impressions"), {
      ...BASE_ENV,
      DB: db,
    } as Env, {} as ExecutionContext);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("returns 401 on GET when jose rejects the JWT", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error("bad signature"));
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", { headers: authed() }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 on PUT with no Authorization header", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", { method: "PUT", body: putBody({}) }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 405 on POST (only GET + PUT are served)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", { method: "POST", headers: authed(), body: "{}" }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({ error: "method_not_allowed" });
  });

  // -------------------------------------------------------------------------
  // GET — empty + shape.
  // -------------------------------------------------------------------------

  it("GET returns an empty impressions array for a user with no stored marks", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", { headers: authed() }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { impressions: unknown[] };
    expect(Array.isArray(body.impressions)).toBe(true);
    expect(body.impressions).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // PUT roundtrip + full-replace semantics.
  // -------------------------------------------------------------------------

  it("PUT writes a map and GET roundtrips it (column-for-column)", async () => {
    jwtSub("user_abc"); // for PUT
    const { db } = makeFakeD1();
    const map = {
      "race-1|HorseA": {
        mark: "anchor",
        umaban: 1,
        odds_when_marked: 3.2,
        odds_snapshot_at: "2026-07-02T10:00:00Z",
        formed_at: 1_700_000_000_000,
      },
      "race-1|HorseB": {
        mark: "like",
        umaban: 2,
        odds_when_marked: null,
        odds_snapshot_at: null,
        formed_at: 1_700_000_001_000,
      },
    };
    const putRes = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody(map),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toMatchObject({ ok: true });

    jwtSub("user_abc"); // for GET
    const getRes = await worker.fetch(
      req("/api/social/me/impressions", { headers: authed() }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { impressions: Record<string, unknown>[] };
    expect(body.impressions).toHaveLength(2);
    // Find by comp_key (order is not guaranteed by SELECT).
    const byKey = new Map(body.impressions.map((r) => [r.comp_key as string, r]));
    expect(byKey.has("race-1|HorseA")).toBe(true);
    expect(byKey.has("race-1|HorseB")).toBe(true);
    const a = byKey.get("race-1|HorseA")!;
    expect(a.mark).toBe("anchor");
    expect(a.umaban).toBe(1);
    expect(a.odds_when_marked).toBe(3.2);
    expect(a.odds_snapshot_at).toBe("2026-07-02T10:00:00Z");
    expect(a.formed_at).toBe(1_700_000_000_000);
    // updated_at is server-stamped (a real Date.now() ms); just confirm presence.
    expect(typeof a.updated_at).toBe("number");
  });

  it("PUT is a full-replace: a second PUT replaces (not merges) the prior set", async () => {
    jwtSub("user_abc");
    const { db, impressions } = makeFakeD1();
    // PUT A: two marks.
    await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({
          "race-1|HorseA": { mark: "anchor", umaban: 1, formed_at: 1_000 },
          "race-1|HorseB": { mark: "like", umaban: 2, formed_at: 2_000 },
        }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(impressions.size).toBe(2);

    // PUT B: a completely different set.
    jwtSub("user_abc");
    await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({
          "race-2|HorseC": { mark: "avoid", umaban: 3, formed_at: 3_000 },
        }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    // Only PUT B's rows remain — HorseA/HorseB from PUT A were DELETEd.
    expect(impressions.size).toBe(1);
    expect(impressions.has("u-1|race-1|HorseA")).toBe(false);
    expect(impressions.has("u-1|race-1|HorseB")).toBe(false);
    expect(impressions.has("u-1|race-2|HorseC")).toBe(true);
  });

  it("PUT with an empty impressions map clears the user's marks entirely", async () => {
    jwtSub("user_abc");
    const { db, impressions } = makeFakeD1({
      impressions: [
        {
          user_id: "u-1",
          comp_key: "race-1|HorseA",
          mark: "anchor",
          umaban: 1,
          odds_when_marked: null,
          odds_snapshot_at: null,
          formed_at: 1_000,
          updated_at: 1_500,
        },
      ],
    });
    // Seed the matching user row so ensureCaller finds it.
    const { db: db2, impressions: imp2 } = makeFakeD1({
      users: [{ id: "u-1", clerk_user_id: "user_abc", age_verified: 0, created_at: 1_500_000_000 }],
      impressions: [
        {
          user_id: "u-1",
          comp_key: "race-1|HorseA",
          mark: "anchor",
          umaban: 1,
          odds_when_marked: null,
          odds_snapshot_at: null,
          formed_at: 1_000,
          updated_at: 1_500,
        },
      ],
    });
    expect(imp2.size).toBe(1);

    jwtSub("user_abc");
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({}),
      }),
      { ...BASE_ENV, DB: db2 } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(imp2.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Validation.
  // -------------------------------------------------------------------------

  it("rejects PUT with a bad mark value (not one of the 5 IntuitionKind)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({ "race-1|HorseA": { mark: "love", umaban: 1, formed_at: 1 } }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_mark" });
  });

  it("rejects PUT when the body is not valid JSON", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: "not json{",
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_body" });
  });

  it("rejects PUT when the body lacks the impressions field", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: JSON.stringify({ nope: true }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_body" });
  });

  it("rejects PUT with a non-numeric formed_at", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({ "race-1|HorseA": { mark: "like", umaban: 1, formed_at: "soon" } }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_formed_at" });
  });

  // -------------------------------------------------------------------------
  // Ownership isolation.
  // -------------------------------------------------------------------------

  it("user A's marks are never visible to user B (ownership isolation)", async () => {
    jwtSub("user_A");
    const { db } = makeFakeD1();
    await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({ "race-1|HorseA": { mark: "anchor", umaban: 1, formed_at: 1 } }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );

    jwtSub("user_B");
    const res = await worker.fetch(
      req("/api/social/me/impressions", { headers: authed("other.jwt") }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { impressions: unknown[] };
    expect(body.impressions).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Validation — comp_key + bound.
  // -------------------------------------------------------------------------

  it("rejects PUT with an empty comp_key", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({ "": { mark: "like", umaban: 1, formed_at: 1 } }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_comp_key" });
  });

  it("accepts NULL/optional fields (umaban/odds/snapshot may be null)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me/impressions", {
        method: "PUT",
        headers: authed(),
        body: putBody({
          "race-1|HorseA": { mark: "like", umaban: null, odds_when_marked: null, odds_snapshot_at: null, formed_at: 1 },
        }),
      }),
      { ...BASE_ENV, DB: db } as Env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
  });
});
