import { describe, it, expect, vi, beforeEach } from "vitest";

// ADR-0007 Phase 2 — social Worker tests.
//
// The fake D1 here is a TINY in-memory engine: it pattern-matches the specific
// statements the Worker issues (INSERT INTO users, INSERT INTO tickets, SELECT
// tickets, UPDATE tickets) and maintains state across calls. This lets the
// Phase 2 tests exercise REAL ownership enforcement — a non-owner PATCH hits
// the same row lookup that production does and gets 403 because user_id
// doesn't match, not because the test rigged it.
//
// Jose is mocked so no real network fetch happens. The contract under test is
// purely the Worker's request/response shape + auth branching + ownership.

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

interface UserRow {
  id: string;
  clerk_user_id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
  age_verified: number;
  created_at: number;
}

interface TicketRow {
  id: string;
  user_id: string;
  serial: string;
  race_key: string;
  payload: string;
  state: string;
  payout_base: number;
  returned: number | null;
  created_at: number;
}

interface FakeD1Options {
  /** Optional initial state — handy for seeding an owner + a non-owner. */
  users?: UserRow[];
  tickets?: TicketRow[];
  /** Legacy Phase 1 shape (`makeFakeD1({ row })`) — accepted but ignored. */
  row?: Record<string, unknown> | null;
}

function makeFakeD1(opts: FakeD1Options = {}) {
  const users = new Map<string, UserRow>(); // by clerk_user_id
  const usersById = new Map<string, UserRow>(); // by id
  const tickets = new Map<string, TicketRow>(); // by id
  const calls: PreparedCall[] = [];
  let nonce = 0;

  for (const u of opts.users ?? []) {
    users.set(u.clerk_user_id, u);
    usersById.set(u.id, u);
  }
  for (const t of opts.tickets ?? []) tickets.set(t.id, t);

  function freshId(prefix: string): string {
    nonce += 1;
    return `${prefix}-${nonce.toString(36)}`;
  }

  function stmt(sql: string) {
    const entry: PreparedCall = { sql, bindings: [] };
    calls.push(entry);
    const self = {
      bind: (...args: unknown[]) => {
        entry.bindings = args;
        return self;
      },
      first: async <T>(): Promise<T | null> => {
        return (await runOne(sql, entry.bindings)) as T | null;
      },
      all: async <T>(): Promise<{ results: T[] }> => {
        return { results: (await runAll<T>(sql, entry.bindings)) ?? [] };
      },
      run: async (): Promise<{ meta: unknown }> => {
        await runOne(sql, entry.bindings);
        return { meta: {} };
      },
    };
    return self;
  }

  async function runOne(sql: string, b: unknown[]): Promise<unknown> {
    const s = sql.trim();
    // users: upsert with age_verified
    let m = /^INSERT INTO users [\s\S]*ON CONFLICT\(clerk_user_id\) DO UPDATE SET age_verified[\s\S]*RETURNING \*/i.exec(s);
    if (m) {
      const [id, clerkId, ageVerified, createdAt] = b as [string, string, number, number];
      const existing = users.get(clerkId);
      const row: UserRow = existing
        ? { ...existing, age_verified: ageVerified }
        : {
            id: id || freshId("u"),
            clerk_user_id: clerkId,
            handle: null,
            display_name: null,
            avatar: null,
            age_verified: ageVerified,
            created_at: createdAt,
          };
      users.set(clerkId, row);
      usersById.set(row.id, row);
      return row;
    }
    // users: insert-or-nothing then read by clerk_user_id
    m = /^INSERT INTO users [\s\S]*ON CONFLICT\(clerk_user_id\) DO NOTHING/i.exec(s);
    if (m) {
      // Worker SQL is `VALUES (?, ?, 0, ?)` — age_verified is the LITERAL 0,
      // so only 3 bindings hit D1: id, clerk_id, created_at.
      const [id, clerkId, createdAt] = b as [string, string, number];
      if (!users.has(clerkId)) {
        const row: UserRow = {
          id: id || freshId("u"),
          clerk_user_id: clerkId,
          handle: null,
          display_name: null,
          avatar: null,
          age_verified: 0,
          created_at: createdAt,
        };
        users.set(clerkId, row);
        usersById.set(row.id, row);
      }
      return null;
    }
    m = /^SELECT \* FROM users WHERE clerk_user_id = \?/i.exec(s);
    if (m) {
      const clerkId = b[0] as string;
      return users.get(clerkId) ?? null;
    }
    // tickets: insert with on-conflict update
    m = /^INSERT INTO tickets [\s\S]*RETURNING \*/i.exec(s);
    if (m) {
      const [id, userId, serial, raceKey, payload, state, payoutBase, , createdAt] = b as [
        string,
        string,
        string,
        string,
        string,
        string,
        number,
        unknown,
        number,
      ];
      const row: TicketRow = {
        id,
        user_id: userId,
        serial,
        race_key: raceKey,
        payload,
        state,
        payout_base: payoutBase,
        returned: null,
        created_at: createdAt,
      };
      tickets.set(id, row);
      return row;
    }
    // tickets: list by user_id
    m = /^SELECT [\s\S]*FROM tickets[\s\S]*WHERE user_id = \?[\s\S]*ORDER BY created_at DESC/i.exec(s);
    if (m) {
      const userId = b[0] as string;
      const rows = [...tickets.values()]
        .filter((t) => t.user_id === userId)
        .sort((a, c) => c.created_at - a.created_at);
      return rows[0] ?? null;
    }
    // tickets: find by id
    m = /^SELECT [\s\S]*FROM tickets[\s\S]*WHERE id = \?/i.exec(s);
    if (m) {
      const id = b[0] as string;
      return tickets.get(id) ?? null;
    }
    // tickets: update by id + user_id
    m = /^UPDATE tickets SET state = \?, returned = \?, payload = \? WHERE id = \? AND user_id = \?/i.exec(s);
    if (m) {
      const [newState, newReturned, newPayload, id, userId] = b as [
        string,
        number | null,
        string,
        string,
        string,
      ];
      const existing = tickets.get(id);
      if (existing && existing.user_id === userId) {
        const row: TicketRow = {
          ...existing,
          state: newState,
          returned: newReturned,
          payload: newPayload,
        };
        tickets.set(id, row);
        return row;
      }
      return null;
    }
    return null;
  }

  async function runAll<T>(sql: string, b: unknown[]): Promise<T[] | null> {
    const s = sql.trim();
    const m = /^SELECT [\s\S]*FROM tickets[\s\S]*WHERE user_id = \?[\s\S]*ORDER BY created_at DESC/i.exec(s);
    if (m) {
      const userId = b[0] as string;
      return [...tickets.values()]
        .filter((t) => t.user_id === userId)
        .sort((a, c) => c.created_at - a.created_at) as unknown as T[];
    }
    return [];
  }

  const db = { prepare: stmt };
  return { db: db as unknown as D1Database, calls, users, usersById, tickets };
}

