import { describe, it, expect, vi, beforeEach } from "vitest";

// ADR-0007 Phase 1 — social Worker tests. Runs in node (no Miniflare); jose
// is mocked so no real network fetch happens, and D1 is a fake that captures
// SQL + bindings for assertions. The contract under test is purely the
// Worker's request/response shape + auth branching.

vi.mock("jose", () => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(() => ({ __mock: "jwks" })),
}));

// Import after vi.mock so the stub takes effect.
import { jwtVerify } from "jose";
import worker, { type Env } from "../src/index";

interface PreparedCall {
  sql: string;
  bindings: unknown[];
}

interface FakeD1Options {
  /** Row returned by `.first()` on the next-issued statement. */
  row?: Record<string, unknown> | null;
}

/**
 * Minimal fake D1. Each prepare() captures SQL; bind() captures bindings;
 * first()/run()/all() return canned values. Sufficient for the Worker's
 * upsert path — we're testing routing + auth, not SQL semantics.
 */
function makeFakeD1(opts: FakeD1Options = {}) {
  const calls: PreparedCall[] = [];
  const db = {
    prepare: (sql: string) => {
      const entry: PreparedCall = { sql, bindings: [] };
      calls.push(entry);
      const stmt = {
        bind: (...args: unknown[]) => {
          entry.bindings = args;
          return stmt;
        },
        first: async <T>(): Promise<T | null> => (opts.row ?? null) as T | null,
        run: async (): Promise<{ meta: unknown }> => ({ meta: {} }),
        all: async (): Promise<{ results: unknown[] }> => ({ results: [] }),
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, calls };
}

const BASE_ENV: Omit<Env, "DB"> = {
  CLERK_ISSUER: "https://example.clerk.accounts.dev",
  ALLOWED_ORIGINS: "https://app.example.com,http://localhost:5173",
};

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://social.example.workers.dev${path}`, init);
}

describe("social Worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 on missing Authorization header", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(req("/api/social/me"), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("returns 401 on malformed Authorization header", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me", { headers: { Authorization: "Token xyz" } }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when jose rejects the JWT", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error("bad signature"));
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me", { headers: { Authorization: "Bearer not.real.jwt" } }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
    expect(jwtVerify).toHaveBeenCalledTimes(1);
  });

  it("returns 200 + upserted profile row on a valid GET", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: "user_abc" },
    } as Awaited<ReturnType<typeof jwtVerify>>);
    const row = {
      id: "uuid-1",
      clerk_user_id: "user_abc",
      handle: null,
      display_name: null,
      avatar: null,
      age_verified: 0,
      created_at: 1_700_000_000,
    };
    const { db, calls } = makeFakeD1({ row });
    const res = await worker.fetch(
      req("/api/social/me", { headers: { Authorization: "Bearer good.jwt" } }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ clerk_user_id: "user_abc", age_verified: 0 });
    // The upsert path issues >=1 statement against the users table.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => /INSERT INTO users/i.test(c.sql))).toBe(true);
    // GET path does not set age_verified in the SQL.
    expect(calls.some((c) => /DO UPDATE SET age_verified/i.test(c.sql))).toBe(false);
  });

  it("writes age_verified on POST {age_verified:1} via ON CONFLICT DO UPDATE", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: "user_abc" },
    } as Awaited<ReturnType<typeof jwtVerify>>);
    const row = {
      id: "uuid-1",
      clerk_user_id: "user_abc",
      handle: null,
      display_name: null,
      avatar: null,
      age_verified: 1,
      created_at: 1_700_000_000,
    };
    const { db, calls } = makeFakeD1({ row });
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: {
          Authorization: "Bearer good.jwt",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ age_verified: 1 }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ age_verified: 1 });
    expect(calls.some((c) => /DO UPDATE SET age_verified/i.test(c.sql))).toBe(true);
  });

  it("reflects the allowed CORS origin on a preflight", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "OPTIONS",
        headers: { Origin: "https://app.example.com" },
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("reflects CORS allow-origin on a 200", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: "user_abc" },
    } as Awaited<ReturnType<typeof jwtVerify>>);
    const { db } = makeFakeD1({ row: { id: "x", clerk_user_id: "user_abc", age_verified: 0, created_at: 1 } });
    const res = await worker.fetch(
      req("/api/social/me", {
        headers: {
          Authorization: "Bearer good.jwt",
          Origin: "http://localhost:5173",
        },
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });

  it("omits CORS allow-origin when the request origin is not on the allowlist", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me", {
        headers: { Origin: "https://evil.example.com" },
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("");
  });

  it("returns 404 on unknown paths (never collides with /api/live)", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(req("/api/live"), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(404);
    // And the racing-tier path doesn't trigger D1 traffic on this Worker.
  });
});
