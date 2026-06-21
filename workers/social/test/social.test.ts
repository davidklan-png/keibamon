import { describe, it, expect, vi, beforeEach } from "vitest";

// ADR-0007 Phase 3 — social Worker tests.
//
// The fake D1 here is a TINY in-memory engine: it pattern-matches the specific
// statements the Worker issues and maintains state across calls. This lets the
// tests exercise REAL ownership enforcement + Phase 3 social rules (PK dedupe,
// won-only cheer, self-cheer block, follow graph, handle uniqueness, rate
// limits) without spinning up a real D1.
//
// Jose is mocked so no real network fetch happens. The contract under test is
// purely the Worker's request/response shape + auth branching + the social graph.

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

interface FollowRow {
  follower_id: string;
  followee_id: string;
  created_at: number;
}

interface CheerRow {
  ticket_id: string;
  user_id: string;
  created_at: number;
}

interface RateLimitRow {
  user_id: string;
  action: string;
  bucket: number;
  count: number;
}

interface FakeD1Options {
  /** Optional initial state — handy for seeding an owner + a non-owner. */
  users?: UserRow[];
  tickets?: TicketRow[];
  follows?: FollowRow[];
  cheers?: CheerRow[];
  /** Legacy Phase 1 shape (`makeFakeD1({ row })`) — accepted but ignored. */
  row?: Record<string, unknown> | null;
}

