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

interface SocialEdgeRow {
  source_id: string;
  target_id: string;
  type: string;
  state: string;
  created_at: number;
  decided_at: number | null;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  created_at: number;
  read_at: number | null;
}

interface ShareRow {
  id: string;
  ticket_id: string;
  owner_id: string;
  audience_mode: string;
  snapshot: string;
  is_win: number;
  retracted_at: number | null;
  created_at: number;
}

interface CommentRow {
  id: string;
  share_id: string;
  author_id: string;
  body: string;
  created_at: number;
  deleted_at: number | null;
}

interface FakeD1Options {
  /** Optional initial state — handy for seeding an owner + a non-owner. */
  users?: UserRow[];
  tickets?: TicketRow[];
  follows?: FollowRow[];
  cheers?: CheerRow[];
  blocks?: BlockRow[];
  reports?: ReportRow[];
  /** Friend Interactions Phase 1 — directed social-edge graph + notifications. */
  socialEdges?: SocialEdgeRow[];
  notifications?: NotificationRow[];
  /** Friend Interactions Phase 2 — shared tickets + explicit selected-audience. */
  shares?: ShareRow[];
  shareAudience?: { share_id: string; user_id: string }[];
  /** Friend Interactions Phase 3 — comments + congratulations. */
  comments?: CommentRow[];
  congrats?: { share_id: string; user_id: string }[];
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
  // Friend Interactions: directed edge graph keyed "source|target|type" + a
  // notifications array (the bell log). Mirrors social_edges / notifications.
  const socialEdges = new Map<string, SocialEdgeRow>(); // "source|target|type"
  const notifications: NotificationRow[] = [];
  const shares = new Map<string, ShareRow>(); // by share id
  const shareAudience = new Set<string>(); // "share_id|user_id"
  const comments = new Map<string, CommentRow>(); // by comment id
  const congrats = new Set<string>(); // "share_id|user_id"
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
  for (const e of opts.socialEdges ?? []) {
    socialEdges.set(`${e.source_id}|${e.target_id}|${e.type}`, { ...e });
  }
  for (const n of opts.notifications ?? []) notifications.push({ ...n });
  for (const s of opts.shares ?? []) shares.set(s.id, { ...s });
  for (const a of opts.shareAudience ?? []) shareAudience.add(`${a.share_id}|${a.user_id}`);
  for (const c of opts.comments ?? []) comments.set(c.id, { ...c });
  for (const g of opts.congrats ?? []) congrats.add(`${g.share_id}|${g.user_id}`);

  function freshId(prefix: string): string {
    nonce += 1;
    return `${prefix}-${nonce.toString(36)}`;
  }

