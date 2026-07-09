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
  placings?: string | null;
  /** Stage 4 derived flat columns (optional — mirror src/core.ts TicketRow). */
  ticket_type?: string | null;
  line_count?: number | null;
  cost?: number | null;
  unit?: number | null;
  structure?: string | null;
  venue?: string | null;
  race_no?: number | null;
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

interface BlockRow {
  blocker_id: string;
  blocked_id: string;
  created_at: number;
}

interface ReportRow {
  id: string;
  reporter_id: string;
  target_type: "ticket" | "user";
  target_id: string;
  reason: string;
  created_at: number;
}

interface FakeD1Options {
  /** Optional initial state — handy for seeding an owner + a non-owner. */
  users?: UserRow[];
  tickets?: TicketRow[];
  follows?: FollowRow[];
  cheers?: CheerRow[];
  blocks?: BlockRow[];
  reports?: ReportRow[];
  /** Legacy Phase 1 shape (`makeFakeD1({ row })`) — accepted but ignored. */
  row?: Record<string, unknown> | null;
}

function makeFakeD1(opts: FakeD1Options = {}) {
  const users = new Map<string, UserRow>(); // by clerk_user_id
  const usersById = new Map<string, UserRow>(); // by id
  const tickets = new Map<string, TicketRow>(); // by id
  const follows = new Set<string>(); // "follower_id|followee_id"
  const cheers = new Set<string>(); // "ticket_id|user_id"
  const blocks = new Set<string>(); // "blocker_id|blocked_id"
  const reports: ReportRow[] = [];
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
  for (const b of opts.blocks ?? []) blocks.add(`${b.blocker_id}|${b.blocked_id}`);
  for (const r of opts.reports ?? []) reports.push(r);

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
        // Case-insensitive (0010 idx_users_handle_ci_unique): "Bob" and "bob"
        // collide, so a claim matching another user's handle in any case raises.
        const nh = newHandle == null ? null : newHandle.toLowerCase();
        const ownerOfHandle = [...usersById.values()].find(
          (u) => u.handle != null && u.handle.toLowerCase() === nh,
        );
        if (ownerOfHandle && ownerOfHandle.clerk_user_id !== clerkId) {
          const err = new Error("UNIQUE constraint failed: users.lower(handle)");
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
    m = /^SELECT \* FROM users WHERE lower\(handle\) = lower\(\?\)/i.exec(s);
    if (m) {
      // Case-insensitive handle lookup (userByHandle, post-0010).
      const handle = String(b[0]).toLowerCase();
      return [...usersById.values()].find((u) => u.handle?.toLowerCase() === handle) ?? null;
    }

    // ---- TICKETS ----
    m = /^INSERT INTO tickets [\s\S]*RETURNING \*/i.exec(s);
    if (m) {
      // 15 binds: id,user_id,serial,race_key,payload,state,payout_base,created_at,
      // then the Stage 4 flat columns (returned is literal NULL in the SQL).
      const [id, userId, serial, raceKey, payload, state, payoutBase, createdAt, ticketType, lineCount, cost, unit, structure, venue, raceNo] = b as [
        string, string, string, string, string, string, number, number,
        string | null, number | null, number | null, number | null, string | null, string | null, number | null,
      ];
      // Model the conditional upsert: ON CONFLICT(id) DO UPDATE SET ...
      // WHERE existing.user_id = excluded.user_id AND existing.state = 'open'.
      // A conflicting row that fails the WHERE returns no row (RETURNING empty),
      // exactly like real SQLite — insertTicket then re-reads to classify.
      const prior = tickets.get(id);
      if (prior && (prior.user_id !== userId || prior.state !== "open")) {
        return null;
      }
      const row: TicketRow = {
        id,
        user_id: prior ? prior.user_id : userId,
        serial,
        race_key: raceKey,
        payload,
        state,
        payout_base: payoutBase,
        returned: null,
        created_at: createdAt,
        ticket_type: ticketType,
        line_count: lineCount,
        cost,
        unit,
        structure,
        venue,
        race_no: raceNo,
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
    // The actual SQL writes 4 columns: state, returned, payload, placings.
    // (An older version of this fake matched only 3 — `state, returned,
    // payload` — silently dropping placings AND making the regex miss the
    // real patchTicket UPDATE entirely, so PATCH changes were never
    // persisted to the fake. That pre-existing fixture drift was exposed
    // when the manual-ticket-builder edit guard test did a POST→PATCH→POST
    // roundtrip and the second POST sailed past the guard.)
    m = /^UPDATE tickets\s+SET state = \?, returned = \?, payload = \?, placings = \?\s+WHERE id = \? AND user_id = \?/i.exec(s);
    if (m) {
      const [newState, newReturned, newPayload, newPlacings, id, userId] = b as [
        string,
        number | null,
        string,
        string | null,
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
        // placings lives on TicketRow only optionally — keep it on the fake
        // even though the typed test interface omits it, since patchTicket
        // round-trips it.
        (row as TicketRow & { placings?: string | null }).placings = newPlacings;
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

    // ---- BLOCKS (Phase 4) ----
    m = /^INSERT INTO blocks[\s\S]*ON CONFLICT\(blocker_id, blocked_id\) DO NOTHING/i.exec(s);
    if (m) {
      const [blockerId, blockedId] = b as [string, string];
      blocks.add(`${blockerId}|${blockedId}`);
      return null;
    }
    m = /^DELETE FROM blocks WHERE blocker_id = \? AND blocked_id = \?/i.exec(s);
    if (m) {
      const [blockerId, blockedId] = b as [string, string];
      blocks.delete(`${blockerId}|${blockedId}`);
      return null;
    }
    m = /^SELECT 1 FROM blocks[\s\S]*WHERE \(blocker_id = \? AND blocked_id = \?\)[\s\S]*OR \(blocker_id = \? AND blocked_id = \?\)/i.exec(s);
    if (m) {
      const [aId, bId, cId, dId] = b as [string, string, string, string];
      const exists =
        blocks.has(`${aId}|${bId}`) || blocks.has(`${cId}|${dId}`);
      return exists ? { "1": 1 } : null;
    }

    // ---- REPORTS (Phase 4) ----
    m = /^INSERT INTO reports \(id, reporter_id, target_type, target_id, reason, created_at\)/i.exec(s);
    if (m) {
      const [id, reporterId, targetType, targetId, reason, createdAt] = b as [
        string,
        string,
        "ticket" | "user",
        string,
        string,
        number,
      ];
      // FK check: reporter must exist (we always ensureCaller first, so this
      // passes in practice). target_id existence isn't enforced by FK in the
      // migration (no REFERENCES — target_id can be a ticket OR a user), so
      // we accept any string.
      if (!usersById.has(reporterId)) {
        throw new Error("FK violation: reporter not found");
      }
      reports.push({
        id,
        reporter_id: reporterId,
        target_type: targetType,
        target_id: targetId,
        reason,
        created_at: createdAt,
      });
      return null;
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
      // Phase 4: feed filters out tickets owned by users the viewer blocked.
      // The `NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id = ? ...)`
      // clause adds a third bind (still the viewer's user_id).
      const hasBlockFilter = /NOT EXISTS[\s\S]*FROM blocks[\s\S]*WHERE blocker_id = \?/i.test(s);
      const blockedByViewer = new Set(
        [...blocks]
          .filter((bk) => bk.startsWith(`${userId}|`))
          .map((bk) => bk.split("|")[1]),
      );
      let scope: TicketRow[];
      if (isFeed) {
        const followees = new Set(
          [...follows]
            .filter((f) => f.startsWith(`${userId}|`))
            .map((f) => f.split("|")[1]),
        );
        scope = [...tickets.values()].filter(
          (t) =>
            (t.user_id === userId || followees.has(t.user_id)) &&
            (!hasBlockFilter || !blockedByViewer.has(t.user_id)),
        );
      } else {
        scope = [...tickets.values()].filter(
          (t) =>
            t.user_id === userId &&
            (!hasBlockFilter || !blockedByViewer.has(t.user_id)),
        );
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
      const isFeed = /OR t\.user_id IN \(SELECT followee_id FROM follows/i.test(s);
      const hasBlockFilter = /NOT EXISTS[\s\S]*FROM blocks[\s\S]*WHERE blocker_id = \?/i.test(s);
      // Stage 5: the viewer's-cheer LEFT JOIN (me.user_id = ?) is the FIRST bind.
      // FEED binds [viewer, viewer, viewer, viewer]; PROFILE binds [viewer, profileUser].
      // The scope user is the viewer for feed, the profile user (b[1]) for profile.
      const viewerId = (b[0] as string | null) ?? null;
      const scopeUserId = isFeed ? (viewerId as string) : (b[1] as string);
      const limitMatch = /LIMIT (\d+)/i.exec(s);
      const limit = limitMatch ? Number(limitMatch[1]) : 100;
      const blockedByViewer = new Set(
        [...blocks]
          .filter((bk) => bk.startsWith(`${viewerId}|`))
          .map((bk) => bk.split("|")[1]),
      );
      let scope: TicketRow[];
      if (isFeed) {
        const followees = new Set(
          [...follows]
            .filter((f) => f.startsWith(`${viewerId}|`))
            .map((f) => f.split("|")[1]),
        );
        scope = [...tickets.values()].filter(
          (t) =>
            (t.user_id === scopeUserId || followees.has(t.user_id)) &&
            (!hasBlockFilter || !blockedByViewer.has(t.user_id)),
        );
      } else {
        scope = [...tickets.values()].filter(
          (t) =>
            t.user_id === scopeUserId &&
            (!hasBlockFilter || !blockedByViewer.has(t.user_id)),
        );
      }
      scope.sort((a, c) => c.created_at - a.created_at);
      const out = scope.slice(0, limit).map((t) => {
        const owner = usersById.get(t.user_id);
        const n = [...cheers].filter((c) => c.startsWith(`${t.id}|`)).length;
        const cheeredByMe = viewerId != null && cheers.has(`${t.id}|${viewerId}`);
        return {
          ...t,
          owner_handle: owner?.handle ?? null,
          owner_display_name: owner?.display_name ?? null,
          owner_avatar: owner?.avatar ?? null,
          cheers_count: n,
          cheered_by_me: cheeredByMe ? 1 : 0,
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

    // Friends-on-card BATCHED (Stage 5): SELECT DISTINCT f.followee_id, t.race_key,
    // u.handle, ... FROM follows f JOIN tickets t ON t.user_id = f.followee_id
    // JOIN users u ... WHERE f.follower_id = ? AND t.race_key IN (?,?,..)
    // → b = [followerId, ...raceKeys]. Returns (followee_id, race_key, avatar) rows.
    if (/FROM follows f\s+JOIN tickets t ON t\.user_id = f\.followee_id\s+JOIN users u/i.test(s)) {
      const followerId = b[0] as string;
      const followees = new Set(
        [...follows]
          .filter((f) => f.startsWith(`${followerId}|`))
          .map((f) => f.split("|")[1]),
      );
      const raceKeys = new Set(b.slice(1).map(String));
      const seen = new Set<string>(); // followee_id|race_key
      const out: T[] = [];
      for (const t of tickets.values()) {
        if (!followees.has(t.user_id)) continue;
        if (!raceKeys.has(t.race_key)) continue;
        const key = `${t.user_id}|${t.race_key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const owner = usersById.get(t.user_id);
        out.push({
          followee_id: t.user_id,
          race_key: t.race_key,
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
    blocks,
    reports,
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
    ticket: { type: "quinella", lines: [{ combo: ["1", "2"] }], cost: 200 },
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

  it("POST with the same id of an OPEN ticket edits it in place (payload overwritten)", async () => {
    // The manual-ticket-builder edit flow relies on this: posting the SAME
    // ticket id with a new payload must overwrite the row when state='open'.
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    // 1) Initial create.
    const createBody = sampleTicketBody({
      id: "kb-edit-1",
      payoutBase: 5000,
      ticket: { type: "quinella", lines: [{ combo: ["5", "16"] }] },
    });
    const r1 = await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(200);

    // 2) Edit-in-place: same id, different payload (new combo + new payoutBase).
    jwtSub("user_abc");
    const editBody = sampleTicketBody({
      id: "kb-edit-1",
      payoutBase: 7000,
      ticket: { type: "exacta", lines: [{ combo: ["5", "16"] }] },
    });
    const r2 = await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(editBody),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(200);
    const edited = (await r2.json()) as Record<string, unknown>;
    // Same id (edit-in-place, NOT a duplicate); new payload visible.
    expect(edited).toMatchObject({ id: "kb-edit-1", state: "open", payoutBase: 7000 });
    expect(edited.ticket).toMatchObject({ type: "exacta" });

    // 3) Only one row survives — no duplicate id.
    jwtSub("user_abc");
    const getRes = await worker.fetch(
      req("/api/social/tickets", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const list = (await getRes.json()) as { tickets: Record<string, unknown>[] };
    expect(list.tickets.filter((t) => t.id === "kb-edit-1")).toHaveLength(1);
  });

  it("POST with the same id of a SETTLED ticket returns 409 and leaves the row untouched", async () => {
    // A settled ticket must NOT be editable — settlement state + returned
    // must survive a manual edit attempt. The 409 guard in insertTicket
    // catches this BEFORE the upsert can overwrite state/returned.
    jwtSub("user_abc");
    const { db } = makeFakeD1();
    // 1) Create + settle the ticket via the normal flow.
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-settled-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("user_abc");
    await worker.fetch(
      req("/api/social/tickets/kb-settled-1", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "won", returned: 18400 }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    // 2) Edit attempt via manual-ticket-builder — same id, new payload.
    jwtSub("user_abc");
    const r = await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(
          sampleTicketBody({ id: "kb-settled-1", payoutBase: 9999 }),
        ),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "cannot_edit_settled_ticket" });

    // 3) Row MUST be untouched — settlement state + returned survive.
    jwtSub("user_abc");
    const getRes = await worker.fetch(
      req("/api/social/tickets", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const list = (await getRes.json()) as { tickets: Record<string, unknown>[] };
    const survivor = list.tickets.find((t) => t.id === "kb-settled-1");
    expect(survivor).toMatchObject({
      id: "kb-settled-1",
      state: "won",
      returned: 18400,
      payoutBase: 5000, // NOT the 9999 the rejected POST tried to write
    });
  });

  it("POST of another user's OPEN ticket id is rejected (404, not an oracle) and leaves the row untouched", async () => {
    // Ownership guard: a POST carrying an id that already belongs to ANOTHER
    // user must be rejected before the upsert. The `ON CONFLICT(id) DO UPDATE`
    // does not touch user_id, so without this check the snoop would overwrite
    // the victim's payload while the row stayed attributed to the victim — a
    // silent hijack. We assert 404 (same shape as "not found"), NOT 403, so the
    // endpoint can't be probed to learn which ids are taken.
    jwtSub("user_owner");
    const { db } = makeFakeD1();
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(
          sampleTicketBody({ id: "kb-cross-1", payoutBase: 5000 }),
        ),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    // Snoop reuses the victim's id with a hostile payload.
    jwtSub("user_snoop");
    const r = await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(
          sampleTicketBody({
            id: "kb-cross-1",
            payoutBase: 9999,
            ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }] },
          }),
        ),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });

    // The owner's row MUST be untouched — original payload, still open, still
    // the owner's. (The snoop must NOT appear in their own list either.)
    jwtSub("user_owner");
    const ownerList = (await (
      await worker.fetch(
        req("/api/social/tickets", { method: "GET", headers: authed() }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      )
    ).json()) as { tickets: Record<string, unknown>[] };
    const survivor = ownerList.tickets.find((t) => t.id === "kb-cross-1");
    expect(survivor).toMatchObject({
      id: "kb-cross-1",
      state: "open",
      payoutBase: 5000, // NOT the 9999 the snoop tried to write
    });

    jwtSub("user_snoop");
    const snoopList = (await (
      await worker.fetch(
        req("/api/social/tickets", { method: "GET", headers: authed() }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      )
    ).json()) as { tickets: Record<string, unknown>[] };
    expect(snoopList.tickets.find((t) => t.id === "kb-cross-1")).toBeUndefined();
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

  it("feed sets cheeredByMe via the LEFT JOIN (no per-row lookup)", async () => {
    // Stage 5: cheeredByMe is now folded into the feed query, not an N+1
    // hasCheered() per row. A followed ticket the viewer cheered → true; one
    // they didn't → false. Both in the same feed response.
    const { db } = makeFakeD1();
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
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-feed-cheer" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // Cheers are won-only (Phase 3 rule) — settle the ticket so it can be cheered.
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/tickets/kb-feed-cheer", {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ state: "won", returned: 9000 }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-feed-plain" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // a follows b, then cheers exactly one of b's tickets.
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/follow/${b.id}`, { method: "POST", headers: authed() }), {
      ...BASE_ENV,
      DB: db,
    }, {} as ExecutionContext);
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets/kb-feed-cheer/cheer", { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/feed", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const body = (await res.json()) as { tickets: { id: string; cheeredByMe?: boolean }[] };
    const byId = new Map(body.tickets.map((t) => [t.id, t]));
    expect(byId.get("kb-feed-cheer")?.cheeredByMe).toBe(true);
    expect(byId.get("kb-feed-plain")?.cheeredByMe).toBe(false);
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

  it("friends-on-card (batched): one request returns card count + per-race breakdown", async () => {
    // Stage 5: the endpoint folds the card-level count/avatars AND a per-race
    // breakdown into one response, so MyTickets no longer fans out up-to-12
    // per-race requests per snapshot.
    const { db } = makeFakeD1();
    const rk1 = "20260621|Hanshin|11|Takarazuka Kinen";
    const rk2 = "20260621|Hanshin|12|Panther Stakes";
    jwtSub("clerk_b");
    const b = (await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    ).then((r) => r.json())) as { id: string };
    // b holds a ticket on each of two races.
    for (const [id, rk] of [["kb-c-1", rk1], ["kb-c-2", rk2]] as const) {
      jwtSub("clerk_b");
      await worker.fetch(
        req("/api/social/tickets", {
          method: "POST",
          headers: { ...authed(), "Content-Type": "application/json" },
          body: JSON.stringify(sampleTicketBody({ id, race: { raceKey: rk } })),
        }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
    }
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
    const qs = `race=${encodeURIComponent(rk1)}&race=${encodeURIComponent(rk2)}`;
    const res = await worker.fetch(
      req(`/api/social/friends/on-card?${qs}`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      avatars: unknown[];
      perRace: Record<string, { count: number; avatars: unknown[] }>;
    };
    // Card-level: one distinct friend across the card.
    expect(body.count).toBe(1);
    expect(body.avatars).toHaveLength(1);
    // Per-race: b appears on BOTH races.
    expect(Object.keys(body.perRace).sort()).toEqual([rk1, rk2]);
    expect(body.perRace[rk1].count).toBe(1);
    expect(body.perRace[rk2].count).toBe(1);
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

  it("handle uniqueness is CASE-INSENSITIVE: a case variant of a taken handle → 409", async () => {
    // 0010 swapped the case-sensitive index for lower(handle); "Bob" and "bob"
    // must collide so public profile routing can't split them.
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "Bob" }),
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
        body: JSON.stringify({ handle: "bob" }), // case variant
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(409);
    expect(await r2.json()).toMatchObject({ error: "handle_taken" });
  });

  it("POST /tickets persists the Stage 4 derived flat columns", async () => {
    jwtSub("user_abc");
    const { db, calls } = makeFakeD1();
    const r = await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-flat-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r.status).toBe(200);
    const insertCall = calls.find((c) => /INSERT INTO tickets/i.test(c.sql));
    expect(insertCall, "expected an INSERT INTO tickets call").toBeTruthy();
    // The flat columns are written alongside the payload.
    expect(insertCall!.sql).toMatch(/ticket_type/);
    expect(insertCall!.sql).toMatch(/line_count/);
    expect(insertCall!.sql).toMatch(/\bvenue\b/);
    expect(insertCall!.sql).toMatch(/\brace_no\b/);
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

describe("social Worker — Phase 4 (block + report)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns 401 on every authed Phase 4 route without a token", async () => {
    const { db } = makeFakeD1();
    const cases = [
      { method: "POST", path: "/api/social/block/u-target" },
      { method: "DELETE", path: "/api/social/block/u-target" },
      { method: "POST", path: "/api/social/report" },
    ];
    for (const c of cases) {
      const res = await worker.fetch(
        req(c.path, { method: c.method }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(401);
    }
  });

  /** Helper: seed two users (A + B) by hitting /me with two clerk subs.
   *  Returns their worker-assigned ids so tests can target them. */
  async function seedTwoUsers(db: D1Database): Promise<{ aId: string; bId: string }> {
    jwtSub("clerk_a");
    const aRes = await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const aId = ((await aRes.json()) as { id: string }).id;
    jwtSub("clerk_b");
    const bRes = await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const bId = ((await bRes.json()) as { id: string }).id;
    return { aId, bId };
  }

  it("block is idempotent: blocking the same user twice yields one row, both 200", async () => {
    const { db, blocks } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(200);
    jwtSub("clerk_a");
    const r2 = await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(200);
    expect(blocks.size).toBe(1);
    expect(blocks.has(`${aId}|${bId}`)).toBe(true);
  });

  it("self-block is forbidden: POST /block/<self> returns 403", async () => {
    const { db, blocks } = makeFakeD1();
    const { aId } = await seedTwoUsers(db);

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/block/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cannot_block_self" });
    expect(blocks.size).toBe(0);
  });

  it("block returns 404 when the target user does not exist", async () => {
    const { db } = makeFakeD1();
    await seedTwoUsers(db);

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/block/does-not-exist`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("block severs existing follows in BOTH directions", async () => {
    const { db, blocks, follows } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    // A follows B, B follows A (both directions).
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/follow/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    await worker.fetch(
      req(`/api/social/follow/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(follows.size).toBe(2);

    // A blocks B → both follows should be severed.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(blocks.has(`${aId}|${bId}`)).toBe(true);
    expect(follows.size).toBe(0);
  });

  it("after A blocks B, neither can follow the other (403 blocked)", async () => {
    const { db, blocks } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(blocks.size).toBe(1);

    // A tries to follow B → 403 blocked.
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req(`/api/social/follow/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ error: "blocked" });

    // B tries to follow A → 403 blocked (reverse direction).
    jwtSub("clerk_b");
    const r2 = await worker.fetch(
      req(`/api/social/follow/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(403);
    expect(await r2.json()).toMatchObject({ error: "blocked" });
  });

  it("after A blocks B, neither can cheer the other's WON ticket (403 blocked)", async () => {
    // Seed: A + B + a WON ticket owned by A.
    const { db, tickets } = makeFakeD1({
      tickets: [
        {
          id: "kb-won",
          user_id: "u-a",
          serial: "KB-A1",
          race_key: "20260621|Hanshin|11|Takarazuka Kinen",
          payload: JSON.stringify({ id: "kb-won", serial: "KB-A1" }),
          state: "won",
          payout_base: 5000,
          returned: 6000,
          created_at: 1,
        },
      ],
      users: [
        {
          id: "u-a",
          clerk_user_id: "clerk_a",
          handle: null,
          display_name: null,
          avatar: null,
          age_verified: 1,
          created_at: 1,
        },
        {
          id: "u-b",
          clerk_user_id: "clerk_b",
          handle: null,
          display_name: null,
          avatar: null,
          age_verified: 1,
          created_at: 1,
        },
      ],
    });
    expect(tickets.size).toBe(1);

    // B blocks A.
    jwtSub("clerk_b");
    await worker.fetch(
      req(`/api/social/block/u-a`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    // B tries to cheer A's WON ticket → 403 blocked (reverse direction works
    // because blockExistsEitherDirection).
    jwtSub("clerk_b");
    const res = await worker.fetch(
      req(`/api/social/tickets/kb-won/cheer`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "blocked" });
  });

  it("unblock is idempotent: DELETE on a non-blocked user returns 200", async () => {
    const { db, blocks } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "DELETE", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(blocks.size).toBe(0);
  });

  it("after unblock, follow works again", async () => {
    const { db, follows } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "DELETE", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/follow/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(follows.size).toBe(1);
    void aId;
  });

  it("feed EXCLUDES tickets from users the caller has blocked", async () => {
    // Seed: A + B, B owns a ticket, A follows B (so it'd be in feed), then A blocks B.
    const { db, follows, blocks } = makeFakeD1({
      users: [
        {
          id: "u-a",
          clerk_user_id: "clerk_a",
          handle: null,
          display_name: null,
          avatar: null,
          age_verified: 1,
          created_at: 1,
        },
        {
          id: "u-b",
          clerk_user_id: "clerk_b",
          handle: "b",
          display_name: "B",
          avatar: null,
          age_verified: 1,
          created_at: 1,
        },
      ],
      tickets: [
        {
          id: "kb-b1",
          user_id: "u-b",
          serial: "KB-B1",
          race_key: "20260621|Hanshin|11|Takarazuka Kinen",
          payload: JSON.stringify({ id: "kb-b1", serial: "KB-B1", state: "open" }),
          state: "open",
          payout_base: 5000,
          returned: null,
          created_at: 1,
        },
      ],
    });

    // A follows B (so the ticket would normally be in feed).
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/follow/u-b`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(follows.size).toBe(1);

    // Feed BEFORE block: B's ticket is present.
    jwtSub("clerk_a");
    const beforeRes = await worker.fetch(
      req(`/api/social/feed`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const beforeBody = (await beforeRes.json()) as { tickets: { id: string }[] };
    expect(beforeBody.tickets.find((t) => t.id === "kb-b1")).toBeTruthy();

    // A blocks B.
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/block/u-b`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(blocks.size).toBe(1);
    expect(follows.size).toBe(0); // block severs the follow

    // Feed AFTER block: B's ticket is gone.
    jwtSub("clerk_a");
    const afterRes = await worker.fetch(
      req(`/api/social/feed`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const afterBody = (await afterRes.json()) as { tickets: { id: string }[] };
    expect(afterBody.tickets.find((t) => t.id === "kb-b1")).toBeUndefined();
  });

  it("POST /report stores a row for a valid ticket report", async () => {
    const { db, reports } = makeFakeD1();
    await seedTwoUsers(db);

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/report`, {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: "ticket",
          target_id: "kb-bad",
          reason: "spam",
        }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatchObject({
      target_type: "ticket",
      target_id: "kb-bad",
      reason: "spam",
    });
  });

  it("POST /report rejects bad bodies (bad target_type, empty target_id, too-long reason)", async () => {
    const { db, reports } = makeFakeD1();
    await seedTwoUsers(db);

    const cases: Array<{ body: unknown }> = [
      { body: { target_type: "post", target_id: "x", reason: "x" } }, // bad type
      { body: { target_type: "ticket", target_id: "", reason: "x" } }, // empty id
      { body: { target_type: "ticket", target_id: "x", reason: "x".repeat(501) } }, // too long
      { body: { target_type: "ticket", target_id: "x" } }, // missing reason
    ];
    for (const c of cases) {
      jwtSub("clerk_a");
      const res = await worker.fetch(
        req(`/api/social/report`, {
          method: "POST",
          headers: { ...authed(), "Content-Type": "application/json" },
          body: JSON.stringify(c.body),
        }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(400);
    }
    expect(reports.length).toBe(0);
  });

  it("report rate limit: 11th report in a minute returns 429 + Retry-After", async () => {
    const { db, reports } = makeFakeD1();
    await seedTwoUsers(db);

    // First 10 reports succeed.
    for (let i = 0; i < 10; i++) {
      jwtSub("clerk_a");
      const res = await worker.fetch(
        req(`/api/social/report`, {
          method: "POST",
          headers: { ...authed(), "Content-Type": "application/json" },
          body: JSON.stringify({
            target_type: "ticket",
            target_id: `kb-${i}`,
            reason: "spam",
          }),
        }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
    }
    expect(reports.length).toBe(10);

    // 11th report is rejected.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/report`, {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({
          target_type: "ticket",
          target_id: "kb-11",
          reason: "spam",
        }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(60));
    expect(reports.length).toBe(10);
  });

  it("block rate limit: 31st block in a minute returns 429", async () => {
    // Seed 31 distinct target users so we don't hit the self-block guard.
    const users = Array.from({ length: 31 }, (_, i) => ({
      id: `u-target-${i}`,
      clerk_user_id: `clerk_target_${i}`,
      handle: null,
      display_name: null,
      avatar: null,
      age_verified: 1,
      created_at: 1,
    }));
    const { db } = makeFakeD1({ users });

    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/me`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );

    for (let i = 0; i < 30; i++) {
      jwtSub("clerk_a");
      const res = await worker.fetch(
        req(`/api/social/block/u-target-${i}`, { method: "POST", headers: authed() }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
    }

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/block/u-target-30`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe(String(60));
  });
});