function makeFakeD1(opts: FakeD1Options = {}) {
  const users = new Map<string, UserRow>(); // by clerk_user_id
  const usersById = new Map<string, UserRow>(); // by id
  const tickets = new Map<string, TicketRow>(); // by id
  const follows = new Set<string>(); // "follower_id|followee_id"
  const cheers = new Set<string>(); // "ticket_id|user_id"
  const rateLimits = new Map<string, RateLimitRow>(); // key: user|action|bucket
  const calls: PreparedCall[] = [];
  let nonce = 0;

  for (const u of opts.users ?? []) {
    users.set(u.clerk_user_id, u);
    usersById.set(u.id, u);
  }
  for (const t of opts.tickets ?? []) tickets.set(t.id, t);
  for (const f of opts.follows ?? []) follows.add(`${f.follower_id}|${f.followee_id}`);
  for (const c of opts.cheers ?? []) cheers.add(`${c.ticket_id}|${c.user_id}`);

  function freshId(prefix: string): string {
    nonce += 1;
    return `${prefix}-${nonce.toString(36)}`;
  }

  // Handle uniqueness — mirrors the partial unique index. Tracks non-null
  // handles so two users setting the same handle is a 409.
  const handlesTaken = new Set<string>();
  for (const u of usersById.values()) {
    if (u.handle) handlesTaken.add(u.handle);
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

  // Helper: parse a SET clause for handle/display_name/avatar/age_verified.
  // Returns the (col, bindingIndex) pairs in order.
  function parseSetClause(sql: string, allBinds: unknown[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // Match "col = ?" occurrences in order after "DO UPDATE SET".
    const m = /DO UPDATE SET (.+?)(\s+RETURNING|\s+WHERE|$)/s.exec(sql);
    if (!m) return out;
    const setList = m[1];
    const cols = [...setList.matchAll(/(\w+)\s*=\s*\?/g)].map((x) => x[1]);
    // Bindings after the INSERT values: id, clerk_id, age_verified, created_at, then SET binds.
    for (let i = 0; i < cols.length; i++) {
      out[cols[i]] = allBinds[4 + i];
    }
    return out;
  }

  async function runOne(sql: string, b: unknown[]): Promise<unknown> {
    const s = sql.trim();
    // ---- USERS ----
    // Phase 3: INSERT ... DO UPDATE SET (with handle/dn/avatar/age_verified).
    // Detect any DO UPDATE SET (the Phase 1 age_verified-only path also lands here).
    let m = /^INSERT INTO users [\s\S]*ON CONFLICT\(clerk_user_id\) DO UPDATE SET[\s\S]*RETURNING \*/i.exec(s);
    if (m) {
      const [id, clerkId, ageVerified, createdAt] = b as [string, string, number, number];
      const existing = users.get(clerkId);
      const sets = parseSetClause(s, b);
      // Handle uniqueness: if changing handle to a non-null value that's taken
      // by ANOTHER clerk user, raise a UNIQUE-style error so the Worker maps
      // it to handle_taken.
      const newHandle = "handle" in sets ? (sets.handle as string | null) : undefined;
      if (newHandle !== undefined) {
        const ownerOfHandle = [...usersById.values()].find((u) => u.handle === newHandle);
        if (ownerOfHandle && ownerOfHandle.clerk_user_id !== clerkId) {
          const err = new Error("UNIQUE constraint failed: users.handle");
          (err as Error & { name?: string }).name = "ConstraintError";
          throw err;
        }
      }
      const row: UserRow = existing
        ? {
            ...existing,
            ...(sets.age_verified !== undefined ? { age_verified: sets.age_verified as number } : {}),
            ...(sets.handle !== undefined ? { handle: sets.handle as string | null } : {}),
            ...(sets.display_name !== undefined ? { display_name: sets.display_name as string | null } : {}),
            ...(sets.avatar !== undefined ? { avatar: sets.avatar as string | null } : {}),
          }
        : {
            id: id || freshId("u"),
            clerk_user_id: clerkId,
            handle: (sets.handle as string | null) ?? null,
            display_name: (sets.display_name as string | null) ?? null,
            avatar: (sets.avatar as string | null) ?? null,
            age_verified: sets.age_verified !== undefined ? (sets.age_verified as number) : ageVerified,
            created_at: createdAt,
          };
      // Maintain handle index.
      if (existing?.handle) handlesTaken.delete(existing.handle);
      if (row.handle) handlesTaken.add(row.handle);
      users.set(clerkId, row);
      usersById.set(row.id, row);
      return row;
    }
    // users: insert-or-nothing then read by clerk_user_id
    m = /^INSERT INTO users [\s\S]*ON CONFLICT\(clerk_user_id\) DO NOTHING/i.exec(s);
    if (m) {
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
    m = /^SELECT \* FROM users WHERE id = \?/i.exec(s);
    if (m) {
      const id = b[0] as string;
      return usersById.get(id) ?? null;
    }
    m = /^SELECT \* FROM users WHERE handle = \?/i.exec(s);
    if (m) {
      const handle = b[0] as string;
      return [...usersById.values()].find((u) => u.handle === handle) ?? null;
    }

    // ---- TICKETS ----
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
    // tickets: update by id + user_id (multi-line tolerant — the SQL spans
    // three lines in patchTicket, so a strict "^UPDATE tickets SET " fails).
    m = /^UPDATE tickets\s+SET state = \?, returned = \?, payload = \?\s+WHERE id = \? AND user_id = \?/i.exec(s);
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

    // ---- FOLLOWS ----
    m = /^INSERT INTO follows[\s\S]*ON CONFLICT\(follower_id, followee_id\) DO NOTHING/i.exec(s);
    if (m) {
      const [followerId, followeeId] = b as [string, string];
      follows.add(`${followerId}|${followeeId}`);
      return null;
    }
    m = /^DELETE FROM follows WHERE follower_id = \? AND followee_id = \?/i.exec(s);
    if (m) {
      const [followerId, followeeId] = b as [string, string];
      follows.delete(`${followerId}|${followeeId}`);
      return null;
    }
    m = /^SELECT 1 FROM follows WHERE follower_id = \? AND followee_id = \?/i.exec(s);
    if (m) {
      const [followerId, followeeId] = b as [string, string];
      return follows.has(`${followerId}|${followeeId}`) ? { "1": 1 } : null;
    }
    m = /^SELECT COUNT\(\*\) AS n FROM follows WHERE followee_id = \?/i.exec(s);
    if (m) {
      const followeeId = b[0] as string;
      const n = [...follows].filter((f) => f.endsWith(`|${followeeId}`)).length;
      return { n };
    }
    m = /^SELECT COUNT\(\*\) AS n FROM follows WHERE follower_id = \?/i.exec(s);
    if (m) {
      const followerId = b[0] as string;
      const n = [...follows].filter((f) => f.startsWith(`${followerId}|`)).length;
      return { n };
    }

    // ---- CHEERS ----
    m = /^INSERT INTO cheers[\s\S]*ON CONFLICT\(ticket_id, user_id\) DO NOTHING/i.exec(s);
    if (m) {
      const [ticketId, userId] = b as [string, string];
      cheers.add(`${ticketId}|${userId}`);
      return null;
    }
    m = /^DELETE FROM cheers WHERE ticket_id = \? AND user_id = \?/i.exec(s);
    if (m) {
      const [ticketId, userId] = b as [string, string];
      cheers.delete(`${ticketId}|${userId}`);
      return null;
    }
    m = /^SELECT 1 FROM cheers WHERE ticket_id = \? AND user_id = \?/i.exec(s);
    if (m) {
      const [ticketId, userId] = b as [string, string];
      return cheers.has(`${ticketId}|${userId}`) ? { "1": 1 } : null;
    }
    m = /^SELECT COUNT\(\*\) AS n FROM cheers WHERE ticket_id = \?/i.exec(s);
    if (m) {
      const ticketId = b[0] as string;
      const n = [...cheers].filter((c) => c.startsWith(`${ticketId}|`)).length;
      return { n };
    }

    // ---- RATE LIMITS ----
    m = /^INSERT INTO rate_limits[\s\S]*ON CONFLICT\(user_id, action, bucket\) DO UPDATE SET count = count \+ 1[\s\S]*RETURNING count/i.exec(s);
    if (m) {
      const [userId, action, bucket] = b as [string, string, number];
      const key = `${userId}|${action}|${bucket}`;
      const existing = rateLimits.get(key);
      const next = existing ? existing.count + 1 : 1;
      rateLimits.set(key, { user_id: userId, action, bucket, count: next });
      return { count: next };
    }

    // ---- FEED / PROFILE / FRIENDS JOINs (compute from in-memory state) ----
    // These are the SELECT ... FROM tickets t JOIN users u ... LEFT JOIN cheers
    // shapes. We detect by the JOIN clause and recompute from the maps.
    if (/FROM tickets t\s+JOIN users u ON u\.id = t\.user_id/i.test(s)) {
      // Two variants: feed (WHERE user_id = ? OR user_id IN (SELECT followee_id...))
      // and profile (WHERE user_id = ?). The first bind is the user_id (or
      // the profile user's id). Distinguish by the second bind slot.
      const userId = b[0] as string;
      const limitMatch = /LIMIT (\d+)/i.exec(s);
      const limit = limitMatch ? Number(limitMatch[1]) : 100;

      // Feed variant has `OR t.user_id IN (SELECT followee_id FROM follows...)`
      // and binds userId twice. Profile binds once.
      const isFeed = /OR t\.user_id IN \(SELECT followee_id FROM follows/i.test(s);
      let scope: TicketRow[];
      if (isFeed) {
        const followees = new Set(
          [...follows]
            .filter((f) => f.startsWith(`${userId}|`))
            .map((f) => f.split("|")[1]),
        );
        scope = [...tickets.values()].filter(
          (t) => t.user_id === userId || followees.has(t.user_id),
        );
      } else {
        scope = [...tickets.values()].filter((t) => t.user_id === userId);
      }
      scope.sort((a, c) => c.created_at - a.created_at);
      return null; // .all() path handles the array; first() not used on JOINs.
    }

    return null;
  }

  async function runAll<T>(sql: string, b: unknown[]): Promise<T[] | null> {
    const s = sql.trim();

    // tickets: list by user_id (legacy Phase 2 path)
    const legacyTickets = /^SELECT [\s\S]*FROM tickets[\s\S]*WHERE user_id = \?[\s\S]*ORDER BY created_at DESC/i.exec(s);
    if (legacyTickets && !/JOIN users u/i.test(s)) {
      const userId = b[0] as string;
      return [...tickets.values()]
        .filter((t) => t.user_id === userId)
        .sort((a, c) => c.created_at - a.created_at) as unknown as T[];
    }

    // Feed / profile JOIN.
    if (/FROM tickets t\s+JOIN users u ON u\.id = t\.user_id/i.test(s)) {
      const userId = b[0] as string;
      const limitMatch = /LIMIT (\d+)/i.exec(s);
      const limit = limitMatch ? Number(limitMatch[1]) : 100;
      const isFeed = /OR t\.user_id IN \(SELECT followee_id FROM follows/i.test(s);
      let scope: TicketRow[];
      if (isFeed) {
        const followees = new Set(
          [...follows]
            .filter((f) => f.startsWith(`${userId}|`))
            .map((f) => f.split("|")[1]),
        );
        scope = [...tickets.values()].filter(
          (t) => t.user_id === userId || followees.has(t.user_id),
        );
      } else {
        scope = [...tickets.values()].filter((t) => t.user_id === userId);
      }
      scope.sort((a, c) => c.created_at - a.created_at);
      const out = scope.slice(0, limit).map((t) => {
        const owner = usersById.get(t.user_id);
        const n = [...cheers].filter((c) => c.startsWith(`${t.id}|`)).length;
        return {
          ...t,
          owner_handle: owner?.handle ?? null,
          owner_display_name: owner?.display_name ?? null,
          owner_avatar: owner?.avatar ?? null,
          cheers_count: n,
        } as unknown as T;
      });
      return out;
    }

    // Friends-on-race / friends-on-card: SELECT DISTINCT u.handle, u.display_name, u.avatar
    // FROM follows f JOIN users u ... WHERE EXISTS (SELECT 1 FROM tickets t ...)
    if (/SELECT DISTINCT u\.handle, u\.display_name, u\.avatar\s+FROM follows f\s+JOIN users u/i.test(s)) {
      const followerId = b[0] as string;
      const followees = new Set(
        [...follows]
          .filter((f) => f.startsWith(`${followerId}|`))
          .map((f) => f.split("|")[1]),
      );
      // Friends-on-race: EXISTS (race_key = ?)  → b = [followerId, raceKey]
      // Friends-on-card: EXISTS (race_key IN (?,?,..))  → b = [followerId, ...raceKeys]
      const raceKeys = new Set(b.slice(1).map(String));
      const out: T[] = [];
      const seen = new Set<string>();
      for (const t of tickets.values()) {
        if (!followees.has(t.user_id)) continue;
        if (raceKeys.size > 0 && !raceKeys.has(t.race_key)) continue;
        if (seen.has(t.user_id)) continue;
        seen.add(t.user_id);
        const owner = usersById.get(t.user_id);
        out.push({
          handle: owner?.handle ?? null,
          display_name: owner?.display_name ?? null,
          avatar: owner?.avatar ?? null,
        } as unknown as T);
      }
      return out;
    }

    return [];
  }

  const db = { prepare: stmt };
  return {
    db: db as unknown as D1Database,
    calls,
    users,
    usersById,
    tickets,
    follows,
    cheers,
    rateLimits,
  };
}

const BASE_ENV: Omit<Env, "DB"> = {
  CLERK_ISSUER: "https://example.clerk.accounts.dev",
  ALLOWED_ORIGINS: "https://app.example.com,http://localhost:5173",
  LIVE_BASE: "https://racing.example.workers.dev",
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

  it("CORS allow-methods includes DELETE (Phase 3)", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:5173" },
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
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

// ---------------------------------------------------------------------------
// Phase 3 — follows, cheers, profiles, feed, friends, rate limits, handles.
// ---------------------------------------------------------------------------

describe("social Worker — Phase 3 (social graph)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 on every authed Phase 3 route without a token", async () => {
    const { db } = makeFakeD1();
    const cases = [
      { method: "POST", path: "/api/social/follow/u-target" },
      { method: "DELETE", path: "/api/social/follow/u-target" },
      { method: "POST", path: "/api/social/tickets/kb-1/cheer" },
      { method: "DELETE", path: "/api/social/tickets/kb-1/cheer" },
      { method: "GET", path: "/api/social/feed" },
      { method: "GET", path: "/api/social/friends/on-card" },
      { method: "GET", path: "/api/social/races/20260621|Hanshin|11|Takarazuka/friends" },
    ];
    for (const c of cases) {
      const res = await worker.fetch(
        req(c.path, { method: c.method }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(401);
    }
    // GET /api/social/users/:handle is PUBLIC — no 401 without a token.
    const profileRes = await worker.fetch(
      req("/api/social/users/somehandle", { method: "GET" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(profileRes.status).not.toBe(401);
  });

  it("follow is idempotent: following the same user twice yields one row, both 200", async () => {
    // Seed two users by POSTing /me with distinct clerk subs.
    const { db, follows, usersById } = makeFakeD1();
    jwtSub("clerk_a");
    const aRes = await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const a = (await aRes.json()) as { id: string };
    jwtSub("clerk_b");
    const bRes = await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const b = (await bRes.json()) as { id: string };
    expect(usersById.size).toBe(2);

    // A follows B twice.
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req(`/api/social/follow/${b.id}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(200);
    jwtSub("clerk_a");
    const r2 = await worker.fetch(
      req(`/api/social/follow/${b.id}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(200);
    expect(follows.size).toBe(1);
    void a;
  });

  it("self-follow is forbidden: POST /follow/<self> returns 403", async () => {
    const { db, follows } = makeFakeD1();
    jwtSub("clerk_a");
    const me = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/follow/${me.id}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cannot_follow_self" });
    expect(follows.size).toBe(0);
  });

  it("follow returns 404 when the target user does not exist", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/follow/never-existed`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("unfollow is idempotent: DELETE on a non-followed user returns 200, no rows", async () => {
    const { db, follows } = makeFakeD1();
    jwtSub("clerk_a");
    const a = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_b");
    const b = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/follow/${b.id}`, { method: "DELETE", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(follows.size).toBe(0);
    void a;
  });

  it("cheer dedupe: cheering the same ticket twice leaves one row, count stays 1", async () => {
    // A owns a 'won' ticket. B cheers it twice.
    const { db, cheers } = makeFakeD1();
    jwtSub("clerk_a");
    const a = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-cheer-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets/kb-cheer-1", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "won", returned: 9000 }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    const r1 = await worker.fetch(
      req("/api/social/tickets/kb-cheer-1/cheer", { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ count: 1, cheeredByMe: true });
    jwtSub("clerk_b");
    const r2 = await worker.fetch(
      req("/api/social/tickets/kb-cheer-1/cheer", { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ count: 1, cheeredByMe: true });
    expect(cheers.size).toBe(1);
    void a;
  });

  it("cheer is won-only: cheering an 'open' ticket returns 409 {error:'not_won'}", async () => {
    const { db, cheers } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-open-1", state: "open" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    const res = await worker.fetch(
      req("/api/social/tickets/kb-open-1/cheer", { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_won" });
    expect(cheers.size).toBe(0);
  });

  it("self-cheer is forbidden: POST /tickets/:id/cheer by the owner returns 409", async () => {
    const { db, cheers } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-self-1", state: "won" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/tickets/kb-self-1/cheer", { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "cannot_cheer_own_ticket" });
    expect(cheers.size).toBe(0);
  });

  it("uncheer is idempotent: DELETE on a non-cheered ticket returns 200 with count 0", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-unc-1", state: "won" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    const res = await worker.fetch(
      req("/api/social/tickets/kb-unc-1/cheer", { method: "DELETE", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 0, cheeredByMe: false });
  });

  it("public profile response omits clerk_user_id, email, age_verified", async () => {
    // Seed a user WITH a handle.
    const { db } = makeFakeD1({
      users: [
        {
          id: "u-seed",
          clerk_user_id: "clerk_seeded",
          handle: "alyssa",
          display_name: "Alyssa",
          avatar: null,
          age_verified: 1,
          created_at: 100,
        },
      ],
    });
    const res = await worker.fetch(
      req("/api/social/users/alyssa", { method: "GET" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.handle).toBe("alyssa");
    expect(body).not.toHaveProperty("clerk_user_id");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("age_verified");
  });

  it("profile for unknown handle returns 404", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/users/nobody", { method: "GET" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("feed includes own + followed users' tickets", async () => {
    // A and B each have a ticket. A follows B. A's feed has both.
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const a = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-feed-a" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    const b = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-feed-b" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    // A follows B.
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/follow/${b.id}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/feed", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tickets: { id: string }[] };
    const ids = body.tickets.map((t) => t.id).sort();
    expect(ids).toEqual(["kb-feed-a", "kb-feed-b"]);
    void a;
  });

  it("feed EXCLUDES tickets from users the caller does NOT follow", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-feed-a2" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_c");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-feed-c" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // A does NOT follow C.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/feed", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const body = (await res.json()) as { tickets: { id: string }[] };
    const ids = body.tickets.map((t) => t.id);
    expect(ids).toContain("kb-feed-a2");
    expect(ids).not.toContain("kb-feed-c");
  });

  it("friends-on-race: returns count + avatar for a followed user with a ticket on that race", async () => {
    const { db } = makeFakeD1();
    const raceKey = "20260621|Hanshin|11|Takarazuka Kinen";
    jwtSub("clerk_b");
    const b = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-race-b", race: { raceKey } })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/follow/${b.id}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/races/${encodeURIComponent(raceKey)}/friends`, {
        method: "GET",
        headers: authed(),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; avatars: unknown[] };
    expect(body.count).toBe(1);
    expect(body.avatars).toHaveLength(1);
  });

  it("rate limit: 31st follow in a minute returns 429 + Retry-After", async () => {
    const { db, usersById } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // Seed 30 distinct followees so the first 30 follows succeed.
    for (let i = 0; i < 30; i++) {
      jwtSub(`clerk_target_${i}`);
      await worker.fetch(
        req("/api/social/me", { method: "GET", headers: authed() }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
    }
    for (let i = 0; i < 30; i++) {
      jwtSub("clerk_a");
      const target = [...usersById.values()].find(
        (u) => u.clerk_user_id === `clerk_target_${i}`,
      )!;
      const res = await worker.fetch(
        req(`/api/social/follow/${target.id}`, { method: "POST", headers: authed() }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
    }
    // 31st follow: a fresh target (still under the dedupe limit since this is
    // a different followee), but the rate-limit bucket is now saturated.
    jwtSub("clerk_target_31");
    const t31 = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/follow/${t31.id}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("handle uniqueness: two users setting the same handle → second gets 409 {error:'handle_taken'}", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alyssa" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(200);
    jwtSub("clerk_b");
    const r2 = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alyssa" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(409);
    expect(await r2.json()).toMatchObject({ error: "handle_taken" });
  });

  it("rejects malformed handle on POST /me (bad characters / too long)", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "has space" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(400);
    jwtSub("clerk_a");
    const r2 = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "x".repeat(33) }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(400);
  });

  it("profile viewer with JWT populates is_following; without JWT it omits / defaults false", async () => {
    const { db } = makeFakeD1({
      users: [
        {
          id: "u-target",
          clerk_user_id: "clerk_target",
          handle: "viewee",
          display_name: "Viewee",
          avatar: null,
          age_verified: 0,
          created_at: 1,
        },
      ],
    });
    jwtSub("clerk_viewer");
    // Establish viewer profile, then follow.
    const viewer = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    jwtSub("clerk_viewer");
    await worker.fetch(
      req(`/api/social/follow/u-target`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    jwtSub("clerk_viewer");
    const authedRes = await worker.fetch(
      req("/api/social/users/viewee", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const authedBody = (await authedRes.json()) as Record<string, unknown>;
    expect(authedBody.is_following).toBe(true);

    const anonRes = await worker.fetch(
      req("/api/social/users/viewee", { method: "GET" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const anonBody = (await anonRes.json()) as Record<string, unknown>;
    expect(anonBody.is_following).toBe(false);
    void viewer;
  });
});