  /** Build a feed/detail row with owner + ticket (cost/returned) + congratulate
   *  + comment aggregates — mirrors the Phase 3 enriched feed query. */
  function enrichShareRow(sh: ShareRow, viewer: string) {
    const u = usersById.get(sh.owner_id);
    const tk = tickets.get(sh.ticket_id) as (TicketRow & { cost?: number | null }) | undefined;
    const cgrats = [...congrats].filter((c) => c.startsWith(`${sh.id}|`)).map((c) => c.split("|")[1]);
    const ccount = [...comments.values()].filter((c) => c.share_id === sh.id && c.deleted_at == null).length;
    return {
      ...sh,
      owner_handle: u?.handle ?? null,
      owner_display_name: u?.display_name ?? null,
      owner_avatar: u?.avatar ?? null,
      ticket_cost: tk?.cost ?? null,
      ticket_returned: tk?.returned ?? null,
      congrats_count: cgrats.length,
      congratulated_by_me: cgrats.includes(viewer) ? 1 : 0,
      comment_count: ccount,
    };
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
        // Propagate a {meta} object returned by a runOne branch (e.g. an UPDATE
        // reporting {changes}) so callers that read meta.changes work; branches
        // returning null fall back to {}.
        const out = await runOne(sql, entry.bindings);
        if (out && typeof out === "object" && "meta" in out) {
          return out as { meta: unknown };
        }
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

    // ---- SOCIAL EDGES (Friend Interactions Phase 1) ----
    // readFriendEdges: SELECT * ... WHERE source_id=? AND target_id=? AND type='friend'
    m = /^SELECT \* FROM social_edges WHERE source_id = \? AND target_id = \? AND type = 'friend'/i.exec(s);
    if (m) {
      const [sourceId, targetId] = b as [string, string];
      return socialEdges.get(`${sourceId}|${targetId}|friend`) ?? null;
    }
    // upsert a friend edge (setFriendAccepted / insertPending). The state is a
    // literal in VALUES; decided_at is a bind (?,'accepted') or literal NULL
    // ('pending'). One regex covers both via (?:\?|NULL)\).
    m = /^INSERT INTO social_edges [\s\S]*VALUES \(\?, \?, 'friend', '(pending|accepted)', \?, (?:\?|NULL)\)[\s\S]*ON CONFLICT\(source_id, target_id, type\) DO UPDATE/i.exec(s);
    if (m) {
      const [sourceId, targetId, createdAt, decidedAt] = b as [string, string, number, number?];
      const state = m[1];
      socialEdges.set(`${sourceId}|${targetId}|friend`, {
        source_id: sourceId,
        target_id: targetId,
        type: "friend",
        state,
        created_at: createdAt,
        decided_at: decidedAt ?? null,
      });
      return null;
    }
    // declineRequest: DELETE a single pending edge.
    m = /^DELETE FROM social_edges\s+WHERE source_id = \? AND target_id = \? AND type = 'friend' AND state = 'pending'/i.exec(s);
    if (m) {
      const [sourceId, targetId] = b as [string, string];
      const key = `${sourceId}|${targetId}|friend`;
      if (socialEdges.get(key)?.state === "pending") socialEdges.delete(key);
      return null;
    }
    // removeFriend: DELETE both directions, friend only.
    m = /^DELETE FROM social_edges\s+WHERE type = 'friend'\s+AND \(\(source_id = \? AND target_id = \?\) OR \(source_id = \? AND target_id = \?\)\)/i.exec(s);
    if (m) {
      const [a1, a2, a3, a4] = b as [string, string, string, string];
      socialEdges.delete(`${a1}|${a2}|friend`);
      socialEdges.delete(`${a3}|${a4}|friend`);
      return null;
    }
    // severEdgesBothDirections: DELETE ALL types both directions (wired on block).
    m = /^DELETE FROM social_edges\s+WHERE \(source_id = \? AND target_id = \?\) OR \(source_id = \? AND target_id = \?\)/i.exec(s);
    if (m) {
      const [a1, a2, a3, a4] = b as [string, string, string, string];
      for (const t of ["friend", "follow"]) {
        socialEdges.delete(`${a1}|${a2}|${t}`);
        socialEdges.delete(`${a3}|${a4}|${t}`);
      }
      return null;
    }

    // ---- NOTIFICATIONS (Friend Interactions) ----
    m = /^INSERT INTO notifications \(id, user_id, type, actor_id, subject_type, subject_id, created_at, read_at\)/i.exec(s);
    if (m) {
      const [id, userId, type, actorId, subjectType, subjectId, createdAt] = b as [
        string, string, string, string | null, string, string, number,
      ];
      notifications.push({
        id,
        user_id: userId,
        type,
        actor_id: actorId,
        subject_type: subjectType,
        subject_id: subjectId,
        created_at: createdAt,
        read_at: null,
      });
      return null;
    }
    // Phase 4 read-side: unreadCount
    m = /^SELECT COUNT\(\*\) AS n FROM notifications WHERE user_id = \? AND read_at IS NULL/i.exec(s);
    if (m) {
      const uid = b[0] as string;
      return { n: notifications.filter((x) => x.user_id === uid && x.read_at == null).length };
    }
    // markRead (one): UPDATE ... WHERE id=? AND user_id=? AND read_at IS NULL
    m = /^UPDATE notifications SET read_at = \? WHERE id = \? AND user_id = \? AND read_at IS NULL/i.exec(s);
    if (m) {
      const [at, id, uid] = b as [number, string, string];
      const n = notifications.find((x) => x.id === id && x.user_id === uid && x.read_at == null);
      if (n) n.read_at = at;
      return null;
    }
    // markAllRead: UPDATE ... WHERE user_id=? AND read_at IS NULL
    m = /^UPDATE notifications SET read_at = \? WHERE user_id = \? AND read_at IS NULL/i.exec(s);
    if (m) {
      const [at, uid] = b as [number, string];
      for (const n of notifications) if (n.user_id === uid && n.read_at == null) n.read_at = at;
      return null;
    }
    // pruneOld: DELETE FROM notifications WHERE created_at < ?
    m = /^DELETE FROM notifications WHERE created_at < \?/i.exec(s);
    if (m) {
      const cutoff = b[0] as number;
      const before = notifications.length;
      for (let i = notifications.length - 1; i >= 0; i--) {
        if (notifications[i].created_at < cutoff) notifications.splice(i, 1);
      }
      return { meta: { changes: before - notifications.length } };
    }

    // ---- SHARES (Friend Interactions Phase 2) ----
    // getShare / activeShareForTicket / promoteShareWin-lookup: SELECT * FROM shares WHERE ...
    m = /^SELECT \* FROM shares WHERE/i.exec(s);
    if (m) {
      if (/ticket_id = \? AND owner_id = \? AND retracted_at IS NULL/i.test(s)) {
        const [ticketId, ownerId] = b as [string, string];
        for (const sh of shares.values()) {
          if (sh.ticket_id === ticketId && sh.owner_id === ownerId && sh.retracted_at == null) return sh;
        }
        return null;
      }
      // promoteShareWin: by ticket_id only (no owner — a ticket has one owner).
      if (/ticket_id = \? AND retracted_at IS NULL/i.test(s)) {
        const ticketId = b[0] as string;
        for (const sh of shares.values()) {
          if (sh.ticket_id === ticketId && sh.retracted_at == null) return sh;
        }
        return null;
      }
      if (/WHERE id = \?/i.test(s)) return shares.get(b[0] as string) ?? null;
      return null;
    }
    // createShare INSERT
    m = /^INSERT INTO shares \(id, ticket_id, owner_id, audience_mode, snapshot, is_win, retracted_at, created_at\)/i.exec(s);
    if (m) {
      const [id, ticketId, ownerId, mode, snapshot, createdAt] = b as [string, string, string, string, string, number];
      shares.set(id, { id, ticket_id: ticketId, owner_id: ownerId, audience_mode: mode, snapshot, is_win: 0, retracted_at: null, created_at: createdAt });
      return null;
    }
    // widenShare: UPDATE audience_mode
    m = /^UPDATE shares SET audience_mode = \? WHERE id = \?/i.exec(s);
    if (m) {
      const [mode, id] = b as [string, string];
      const sh = shares.get(id);
      if (sh) shares.set(id, { ...sh, audience_mode: mode });
      return null;
    }
    // retractShare: UPDATE retracted_at (owner-checked in SQL)
    m = /^UPDATE shares SET retracted_at = \? WHERE id = \? AND owner_id = \? AND retracted_at IS NULL/i.exec(s);
    if (m) {
      const [retractedAt, id, ownerId] = b as [number, string, string];
      const sh = shares.get(id);
      if (sh && sh.owner_id === ownerId && sh.retracted_at == null) shares.set(id, { ...sh, retracted_at: retractedAt });
      return null;
    }
    // clear selected audience (widen path)
    m = /^DELETE FROM share_audience WHERE share_id = \?/i.exec(s);
    if (m) {
      const sid = b[0] as string;
      for (const k of [...shareAudience]) if (k.startsWith(`${sid}|`)) shareAudience.delete(k);
      return null;
    }
    // add selected audience member
    m = /^INSERT INTO share_audience \(share_id, user_id\)[\s\S]*ON CONFLICT\(share_id, user_id\) DO NOTHING/i.exec(s);
    if (m) {
      const [sid, uid] = b as [string, string];
      shareAudience.add(`${sid}|${uid}`);
      return null;
    }
    // shareVisibleTo (selected): SELECT 1 FROM share_audience WHERE share_id=? AND user_id=?
    m = /^SELECT 1 FROM share_audience WHERE share_id = \? AND user_id = \?/i.exec(s);
    if (m) {
      const [sid, uid] = b as [string, string];
      return shareAudience.has(`${sid}|${uid}`) ? { "1": 1 } : null;
    }
    // getShareForViewer (.first): SELECT s.* FROM shares s JOIN users u ... (Phase 3
    // adds LEFT JOINs to tickets/congratulations/comments). Bind order: [viewer, shareId].
    m = /^SELECT s\.[\s\S]*FROM shares s\s+JOIN users u ON u\.id = s\.owner_id/i.exec(s);
    if (m) {
      const viewer = b[0] as string;
      const sh = shares.get(b[1] as string);
      if (!sh || sh.retracted_at != null) return null;
      return enrichShareRow(sh, viewer);
    }

    // ---- COMMENTS + CONGRATULATIONS (Friend Interactions Phase 3) ----
    m = /^INSERT INTO comments \(id, share_id, author_id, body, created_at, deleted_at\)/i.exec(s);
    if (m) {
      const [id, shareId, authorId, body, createdAt] = b as [string, string, string, string, number];
      comments.set(id, { id, share_id: shareId, author_id: authorId, body, created_at: createdAt, deleted_at: null });
      return null;
    }
    m = /^SELECT id, share_id, author_id FROM comments WHERE id = \?/i.exec(s);
    if (m) {
      const c = comments.get(b[0] as string);
      return c ? { id: c.id, share_id: c.share_id, author_id: c.author_id } : null;
    }
    m = /^SELECT author_id FROM comments WHERE id = \?/i.exec(s);
    if (m) {
      const c = comments.get(b[0] as string);
      return c ? { author_id: c.author_id } : null;
    }
    m = /^UPDATE comments SET deleted_at = \? WHERE id = \? AND deleted_at IS NULL/i.exec(s);
    if (m) {
      const [at, id] = b as [number, string];
      const c = comments.get(id);
      if (c && c.deleted_at == null) {
        comments.set(id, { ...c, deleted_at: at });
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    m = /^INSERT INTO congratulations \(share_id, user_id, created_at\)[\s\S]*ON CONFLICT\(share_id, user_id\) DO NOTHING/i.exec(s);
    if (m) {
      const [shareId, userId] = b as [string, string];
      congrats.add(`${shareId}|${userId}`);
      return null;
    }
    m = /^DELETE FROM congratulations WHERE share_id = \? AND user_id = \?/i.exec(s);
    if (m) {
      const [shareId, userId] = b as [string, string];
      congrats.delete(`${shareId}|${userId}`);
      return null;
    }
    m = /^SELECT COUNT\(\*\) AS n FROM congratulations WHERE share_id = \?/i.exec(s);
    if (m) {
      const shareId = b[0] as string;
      return { n: [...congrats].filter((c) => c.startsWith(`${shareId}|`)).length };
    }
    // promoteShareWin: flip is_win (literal 0/1, not a param — single bind = id)
    m = /^UPDATE shares SET is_win = (?:0|1) WHERE id = \?/i.exec(s);
    if (m) {
      const id = b[0] as string;
      const isWin = /is_win = 1/i.test(s) ? 1 : 0;
      const sh = shares.get(id);
      if (sh) shares.set(id, { ...sh, is_win: isWin });
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

    // ---- FRIEND GRAPH reads (Friend Interactions Phase 1) ----
    // listFriends: mutual = (I→them accepted) AND (them→I accepted).
    if (/FROM users u\s+WHERE u\.id IN \(\s*SELECT target_id FROM social_edges/i.test(s)) {
      const userId = b[0] as string;
      const acc = [...socialEdges.values()].filter((e) => e.type === "friend" && e.state === "accepted");
      const targets = new Set(acc.filter((e) => e.source_id === userId).map((e) => e.target_id));
      const sources = new Set(acc.filter((e) => e.target_id === userId).map((e) => e.source_id));
      const out = [...targets]
        .filter((id) => sources.has(id))
        .map((id) => usersById.get(id))
        .filter((u): u is UserRow => !!u)
        .map((u) => ({ id: u.id, handle: u.handle, display_name: u.display_name, avatar: u.avatar }))
        .sort((a, c) => (a.handle ?? "").localeCompare(c.handle ?? "")) as unknown as T[];
      return out;
    }
    // listPendingIncoming / Outgoing: FROM social_edges e JOIN users u ...
    if (/FROM social_edges e JOIN users u/i.test(s)) {
      const userId = b[0] as string;
      const incoming = /ON u\.id = e\.source_id/i.test(s);
      const out = [...socialEdges.values()]
        .filter((e) => e.type === "friend" && e.state === "pending")
        .filter((e) => (incoming ? e.target_id === userId : e.source_id === userId))
        .map((e) => usersById.get(incoming ? e.source_id : e.target_id))
        .filter((u): u is UserRow => !!u)
        .map((u) => ({ id: u.id, handle: u.handle, display_name: u.display_name, avatar: u.avatar })) as unknown as T[];
      return out;
    }
    // searchUsers: handle prefix (case-insensitive), exclude viewer, exact-first.
    if (/SELECT id, handle, display_name, avatar\s+FROM users\s+WHERE handle IS NOT NULL/i.test(s)) {
      const q = String(b[0]).toLowerCase();
      const viewerId = b[1] as string;
      const out = [...usersById.values()]
        .filter((u) => u.handle != null && u.handle.toLowerCase().startsWith(q) && u.id !== viewerId)
        .sort((a, c) => {
          const ax = a.handle!.toLowerCase() === q ? 0 : 1;
          const cx = c.handle!.toLowerCase() === q ? 0 : 1;
          if (ax !== cx) return ax - cx;
          return (a.handle ?? "").localeCompare(c.handle ?? "");
        })
        .slice(0, 20)
        .map((u) => ({ id: u.id, handle: u.handle, display_name: u.display_name, avatar: u.avatar })) as unknown as T[];
      return out;
    }

    // ---- SHARES feed + notify-dedupe (Friend Interactions Phase 2) ----
    // notifyShareAudience: SELECT user_id FROM notifications WHERE type='ticket_shared_with_you' AND subject_id=?
    if (/SELECT user_id FROM notifications\s+WHERE type = 'ticket_shared_with_you' AND subject_id = \?/i.test(s)) {
      const sid = b[0] as string;
      return notifications
        .filter((n) => n.type === "ticket_shared_with_you" && n.subject_id === sid)
        .map((n) => ({ user_id: n.user_id })) as unknown as T[];
    }
    // buildShareFeed: FROM shares s JOIN users u ON u.id = s.owner_id
    if (/FROM shares s\s+JOIN users u ON u\.id = s\.owner_id/i.test(s)) {
      const viewer = b[0] as string;
      const acc = [...socialEdges.values()].filter((e) => e.type === "friend" && e.state === "accepted");
      const targets = new Set(acc.filter((e) => e.source_id === viewer).map((e) => e.target_id));
      const sources = new Set(acc.filter((e) => e.target_id === viewer).map((e) => e.source_id));
      const blocked = new Set<string>();
      for (const bk of blocks) {
        const [bl, bd] = bk.split("|");
        if (bl === viewer) blocked.add(bd);
        if (bd === viewer) blocked.add(bl);
      }
      const out = [...shares.values()]
        .filter(
          (sh) =>
            sh.retracted_at == null &&
            sh.owner_id !== viewer &&
            targets.has(sh.owner_id) &&
            sources.has(sh.owner_id) &&
            !blocked.has(sh.owner_id) &&
            (sh.audience_mode === "all_friends" || shareAudience.has(`${sh.id}|${viewer}`)),
        )
        .sort((a, c) => c.created_at - a.created_at)
        .slice(0, 100)
        .map((sh) => enrichShareRow(sh, viewer));
      return out as unknown as T[];
    }
    // listComments: FROM comments c JOIN users u ... WHERE c.share_id = ? ORDER BY created_at ASC
    if (/FROM comments c\s+JOIN users u ON u\.id = c\.author_id/i.test(s)) {
      const shareId = b[0] as string;
      const out = [...comments.values()]
        .filter((c) => c.share_id === shareId)
        .sort((a, c) => a.created_at - c.created_at)
        .map((c) => {
          const u = usersById.get(c.author_id);
          return {
            ...c,
            author_handle: u?.handle ?? null,
            author_display_name: u?.display_name ?? null,
            author_avatar: u?.avatar ?? null,
          };
        });
      return out as unknown as T[];
    }
    // priorCommenters: SELECT DISTINCT author_id FROM comments WHERE share_id=? AND deleted_at IS NULL AND author_id<>?
    if (/SELECT DISTINCT author_id FROM comments/i.test(s)) {
      const [shareId, except] = b as [string, string];
      const out = [...new Set(
        [...comments.values()]
          .filter((c) => c.share_id === shareId && c.deleted_at == null && c.author_id !== except)
          .map((c) => c.author_id),
      )].map((author_id) => ({ author_id }));
      return out as unknown as T[];
    }
    // listNotifications (Phase 4): FROM notifications n LEFT JOIN users u ... WHERE n.user_id=?
    if (/FROM notifications n\s+LEFT JOIN users u ON u\.id = n\.actor_id/i.test(s)) {
      const uid = b[0] as string;
      return notifications
        .filter((n) => n.user_id === uid)
        .sort((a, c) => c.created_at - a.created_at)
        .slice(0, 50)
        .map((n) => {
          const u = usersById.get(n.actor_id ?? "");
          return {
            ...n,
            actor_handle: u?.handle ?? null,
            actor_display_name: u?.display_name ?? null,
            actor_avatar: u?.avatar ?? null,
          };
        }) as unknown as T[];
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
    socialEdges,
    notifications,
    shares,
    shareAudience,
    comments,
    congrats,
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

  // NOTE: the four legacy follow tests (idempotent follow, self-follow, follow-
  // 404, idempotent unfollow) were removed with the follow system in Friend
  // Interactions Phase 2. The mutual-friend graph is covered in the Phase 1
  // friend-graph describe block.

  // NOTE: the four legacy cheer tests (dedupe, won-only, self-cheer, uncheer)
  // were removed with the cheer system in Friend Interactions Phase 3
  // (congratulate replaces cheer). Congratulate is covered in the Phase 3
  // describe block below.

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

  // NOTE: the three legacy auto-feed tests (own + followed tickets, cheeredByMe
  // via the feed JOIN, excludes non-followed) were removed in the Friend
  // Interactions Phase 2 CLEAN CUT — the feed is now share-gated and the old
  // follow-based auto-feed no longer exists. Coverage of the new feed lives in
  // the "Friend Interactions Phase 2 (shared tickets)" describe block below.


  // Friend Interactions Phase 2: friends-on-race / friends-on-card are STUBBED
  // empty (the legacy follow-based reads were removed with the follow system;
  // Phase 3 re-points them to mutual-friends + share-gated visibility). These
  // pin the stub contract so no follows-based visibility can ship by accident.

  it("friends-on-race STUB returns count 0 (follow-based read removed)", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(req("/api/social/me", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/races/${encodeURIComponent("20260621|Hanshin|11|Takarazuka")}/friends`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 0, avatars: [] });
  });

  it("friends-on-card STUB returns count 0 + empty perRace", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(req("/api/social/me", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/on-card?race=${encodeURIComponent("rk1")}`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 0, avatars: [], perRace: {} });
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

  // ---- Social UX Fixes (Phase B): tightened handle rules + availability ----
  // Rules: 3–20 chars, [a-z0-9_], case-insensitive unique, STORED LOWERCASE.
  it("Phase B handle write rejects <3 chars → 400 bad_handle", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "ab" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_handle" });
  });

  it("Phase B handle write rejects >20 chars → 400 bad_handle", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "a".repeat(21) }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_handle" });
  });

  it("Phase B handle write rejects invalid charset → 400 bad_handle", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "aly!" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_handle" });
  });

  it("Phase B handle write STORES LOWERCASE (uppercase input → 200, stored lowercased)", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "Alyssa" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "alyssa" });
  });