const BASE_ENV: Omit<Env, "DB"> = {
  CLERK_ISSUER: "https://example.clerk.accounts.dev",
  ALLOWED_ORIGINS: "https://app.example.com,http://localhost:5173",
};

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://social.example.workers.dev${path}`, init);
}

/** Headers dict with a Bearer token; spread into the `headers:` field of a request. */
function authed(token = "good.jwt"): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function jwtSub(sub: string) {
  return vi.mocked(jwtVerify).mockResolvedValueOnce({
    payload: { sub },
  } as Awaited<ReturnType<typeof jwtVerify>>);
}

/** Minimal CommittedTicket body the Worker accepts (extra fields pass through). */
function sampleTicketBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "kb-abc",
    serial: "KB-ABC123",
    state: "open",
    payoutBase: 5000,
    createdAt: 1_700_000_000_000,
    race: { raceKey: "20260621|Hanshin|11|Takarazuka Kinen" },
    unit: 200,
    ticket: { type: "quinella", lines: [] },
    ...overrides,
  };
}

describe("social Worker — Phase 1 (identity)", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so the mockResolvedValueOnce queue is
    // purged between tests. clearAllMocks leaves stale once-entries that leak
    // across tests and break later assertions.
    vi.resetAllMocks();
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
    jwtSub("user_abc");
    const { db, calls } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me", { headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ clerk_user_id: "user_abc", age_verified: 0 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => /INSERT INTO users/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DO UPDATE SET age_verified/i.test(c.sql))).toBe(false);
  });

  it("writes age_verified on POST {age_verified:1} via ON CONFLICT DO UPDATE", async () => {
    jwtSub("user_abc");
    const { db, calls } = makeFakeD1();
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
    jwtSub("user_abc");
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
  });
});

describe("social Worker — Phase 2 (ticket persistence)", () => {
  beforeEach(() => {
    // See Phase 1 suite above for why resetAllMocks.
    vi.resetAllMocks();
  });

  it("rejects every ticket route with 401 without a valid token", async () => {
    const { db } = makeFakeD1();
    const cases = [
      { method: "GET", path: "/api/social/tickets" },
      { method: "POST", path: "/api/social/tickets", body: JSON.stringify(sampleTicketBody()) },
      { method: "PATCH", path: "/api/social/tickets/kb-1", body: JSON.stringify({ state: "won" }) },
    ];
    for (const c of cases) {
      const res = await worker.fetch(
        req(c.path, { method: c.method, body: c.body }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(401);
    }
  });

  it("POST inserts a ticket and GET returns it (newest-first)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    // first POST is the implicit upsert via handleTickets (POST /me equivalent),
    // then the actual ticket insert.
    const postRes = await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-post-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // eslint-disable-next-line no-console
    expect(postRes.status).toBe(200);
    const posted = (await postRes.json()) as Record<string, unknown>;
    expect(posted).toMatchObject({ id: "kb-post-1", state: "open" });

    // Second ticket as an older one to verify DESC ordering.
    jwtSub("user_abc");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(
          sampleTicketBody({ id: "kb-post-0", createdAt: 1_699_000_000_000 }),
        ),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    jwtSub("user_abc");
    const getRes = await worker.fetch(
      req("/api/social/tickets", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(getRes.status).toBe(200);
    const list = (await getRes.json()) as { tickets: Record<string, unknown>[] };
    expect(list.tickets).toHaveLength(2);
    expect(list.tickets[0]).toMatchObject({ id: "kb-post-1" });
    expect(list.tickets[1]).toMatchObject({ id: "kb-post-0" });
  });

  it("rejects POST with a malformed body (bad id / state / race_key)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const badBodies = [
      sampleTicketBody({ id: "" }),
      sampleTicketBody({ state: "bogus" }),
      sampleTicketBody({ payoutBase: "string-not-number" }),
      sampleTicketBody({ race: { raceKey: "" } }),
    ];
    for (const body of badBodies) {
      jwtSub("user_abc");
      const res = await worker.fetch(
        req("/api/social/tickets", {
          method: "POST",
          headers: { ...authed(), "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(400);
    }
  });

  it("PATCH by the owner updates state + returned and returns the patched body", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-patch-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("user_abc");
    const res = await worker.fetch(
      req("/api/social/tickets/kb-patch-1", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "won", returned: 12300 }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: "kb-patch-1", state: "won", returned: 12300 });
  });

  it("PATCH by a non-owner returns 403 (ownership enforced)", async () => {
    // Owner commits a ticket.
    jwtSub("user_owner");
    const { db } = makeFakeD1();
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-own-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    // Different signed-in user tries to PATCH it.
    jwtSub("user_snoop");
    const res = await worker.fetch(
      req("/api/social/tickets/kb-own-1", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "won", returned: 99999 }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    // And the row is unchanged when re-read by the owner.
    jwtSub("user_owner");
    const getRes = await worker.fetch(
      req("/api/social/tickets", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const list = (await getRes.json()) as { tickets: Record<string, unknown>[] };
    expect(list.tickets[0]).toMatchObject({ id: "kb-own-1", state: "open" });
  });

  it("PATCH on an unknown id returns 404", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/tickets/never-committed", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "won" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("owner's GET never reveals another user's tickets", async () => {
    // user A commits one ticket.
    jwtSub("user_a");
    const { db } = makeFakeD1();
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-a-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // user B commits a different ticket.
    jwtSub("user_b");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-b-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // A's feed shows only A's ticket.
    jwtSub("user_a");
    const res = await worker.fetch(
      req("/api/social/tickets", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const list = (await res.json()) as { tickets: Record<string, unknown>[] };
    expect(list.tickets).toHaveLength(1);
    expect(list.tickets[0]).toMatchObject({ id: "kb-a-1" });
  });

  it("ignores unknown state values on PATCH (state column is constrained)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-constrain-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("user_abc");
    const res = await worker.fetch(
      req("/api/social/tickets/kb-constrain-1", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        // State "cancelled" is not in {open, won, miss}; resolver must skip it.
        body: JSON.stringify({ state: "cancelled" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("open");
  });

  it("reflects CORS allow-origin on a ticket 200 (PATCH allowed method)", async () => {
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/tickets", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PATCH");
  });
});