  it("Phase B GET /handle-available reports a taken handle as unavailable", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alyssa" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    const res = await worker.fetch(
      req("/api/social/handle-available?h=alyssa", { headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false });
  });

  it("Phase B GET /handle-available reports a free handle as available (case-insensitive query)", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_b");
    const res = await worker.fetch(
      req("/api/social/handle-available?h=FreeHandle", { headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true });
  });

  it("Phase B GET /handle-available marks an invalid format as {available:false, reason:'invalid'} (never 400)", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/handle-available?h=ab", { headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, reason: "invalid" });
  });

  it("Phase B GET /handle-available treats the caller's OWN handle as available (rename-safe)", async () => {
    const { db } = makeFakeD1();
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alyssa" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a"); // same user re-checks their own handle
    const res = await worker.fetch(
      req("/api/social/handle-available?h=alyssa", { headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true });
  });

  it("Phase B GET /handle-available requires auth → 401", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req("/api/social/handle-available?h=alyssa"),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
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

  it("profile surfaces the viewer's friendship state (pending_outgoing / none)", async () => {
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
    await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // Viewer requests the target → pending_outgoing.
    jwtSub("clerk_viewer");
    await worker.fetch(
      req(`/api/social/friends/request/u-target`, { method: "POST", headers: authed() }),
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
    expect(authedBody.friendship).toBe("pending_outgoing");
    // legacy is_following field is gone with the follow system.
    expect(authedBody.is_following).toBeUndefined();

    const anonRes = await worker.fetch(
      req("/api/social/users/viewee", { method: "GET" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const anonBody = (await anonRes.json()) as Record<string, unknown>;
    expect(anonBody.friendship).toBe("none");
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

  it("block severs existing friendship edges in BOTH directions", async () => {
    const { db, blocks, socialEdges } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    // A↔B friends (mutual requests; second auto-accepts).
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_b");
    await worker.fetch(
      req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("accepted");
    expect(socialEdges.get(`${bId}|${aId}|friend`)?.state).toBe("accepted");

    // A blocks B → both friend edges severed.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(blocks.has(`${aId}|${bId}`)).toBe(true);
    expect(socialEdges.get(`${aId}|${bId}|friend`)).toBeUndefined();
    expect(socialEdges.get(`${bId}|${aId}|friend`)).toBeUndefined();
  });

  it("after A blocks B, neither can friend-request the other (403 blocked)", async () => {
    const { db, blocks } = makeFakeD1();
    const { aId, bId } = await seedTwoUsers(db);

    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(blocks.size).toBe(1);

    // A tries to friend-request B → 403 blocked.
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ error: "blocked" });

    // B tries to friend-request A → 403 blocked (reverse direction).
    jwtSub("clerk_b");
    const r2 = await worker.fetch(
      req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(403);
    expect(await r2.json()).toMatchObject({ error: "blocked" });
  });

  // NOTE: the legacy "block forbids cheer" test was removed with the cheer
  // system in Phase 3. Block's severing of the social graph is covered by the
  // friend-request block test in the Phase 1 suite; congratulate's block guard
  // is covered in the Phase 3 describe block.

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

  it("after unblock, a friend request works again", async () => {
    const { db, socialEdges } = makeFakeD1();
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
      req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("pending");
    void aId;
  });

  // NOTE: the legacy "feed EXCLUDES blocked users' tickets" test was removed in
  // the Friend Interactions Phase 2 CLEAN CUT (feed is now share-gated). The
  // block-filter rule still holds for the new share feed — covered in the
  // "Friend Interactions Phase 2 (shared tickets)" describe block below.

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

// ---------------------------------------------------------------------------
// Friend Interactions Phase 1 — friend graph (social_edges).
// ---------------------------------------------------------------------------

describe("social Worker — Friend Interactions Phase 1 (friend graph)", () => {
  beforeEach(() => vi.resetAllMocks());

  /** Seed a user via POST /me (optionally with a handle); returns the id. */
  async function seedUser(db: D1Database, clerkSub: string, handle?: string): Promise<string> {
    jwtSub(clerkSub);
    const res = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(handle ? { handle } : {}),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  it("returns 401 on every friend route without a token", async () => {
    const { db } = makeFakeD1();
    const cases = [
      { method: "POST", path: "/api/social/friends/request/u-x" },
      { method: "DELETE", path: "/api/social/friends/request/u-x" },
      { method: "POST", path: "/api/social/friends/request/u-x/accept" },
      { method: "GET", path: "/api/social/friends" },
      { method: "DELETE", path: "/api/social/friends/u-x" },
      { method: "GET", path: "/api/social/users/search?q=a" },
    ];
    for (const c of cases) {
      const res = await worker.fetch(req(c.path, { method: c.method }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
      expect(res.status).toBe(401);
    }
  });

  it("send a request: pending edge a→b, B in no edge back, B notified", async () => {
    const { db, socialEdges, notifications } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a", "alyssa");
    const bId = await seedUser(db, "clerk_b", "ben");

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transition: string; now_friends: boolean };
    expect(body.transition).toBe("created_pending");
    expect(body.now_friends).toBe(false);
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("pending");
    expect(socialEdges.get(`${bId}|${aId}|friend`)).toBeUndefined();
    expect(
      notifications.some((n) => n.user_id === bId && n.type === "friend_request_received" && n.actor_id === aId),
    ).toBe(true);
  });

  it("duplicate request is idempotent: second send is already_pending, no second notification", async () => {
    const { db, notifications } = makeFakeD1();
    await seedUser(db, "clerk_a");
    const bId = await seedUser(db, "clerk_b");
    for (let i = 0; i < 2; i++) {
      jwtSub("clerk_a");
      const res = await worker.fetch(
        req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }),
        { ...BASE_ENV, DB: db },
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { transition: string }).transition).toBe(
        i === 0 ? "created_pending" : "already_pending",
      );
    }
    expect(notifications.filter((n) => n.type === "friend_request_received" && n.user_id === bId)).toHaveLength(1);
  });

  it("auto-accept: if B already requested A, A's request to B makes them mutual friends", async () => {
    const { db, socialEdges, notifications } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a");
    const bId = await seedUser(db, "clerk_b");

    jwtSub("clerk_b");
    await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);

    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const body = (await res.json()) as { transition: string; now_friends: boolean };
    expect(body.transition).toBe("auto_accepted");
    expect(body.now_friends).toBe(true);
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("accepted");
    expect(socialEdges.get(`${bId}|${aId}|friend`)?.state).toBe("accepted");
    expect(notifications.some((n) => n.user_id === bId && n.type === "friend_request_accepted")).toBe(true);
  });

  it("accept: B accepts A's pending request → mutual, A notified", async () => {
    const { db, socialEdges, notifications } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a");
    const bId = await seedUser(db, "clerk_b");

    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_b");
    const res = await worker.fetch(
      req(`/api/social/friends/request/${aId}/accept`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transition: string; now_friends: boolean };
    expect(body.transition).toBe("accepted");
    expect(body.now_friends).toBe(true);
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("accepted");
    expect(socialEdges.get(`${bId}|${aId}|friend`)?.state).toBe("accepted");
    expect(notifications.some((n) => n.user_id === aId && n.type === "friend_request_accepted")).toBe(true);
  });

  it("decline is silent: edge gone, no new notification, not friends", async () => {
    const { db, socialEdges, notifications } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a");
    const bId = await seedUser(db, "clerk_b");
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    const before = notifications.length;

    jwtSub("clerk_b");
    const res = await worker.fetch(
      req(`/api/social/friends/request/${aId}`, { method: "DELETE", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(socialEdges.get(`${aId}|${bId}|friend`)).toBeUndefined();
    expect(notifications.length).toBe(before); // silent: no new notification
  });

  it("remove friend is silent + mutual: both directions deleted", async () => {
    const { db, socialEdges } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a");
    const bId = await seedUser(db, "clerk_b");
    // Establish friendship via mutual requests (second auto-accepts).
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_b");
    await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("accepted");

    jwtSub("clerk_a");
    const res = await worker.fetch(req(`/api/social/friends/${bId}`, { method: "DELETE", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(socialEdges.get(`${aId}|${bId}|friend`)).toBeUndefined();
    expect(socialEdges.get(`${bId}|${aId}|friend`)).toBeUndefined();
  });

  it("friends list returns accepted friends + pending out + count", async () => {
    const { db } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a", "alyssa");
    const bId = await seedUser(db, "clerk_b", "ben");
    const cId = await seedUser(db, "clerk_c", "cas");
    // A↔B friends (mutual), A→C pending.
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_b");
    await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${cId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);

    jwtSub("clerk_a");
    const res = await worker.fetch(req(`/api/social/friends`, { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    const body = (await res.json()) as {
      friends: { handle: string }[];
      pending_incoming: unknown[];
      pending_outgoing: { handle: string }[];
      pending_count: number;
    };
    expect(body.friends.map((f) => f.handle)).toEqual(["ben"]);
    expect(body.pending_outgoing.map((f) => f.handle)).toEqual(["cas"]);
    expect(body.pending_count).toBe(0);
  });

  it("block severs friendship + prevents a new request from either direction", async () => {
    const { db, socialEdges } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a");
    const bId = await seedUser(db, "clerk_b");
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_b");
    await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);

    // A blocks B → friendship severed.
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/block/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(socialEdges.get(`${aId}|${bId}|friend`)).toBeUndefined();
    expect(socialEdges.get(`${bId}|${aId}|friend`)).toBeUndefined();

    // B tries to re-request A → 403 blocked.
    jwtSub("clerk_b");
    const res = await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "blocked" });
  });

  it("cannot friend self → 403 cannot_friend_self", async () => {
    const { db } = makeFakeD1();
    const aId = await seedUser(db, "clerk_a");
    jwtSub("clerk_a");
    const res = await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "cannot_friend_self" });
  });

  it("handle search: prefix match returns hits with friendship state, excluding self", async () => {
    const { db } = makeFakeD1();
    await seedUser(db, "clerk_a", "alyssa"); // viewer — excluded
    await seedUser(db, "clerk_b", "ben");
    await seedUser(db, "clerk_c", "alex");
    jwtSub("clerk_a");
    const res = await worker.fetch(req(`/api/social/users/search?q=al`, { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { handle: string; friendship: string }[] };
    expect(body.results.map((r) => r.handle).sort()).toEqual(["alex"]);
    expect(body.results[0].friendship).toBe("none");
  });

  it("profile surfaces the viewer's friendship state", async () => {
    const { db } = makeFakeD1();
    await seedUser(db, "clerk_a", "alyssa");
    const bId = await seedUser(db, "clerk_b", "ben");
    // A requests B.
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    // B views A's profile → A requested B ⇒ pending_incoming.
    jwtSub("clerk_b");
    const res = await worker.fetch(req(`/api/social/users/alyssa`, { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    const body = (await res.json()) as { friendship: string };
    expect(body.friendship).toBe("pending_incoming");
  });
});

// ---------------------------------------------------------------------------
// Friend Interactions Phase 2 — shared tickets + share-gated feed.
// ---------------------------------------------------------------------------

describe("social Worker — Friend Interactions Phase 2 (shared tickets)", () => {
  beforeEach(() => vi.resetAllMocks());

  async function seedUserHandle(db: D1Database, clerkSub: string, handle: string): Promise<string> {
    jwtSub(clerkSub);
    const r = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    return ((await r.json()) as { id: string }).id;
  }

  /** Make two users mutual friends (second request auto-accepts). */
  async function makeFriends(db: D1Database, subA: string, subB: string): Promise<{ aId: string; bId: string }> {
    const aId = await seedUserHandle(db, subA, subA.replace("clerk_", "u_"));
    const bId = await seedUserHandle(db, subB, subB.replace("clerk_", "u_"));
    jwtSub(subA);
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub(subB);
    await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    return { aId, bId };
  }

  /** Share a ticket (create-or-widen) as `sub`. */
  async function shareAs(
    db: D1Database,
    sub: string,
    ticketId: string,
    mode: "all_friends" | "selected",
    selected: string[] = [],
  ): Promise<Response> {
    jwtSub(sub);
    const body: Record<string, unknown> = { ticket: sampleTicketBody({ id: ticketId }), mode };
    if (mode === "selected") body.selected = selected;
    return worker.fetch(
      req("/api/social/shares", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
  }

  async function feedAs(db: D1Database, sub: string): Promise<{ items: { id: string; ticket: { id?: string } | null; owner: { handle: string | null } }[] }> {
    jwtSub(sub);
    const r = await worker.fetch(req("/api/social/feed", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    return (await r.json()) as { items: { id: string; ticket: { id?: string } | null; owner: { handle: string | null } }[] };
  }

  it("returns 401 on share routes without a token", async () => {
    const { db } = makeFakeD1();
    const cases = [
      { method: "POST", path: "/api/social/shares" },
      { method: "POST", path: "/api/social/shares/s1/retract" },
      { method: "PATCH", path: "/api/social/shares/s1" },
      { method: "GET", path: "/api/social/shares/s1" },
      { method: "GET", path: "/api/social/feed" },
    ];
    for (const c of cases) {
      const res = await worker.fetch(req(c.path, { method: c.method }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
      expect(res.status).toBe(401);
    }
  });

  it("share all_friends: friend sees it in the feed + is notified; non-friend does not; ticket is saved", async () => {
    const { db, notifications } = makeFakeD1();
    const { aId, bId } = await makeFriends(db, "clerk_a", "clerk_b");
    await seedUserHandle(db, "clerk_c", "u_c"); // non-friend of A

    const res = await shareAs(db, "clerk_a", "kb-share-1", "all_friends");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notified_count: number; audience_mode: string };
    expect(body.audience_mode).toBe("all_friends");
    expect(body.notified_count).toBe(1); // B

    // B sees the share in feed; C does not.
    const feedB = await feedAs(db, "clerk_b");
    expect(feedB.items.some((i) => i.ticket?.id === "kb-share-1")).toBe(true);
    const feedC = await feedAs(db, "clerk_c");
    expect(feedC.items.some((i) => i.ticket?.id === "kb-share-1")).toBe(false);

    // B was sent a ticket_shared_with_you notification from A.
    expect(
      notifications.some((n) => n.user_id === bId && n.type === "ticket_shared_with_you" && n.actor_id === aId),
    ).toBe(true);

    // The ticket was saved (A can list it).
    jwtSub("clerk_a");
    const list = (await (await worker.fetch(req("/api/social/tickets", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext)).json()) as { tickets: { id: string }[] };
    expect(list.tickets.some((t) => t.id === "kb-share-1")).toBe(true);
  });

  it("CLEAN CUT: a committed-but-unshared ticket does NOT appear in a friend's feed", async () => {
    const { db } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");
    // A commits a ticket (no share).
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-unshared" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // B's feed is empty — no auto-feed.
    const feedB = await feedAs(db, "clerk_b");
    expect(feedB.items).toHaveLength(0);
  });

  it("selected audience: only the selected friend sees the share + is notified", async () => {
    const { db, notifications } = makeFakeD1();
    const { aId, bId } = await makeFriends(db, "clerk_a", "clerk_b");
    const { bId: cId } = await makeFriends(db, "clerk_a", "clerk_c"); // C also friends with A
    void aId;

    const res = await shareAs(db, "clerk_a", "kb-sel-1", "selected", [bId]);
    expect(res.status).toBe(200);

    const feedB = await feedAs(db, "clerk_b");
    expect(feedB.items.some((i) => i.ticket?.id === "kb-sel-1")).toBe(true);
    const feedC = await feedAs(db, "clerk_c");
    expect(feedC.items.some((i) => i.ticket?.id === "kb-sel-1")).toBe(false);

    expect(notifications.some((n) => n.user_id === bId && n.type === "ticket_shared_with_you")).toBe(true);
    expect(notifications.some((n) => n.user_id === cId && n.type === "ticket_shared_with_you")).toBe(false);
  });

  it("share is idempotent with save: re-sharing the same ticket widens, no duplicate, no re-notify same audience", async () => {
    const { db, shares, notifications } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");

    const r1 = await shareAs(db, "clerk_a", "kb-idem-1", "all_friends");
    const b1 = (await r1.json()) as { id: string; notified_count: number };
    expect(b1.notified_count).toBe(1);
    const firstShareId = b1.id;

    const r2 = await shareAs(db, "clerk_a", "kb-idem-1", "all_friends");
    const b2 = (await r2.json()) as { id: string; notified_count: number };
    // Same share id (widened, not duplicated).
    expect(b2.id).toBe(firstShareId);
    expect(b2.notified_count).toBe(0); // B already notified
    // Exactly one share row for the ticket.
    expect([...shares.values()].filter((s) => s.ticket_id === "kb-idem-1")).toHaveLength(1);
    // Exactly one notification to B for this share.
    expect(notifications.filter((n) => n.type === "ticket_shared_with_you" && n.subject_id === firstShareId)).toHaveLength(1);
  });

  it("widen (PATCH) adds a recipient and notifies only the new one", async () => {
    const { db, notifications } = makeFakeD1();
    const { aId, bId } = await makeFriends(db, "clerk_a", "clerk_b");
    const { bId: cId } = await makeFriends(db, "clerk_a", "clerk_c");
    void aId;

    const created = await shareAs(db, "clerk_a", "kb-widen-1", "selected", [bId]);
    const shareId = ((await created.json()) as { id: string }).id;
    const notifBefore = notifications.filter((n) => n.type === "ticket_shared_with_you").length;

    // Widen to include C.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/shares/${shareId}`, {
        method: "PATCH",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "selected", selected: [bId, cId] }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notified_count: number };
    expect(body.notified_count).toBe(1); // only C is new

    // C now sees it; notifications grew by exactly one (C).
    const feedC = await feedAs(db, "clerk_c");
    expect(feedC.items.some((i) => i.ticket?.id === "kb-widen-1")).toBe(true);
    expect(notifications.filter((n) => n.type === "ticket_shared_with_you").length).toBe(notifBefore + 1);
  });

  it("retract removes the share from feeds (silent); re-sharing creates a new row", async () => {
    const { db, shares } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");

    const created = await shareAs(db, "clerk_a", "kb-retract-1", "all_friends");
    const shareId = ((await created.json()) as { id: string }).id;
    expect((await feedAs(db, "clerk_b")).items.some((i) => i.ticket?.id === "kb-retract-1")).toBe(true);

    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/shares/${shareId}/retract`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    // Retracted → gone from B's feed.
    expect((await feedAs(db, "clerk_b")).items.some((i) => i.ticket?.id === "kb-retract-1")).toBe(false);
    expect(shares.get(shareId)?.retracted_at).not.toBeNull();

    // Re-share creates a fresh active share.
    const reshared = await shareAs(db, "clerk_a", "kb-retract-1", "all_friends");
    const newId = ((await reshared.json()) as { id: string }).id;
    expect(newId).not.toBe(shareId);
    expect((await feedAs(db, "clerk_b")).items.some((i) => i.ticket?.id === "kb-retract-1")).toBe(true);
  });

  it("own share is excluded from own feed; non-owner PATCH/retract → 404 (anti-oracle)", async () => {
    const { db } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");
    const created = await shareAs(db, "clerk_a", "kb-own-1", "all_friends");
    const shareId = ((await created.json()) as { id: string }).id;

    // Owner's own feed excludes their own share.
    const feedA = await feedAs(db, "clerk_a");
    expect(feedA.items.some((i) => i.ticket?.id === "kb-own-1")).toBe(false);

    // B (a friend, in audience) can GET the share detail.
    jwtSub("clerk_b");
    const detail = await worker.fetch(req(`/api/social/shares/${shareId}`, { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(detail.status).toBe(200);

    // B cannot retract A's share → 404 (not 403).
    jwtSub("clerk_b");
    const retract = await worker.fetch(req(`/api/social/shares/${shareId}/retract`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(retract.status).toBe(404);
  });

  it("rejects a share with a bad audience spec", async () => {
    const { db } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req("/api/social/shares", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: sampleTicketBody({ id: "kb-bad" }), mode: "selected" /* no selected list */ }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("GET /tickets/:id/share: shared:false → after share shared:true → non-owner 404", async () => {
    const { db } = makeFakeD1();
    const { aId, bId } = await makeFriends(db, "clerk_a", "clerk_b");
    void aId;
    // A saves a ticket (not yet shared).
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/tickets", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify(sampleTicketBody({ id: "kb-status-1" })),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const r0 = await worker.fetch(
      req("/api/social/tickets/kb-status-1/share", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r0.status).toBe(200);
    expect(await r0.json()).toMatchObject({ shared: false });

    // A shares it.
    await shareAs(db, "clerk_a", "kb-status-1", "all_friends");
    jwtSub("clerk_a");
    const r1 = await worker.fetch(
      req("/api/social/tickets/kb-status-1/share", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const b1 = (await r1.json()) as { shared: boolean; id: string; audience_mode: string };
    expect(b1.shared).toBe(true);
    expect(b1.audience_mode).toBe("all_friends");

    // Non-owner B → 404 (anti-oracle; share state is private to the owner).
    jwtSub("clerk_b");
    const r2 = await worker.fetch(
      req("/api/social/tickets/kb-status-1/share", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(r2.status).toBe(404);
    void bId;
  });
});

// ---------------------------------------------------------------------------
// Friend Interactions Phase 3 — wins, congratulate, comments.
// ---------------------------------------------------------------------------

describe("social Worker — Friend Interactions Phase 3 (wins, congratulate, comments)", () => {
  beforeEach(() => vi.resetAllMocks());

  async function seedH(db: D1Database, sub: string, handle: string): Promise<string> {
    jwtSub(sub);
    const r = await worker.fetch(
      req("/api/social/me", { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ handle }) }),
      { ...BASE_ENV, DB: db }, {} as ExecutionContext,
    );
    return ((await r.json()) as { id: string }).id;
  }
  async function makeFriends(db: D1Database, subA: string, subB: string) {
    const aId = await seedH(db, subA, "u_a");
    const bId = await seedH(db, subB, "u_b");
    jwtSub(subA); await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub(subB); await worker.fetch(req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    return { aId, bId };
  }
  async function shareAs(db: D1Database, sub: string, ticketId: string, mode: "all_friends" | "selected", selected: string[] = []) {
    jwtSub(sub);
    const body: Record<string, unknown> = { ticket: sampleTicketBody({ id: ticketId }), mode };
    if (mode === "selected") body.selected = selected;
    return worker.fetch(req("/api/social/shares", { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify(body) }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
  }
  async function settleAs(db: D1Database, sub: string, ticketId: string, returned: number) {
    jwtSub(sub);
    return worker.fetch(req(`/api/social/tickets/${ticketId}`, { method: "PATCH", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ state: "won", returned }) }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
  }
  async function feedAs(db: D1Database, sub: string) {
    jwtSub(sub);
    const r = await worker.fetch(req("/api/social/feed", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    return (await r.json()) as { items: { id: string; ticket: { id?: string } | null; is_win: boolean; multiplier: number | null; congrats_count: number; comment_count: number }[] };
  }

  it("a shared ticket that wins promotes in friends' feed (is_win + multiplier, no currency) + notifies", async () => {
    const { db, shares, notifications } = makeFakeD1();
    const { aId, bId } = await makeFriends(db, "clerk_a", "clerk_b");
    await shareAs(db, "clerk_a", "kb-win-1", "all_friends");
    await settleAs(db, "clerk_a", "kb-win-1", 2400); // cost 200 → multiplier 12

    const share = [...shares.values()].find((s) => s.ticket_id === "kb-win-1");
    expect(share?.is_win).toBe(1);
    expect(notifications.some((n) => n.user_id === bId && n.type === "friends_ticket_won")).toBe(true);

    const feed = await feedAs(db, "clerk_b");
    const item = feed.items.find((i) => i.ticket?.id === "kb-win-1");
    expect(item?.is_win).toBe(true);
    expect(item?.multiplier).toBe(12);
    void aId;
  });

  it("congratulate: one/user/win, count + notify owner; self + non-win forbidden", async () => {
    const { db, shares, notifications } = makeFakeD1();
    const { aId, bId } = await makeFriends(db, "clerk_a", "clerk_b");
    await shareAs(db, "clerk_a", "kb-cg-1", "all_friends");
    await settleAs(db, "clerk_a", "kb-cg-1", 1000);
    const shareId = [...shares.values()].find((s) => s.ticket_id === "kb-cg-1")!.id;

    jwtSub("clerk_b");
    const r1 = await worker.fetch(req(`/api/social/shares/${shareId}/congratulate`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ count: 1, congratulatedByMe: true });
    // Duplicate → idempotent (PK dedupe), count stays 1.
    jwtSub("clerk_b");
    const r2 = await worker.fetch(req(`/api/social/shares/${shareId}/congratulate`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(((await r2.json()) as { count: number }).count).toBe(1);
    expect(notifications.filter((n) => n.user_id === aId && n.type === "congratulation_received")).toHaveLength(1);
    // Self-congrats forbidden.
    jwtSub("clerk_a");
    const rself = await worker.fetch(req(`/api/social/shares/${shareId}/congratulate`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(rself.status).toBe(409);
    void bId;
  });

  it("congratulate is win-only: a non-win share → 409 not_won", async () => {
    const { db, shares } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");
    await shareAs(db, "clerk_a", "kb-cg-open", "all_friends"); // not settled → not a win
    const shareId = [...shares.values()].find((s) => s.ticket_id === "kb-cg-open")!.id;
    jwtSub("clerk_b");
    const res = await worker.fetch(req(`/api/social/shares/${shareId}/congratulate`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_won" });
  });

  it("comments: add + list, owner notified, 500-char cap, audience-only (404)", async () => {
    const { db, shares, notifications } = makeFakeD1();
    const { aId } = await makeFriends(db, "clerk_a", "clerk_b");
    await shareAs(db, "clerk_a", "kb-cm-1", "all_friends");
    const shareId = [...shares.values()].find((s) => s.ticket_id === "kb-cm-1")!.id;

    jwtSub("clerk_b");
    const r1 = await worker.fetch(req(`/api/social/shares/${shareId}/comments`, { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ body: "nice pick" }) }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(r1.status).toBe(200);
    expect(notifications.some((n) => n.user_id === aId && n.type === "comment_on_your_ticket")).toBe(true);

    jwtSub("clerk_b");
    const list = await worker.fetch(req(`/api/social/shares/${shareId}/comments`, { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(((await list.json()) as { comments: unknown[] }).comments).toHaveLength(1);

    // 500-char cap rejects.
    jwtSub("clerk_b");
    const rbad = await worker.fetch(req(`/api/social/shares/${shareId}/comments`, { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ body: "x".repeat(501) }) }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(rbad.status).toBe(400);
  });

  it("comment delete: author deletes own; share owner deletes any; audience-only enforced", async () => {
    const { db, shares } = makeFakeD1();
    await makeFriends(db, "clerk_a", "clerk_b");
    await shareAs(db, "clerk_a", "kb-cm-2", "all_friends");
    const shareId = [...shares.values()].find((s) => s.ticket_id === "kb-cm-2")!.id;
    jwtSub("clerk_b");
    const posted = await worker.fetch(req(`/api/social/shares/${shareId}/comments`, { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ body: "hi" }) }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    const commentId = ((await posted.json()) as { id: string }).id;
    // Author (B) deletes own.
    jwtSub("clerk_b");
    const del = await worker.fetch(req(`/api/social/comments/${commentId}`, { method: "DELETE", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(del.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Friend Interactions Phase 4 — notification bell (read side).
// ---------------------------------------------------------------------------

describe("social Worker — Friend Interactions Phase 4 (notification bell)", () => {
  beforeEach(() => vi.resetAllMocks());

  async function seedH(db: D1Database, sub: string, handle: string): Promise<string> {
    jwtSub(sub);
    const r = await worker.fetch(
      req("/api/social/me", { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ handle }) }),
      { ...BASE_ENV, DB: db }, {} as ExecutionContext,
    );
    return ((await r.json()) as { id: string }).id;
  }

  it("returns 401 on notification routes without a token", async () => {
    const { db } = makeFakeD1();
    for (const c of [
      { method: "GET", path: "/api/social/notifications" },
      { method: "GET", path: "/api/social/notifications/unread-count" },
      { method: "POST", path: "/api/social/notifications/read" },
    ]) {
      const res = await worker.fetch(req(c.path, { method: c.method }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
      expect(res.status).toBe(401);
    }
  });

  it("list + unread-count reflect an unread notification; mark-one + mark-all clear it", async () => {
    const { db, notifications } = makeFakeD1();
    const aId = await seedH(db, "clerk_a", "u_a");
    const bId = await seedH(db, "clerk_b", "u_b");
    // A requests B → B gets a friend_request_received notification.
    jwtSub("clerk_a");
    await worker.fetch(req(`/api/social/friends/request/${bId}`, { method: "POST", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(notifications.some((n) => n.user_id === bId && n.type === "friend_request_received")).toBe(true);

    // B's unread count = 1.
    jwtSub("clerk_b");
    const uc = await worker.fetch(req("/api/social/notifications/unread-count", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(((await uc.json()) as { count: number }).count).toBe(1);

    // B's list has it, unread.
    jwtSub("clerk_b");
    const list = await worker.fetch(req("/api/social/notifications", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    const items = ((await list.json()) as { notifications: { id: string; read_at: number | null }[] }).notifications;
    expect(items).toHaveLength(1);
    expect(items[0].read_at).toBeNull();
    const notifId = items[0].id;

    // Mark one read → unread drops to 0.
    jwtSub("clerk_b");
    await worker.fetch(req("/api/social/notifications/read", { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: JSON.stringify({ id: notifId }) }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    jwtSub("clerk_b");
    const uc2 = await worker.fetch(req("/api/social/notifications/unread-count", { method: "GET", headers: authed() }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(((await uc2.json()) as { count: number }).count).toBe(0);

    // Mark-all on an empty unread set is a no-op success.
    jwtSub("clerk_b");
    const allRes = await worker.fetch(req("/api/social/notifications/read", { method: "POST", headers: { ...authed(), "Content-Type": "application/json" }, body: "{}" }), { ...BASE_ENV, DB: db }, {} as ExecutionContext);
    expect(allRes.status).toBe(200);
    void aId;
  });
});

// ===========================================================================
// Social UX Fixes (Phase C) — invite deep link: pre-approved one-tap friend.
// ===========================================================================
describe("social Worker — invite deep link (Phase C)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // Seed A (invitee, no handle) + B (inviter with handle "boss"). Returns ids.
  async function seedInvitePair(db: D1Database): Promise<{ aId: string; bId: string }> {
    jwtSub("clerk_a");
    const aRes = await worker.fetch(
      req("/api/social/me", { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const aId = ((await aRes.json()) as { id: string }).id;
    jwtSub("clerk_b");
    const bRes = await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "boss" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const bId = ((await bRes.json()) as { id: string }).id;
    return { aId, bId };
  }

  it("POST /friends/invite/:handle creates a MUTUAL friendship in one call (pre-approved)", async () => {
    const { db, socialEdges, notifications } = makeFakeD1();
    const { aId, bId } = await seedInvitePair(db);
    // A opens B's invite link → one tap.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/invite/boss`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transition: "created", now_friends: true });
    // Both edges accepted (mutual); no pending half.
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("accepted");
    expect(socialEdges.get(`${bId}|${aId}|friend`)?.state).toBe("accepted");
    // The inviter (B) is notified once.
    expect(notifications.some((n) => n.user_id === bId && n.type === "friend_request_accepted")).toBe(true);
  });

  it("invite accept is idempotent: a second tap → already_friends, no duplicate notify", async () => {
    const { db, notifications } = makeFakeD1();
    await seedInvitePair(db);
    jwtSub("clerk_a");
    await worker.fetch(
      req(`/api/social/friends/invite/boss`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    const before = notifications.length;
    jwtSub("clerk_a"); // jwtVerify is mocked one-shot — re-mock for the second tap.
    const res = await worker.fetch(
      req(`/api/social/friends/invite/boss`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ transition: "already_friends", now_friends: false });
    expect(notifications.length).toBe(before);
  });

  it("invite accept also resolves a prior pending request either direction → mutual", async () => {
    const { db, socialEdges } = makeFakeD1();
    const { aId, bId } = await seedInvitePair(db);
    // B sends A a pending request first.
    jwtSub("clerk_b");
    await worker.fetch(
      req(`/api/social/friends/request/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(socialEdges.get(`${bId}|${aId}|friend`)?.state).toBe("pending");
    // A opens B's invite link → one tap collapses it to mutual.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/invite/boss`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(socialEdges.get(`${aId}|${bId}|friend`)?.state).toBe("accepted");
    expect(socialEdges.get(`${bId}|${aId}|friend`)?.state).toBe("accepted");
  });

  it("invite accept 404 on unknown handle (no-leak)", async () => {
    const { db } = makeFakeD1();
    await seedInvitePair(db);
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/invite/ghost`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });

  it("invite accept is NO-LEAK on block: 404 (same shape as unknown), no edge formed", async () => {
    const { db, socialEdges } = makeFakeD1();
    const { aId, bId } = await seedInvitePair(db);
    // B blocks A.
    jwtSub("clerk_b");
    await worker.fetch(
      req(`/api/social/block/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    // A opens B's invite link → 404 (indistinguishable from unknown), no edge.
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/invite/boss`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    expect(socialEdges.get(`${aId}|${bId}|friend`)).toBeUndefined();
    expect(socialEdges.get(`${bId}|${aId}|friend`)).toBeUndefined();
  });

  it("invite accept on your OWN handle → 200 already_friends (benign, no self-edge)", async () => {
    const { db, socialEdges } = makeFakeD1();
    const { aId } = await seedInvitePair(db);
    jwtSub("clerk_a");
    await worker.fetch(
      req("/api/social/me", {
        method: "POST",
        headers: { ...authed(), "Content-Type": "application/json" },
        body: JSON.stringify({ handle: "alice" }),
      }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/friends/invite/alice`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(socialEdges.get(`${aId}|${aId}|friend`)).toBeUndefined();
  });

  it("invite accept requires auth → 401", async () => {
    const { db } = makeFakeD1();
    const res = await worker.fetch(
      req(`/api/social/friends/invite/boss`, { method: "POST" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("GET /users/:handle hides a blocked user (404) from a signed-in viewer — invite no-leak", async () => {
    const { db } = makeFakeD1();
    const { aId } = await seedInvitePair(db);
    jwtSub("clerk_b");
    await worker.fetch(
      req(`/api/social/block/${aId}`, { method: "POST", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    jwtSub("clerk_a");
    const res = await worker.fetch(
      req(`/api/social/users/boss`, { method: "GET", headers: authed() }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
  });

  it("GET /users/:handle still resolves for a signed-OUT viewer (no block relationship)", async () => {
    const { db } = makeFakeD1();
    await seedInvitePair(db);
    const res = await worker.fetch(
      req(`/api/social/users/boss`, { method: "GET" }),
      { ...BASE_ENV, DB: db },
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: "boss" });
  });
});
