// ADR-0007 Phase 3 — keibamon-social Worker.
//
// Identity (Phase 1) + per-user ticket persistence (Phase 2) + social graph
// (Phase 3: follows, cheers, public profiles, feed, friends-on-race). ISOLATED
// from the racing Worker:
//   - separate D1 (keibamon_social) — NEVER references keibamon-live
//   - separate origin (Phase 1: *.workers.dev subdomain; custom domain later)
//   - routes live under /api/social/*. /api/live stays on the racing Worker;
//     this Worker returns 404 for everything else.
//
// Auth: Clerk JWT in `Authorization: Bearer <jwt>`, verified with jose against
// Clerk's JWKS. Missing/invalid → 401. CORS is handled here (racing Worker
// untouched). Profile upsert is by clerk_user_id (INSERT ... ON CONFLICT).
//
// Phase 2 ticket model: payload is the verbatim CommittedTicket JSON; the flat
// columns (state, returned, race_key, payout_base) are the resolver / query
// surface. Ownership is enforced on every write: a row's user_id is fixed at
// INSERT and PATCH checks it before any update.
//
// Phase 3 social model:
//   - follows: asymmetric Twitter-style graph. INSERT ... DO NOTHING makes a
//     repeat follow idempotent. self-follow blocked at the handler level
//     (CHECK constraint is the backstop).
//   - cheers: 1 row per (ticket_id, user_id). Count is COUNT(*) from the
//     cheers table — never a denormalized counter (Decision 1: correctness
//     over speed; the 45s client poll hides any read latency). Self-cheer
//     forbidden (Decision 2); uncheer supported (Decision 3).
//   - profiles: public fields only (handle, display_name, avatar, counts).
//     clerk_user_id / email / age_verified NEVER leave the Worker.
//   - rate limits: per-user per-minute bucket in D1 (Decision 8). Phase 4
//     replaces with a real token bucket in KV.

import { jwtVerify, createRemoteJWKSet } from "jose";
import { settleSweep } from "./sweep";

export interface Env {
  DB: D1Database;
  CLERK_ISSUER: string;
  /** Optional override. Defaults to `${CLERK_ISSUER}/.well-known/jwks.json`. */
  CLERK_JWKS_URL?: string;
  /** Comma-separated list of allowed origins for CORS. */
  ALLOWED_ORIGINS: string;
  /** Reserved for a later phase that writes publicMetadata from the Worker. */
  CLERK_SECRET_KEY?: string;
  /**
   * Phase 4: base URL of the racing Worker (no trailing slash), used by the
   * cron settle sweep to fetch /api/live. Empty/missing → sweep logs a
   * warning and no-ops.
   */
  LIVE_BASE: string;
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

/** Flat row kept in D1; payload is the verbatim CommittedTicket JSON. */
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

/** A ticket row joined with its owner + cheer aggregate, for feed/profile. */
interface TicketWithSocial extends TicketRow {
  owner_handle: string | null;
  owner_display_name: string | null;
  owner_avatar: string | null;
  cheers_count: number;
}

const TOKEN_RE = /^Bearer\s+(.+)$/i;
const NOW = () => Math.floor(Date.now() / 1000);

/** Allowed state values on insert/update. Keep in sync with frontend CommittedState. */
const TICKET_STATES = new Set(["open", "won", "miss", "refunded"]);

/** Rate-limit ceilings per action per minute. Decision 8. */
const RATE_LIMITS: Record<string, number> = {
  follow: 30,
  cheer: 60,
  ticket: 20,
  // Phase 4: block + report abuse guards. Block is generous (users curating
  // their feed shouldn't hit it); report is tight (the moderation queue
  // shouldn't be spammed).
  block: 30,
  report: 10,
};
const RATE_WINDOW = 60; // seconds

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allow = origin && allowedOrigins(env).includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
      ...cors,
    },
  });
}

function jwksUrl(env: Env): URL {
  const raw = env.CLERK_JWKS_URL || `${env.CLERK_ISSUER}/.well-known/jwks.json`;
  return new URL(raw);
}

const keyCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getKey(env: Env): ReturnType<typeof createRemoteJWKSet> {
  const url = jwksUrl(env).toString();
  let k = keyCache.get(url);
  if (!k) {
    k = createRemoteJWKSet(new URL(url));
    keyCache.set(url, k);
  }
  return k;
}

async function verifyToken(
  env: Env,
  authHeader: string | null,
): Promise<{ sub: string } | null> {
  if (!authHeader) return null;
  const m = TOKEN_RE.exec(authHeader);
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], getKey(env), {
      issuer: env.CLERK_ISSUER,
    });
    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Insert-or-update by clerk_user_id. On POST with age_verified / handle /
 * display_name / avatar, set them; on GET (or POST without body), upsert with
 * no metadata change. id is generated client-side per the migration spec.
 *
 * Phase 3 additions: handle / display_name / avatar are mutable. Handle
 * collisions surface as a 409 from the caller (the unique partial index
 * rejects the INSERT); we detect that here and return null with a flag.
 */
async function upsertUser(
  db: D1Database,
  clerkUserId: string,
  patch: {
    age_verified?: number | null;
    handle?: string | null;
    display_name?: string | null;
    avatar?: string | null;
  },
): Promise<{ ok: true; row: UserRow } | { ok: false; code: "handle_taken" | "server_error" }> {
  const id = crypto.randomUUID();
  const createdAt = NOW();
  const hasPatch =
    patch.age_verified !== null && patch.age_verified !== undefined
      ? true
      : patch.handle !== null && patch.handle !== undefined
        ? true
        : patch.display_name !== null && patch.display_name !== undefined
          ? true
          : patch.avatar !== null && patch.avatar !== undefined;
  if (hasPatch) {
    // Build a single UPDATE that touches only the fields supplied. The unique
    // partial index on (handle WHERE handle IS NOT NULL) will reject a
    // duplicate handle with SQLITE_CONSTRAINT_UNIQUE — surface that as
    // {ok:false, code:"handle_taken"}.
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (patch.age_verified !== null && patch.age_verified !== undefined) {
      sets.push("age_verified = ?");
      binds.push(patch.age_verified);
    }
    if (patch.handle !== null && patch.handle !== undefined) {
      sets.push("handle = ?");
      binds.push(patch.handle);
    }
    if (patch.display_name !== null && patch.display_name !== undefined) {
      sets.push("display_name = ?");
      binds.push(patch.display_name);
    }
    if (patch.avatar !== null && patch.avatar !== undefined) {
      sets.push("avatar = ?");
      binds.push(patch.avatar);
    }
    try {
      const row = await db
        .prepare(
          `INSERT INTO users (id, clerk_user_id, age_verified, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(clerk_user_id) DO UPDATE SET ${sets.join(", ")}
           RETURNING *`,
        )
        .bind(id, clerkUserId, patch.age_verified ?? 0, createdAt, ...binds)
        .first<UserRow>();
      if (!row) return { ok: false, code: "server_error" };
      return { ok: true, row };
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      if (/UNIQUE/i.test(msg) && /handle/i.test(msg)) {
        return { ok: false, code: "handle_taken" };
      }
      // Re-check: the unique constraint may also manifest as a plain
      // CONSTRAINT_UNIQUE without the column name. D1 error strings vary by
      // SQLite build — be permissive.
      if (/UNIQUE/i.test(msg)) {
        return { ok: false, code: "handle_taken" };
      }
      return { ok: false, code: "server_error" };
    }
  }
  // GET (or POST without body): create-if-missing, then read.
  await db
    .prepare(
      `INSERT INTO users (id, clerk_user_id, age_verified, created_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(clerk_user_id) DO NOTHING`,
    )
    .bind(id, clerkUserId, createdAt)
    .run();
  const row = await db
    .prepare(`SELECT * FROM users WHERE clerk_user_id = ?`)
    .bind(clerkUserId)
    .first<UserRow>();
  if (!row) return { ok: false, code: "server_error" };
  return { ok: true, row };
}

// ---------------------------------------------------------------------------
// Phase 2 — ticket persistence.
//
// POST body shape (a frontend CommittedTicket; payload is opaque to us):
//   {
//     id: "kb-...", serial: "KB-XXXXXX", state: "open", payoutBase: N,
//     ticket: {...}, race: {...}, mood, unit, createdAt: epoch_ms, ...
//   }
// The body's `id` is the PRIMARY KEY; we don't regenerate it. The race_key
// column is extracted from `race.raceKey` so we can scan by race later if
// settlement is ever moved server-side (today: client-side PATCH).

interface CommittedTicketBody {
  id?: unknown;
  serial?: unknown;
  state?: unknown;
  payoutBase?: unknown;
  unit?: unknown;
  createdAt?: unknown;
  race?: { raceKey?: unknown } | null;
  // The rest is opaque recommender output + race snapshot.
  [k: string]: unknown;
}

interface PatchBody {
  state?: unknown;
  returned?: unknown;
}

interface ParsedTicketBody {
  id: string;
  serial: string;
  raceKey: string;
  payload: string;
  state: string;
  payoutBase: number;
  createdAt: number;
}

function parseTicketBody(body: unknown): { ok: true; ticket: ParsedTicketBody } | { ok: false; code: string } {
  const b = body as CommittedTicketBody;
  if (typeof b.id !== "string" || !b.id) return { ok: false, code: "bad_id" };
  if (typeof b.serial !== "string" || !b.serial) return { ok: false, code: "bad_serial" };
  if (typeof b.state !== "string" || !TICKET_STATES.has(b.state)) {
    return { ok: false, code: "bad_state" };
  }
  if (typeof b.payoutBase !== "number" || !Number.isFinite(b.payoutBase)) {
    return { ok: false, code: "bad_payout_base" };
  }
  if (typeof b.createdAt !== "number" || !Number.isFinite(b.createdAt)) {
    return { ok: false, code: "bad_created_at" };
  }
  const raceKey =
    typeof b.race?.raceKey === "string" && b.race.raceKey ? b.race.raceKey : "";
  if (!raceKey) return { ok: false, code: "bad_race_key" };
  return {
    ok: true,
    ticket: {
      id: b.id,
      serial: b.serial,
      state: b.state,
      payoutBase: b.payoutBase,
      createdAt: b.createdAt,
      raceKey,
      payload: JSON.stringify(body),
    },
  };
}

async function insertTicket(
  db: D1Database,
  userId: string,
  parsed: {
    id: string;
    serial: string;
    raceKey: string;
    payload: string;
    state: string;
    payoutBase: number;
    createdAt: number;
  },
): Promise<TicketRow | null> {
  return db
    .prepare(
      `INSERT INTO tickets (id, user_id, serial, race_key, payload, state, payout_base, returned, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         state = excluded.state,
         payout_base = excluded.payout_base,
         returned = NULL
       RETURNING *`,
    )
    .bind(
      parsed.id,
      userId,
      parsed.serial,
      parsed.raceKey,
      parsed.payload,
      parsed.state,
      parsed.payoutBase,
      Math.floor(parsed.createdAt / 1000),
    )
    .first<TicketRow>();
}

/**
 * Decode a TicketRow into the client's CommittedTicket shape by parsing the
 * verbatim payload, then overlaying the flat columns (state, returned) so the
 * client sees the resolver's latest state, not the stale snapshot in payload.
 *
 * Phase 3: also overlays `cheers` (count) and `cheeredByMe` if supplied, and
 * strips any stale `claps` payload field so cached Phase 2 tickets don't carry
 * a value the client would otherwise render alongside the new server count.
 */
function decodeTicket(
  row: TicketRow,
  social?: { owner?: Record<string, unknown> | null; cheers?: number; cheeredByMe?: boolean },
): Record<string, unknown> | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  body.state = row.state;
  body.returned = row.returned;
  // Phase 3: claps are now server COUNT(*) from cheers. Strip the legacy
  // Phase 2 payload field so the client never renders a stale value.
  delete body.claps;
  if (social?.owner !== undefined) {
    body.owner = social.owner;
  }
  if (social?.cheers !== undefined) {
    body.cheers = social.cheers;
  }
  if (social?.cheeredByMe !== undefined) {
    body.cheeredByMe = social.cheeredByMe;
  }
  return body;
}

async function listTickets(db: D1Database, userId: string): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, serial, race_key, payload, state, payout_base, returned, created_at
         FROM tickets
        WHERE user_id = ?
        ORDER BY created_at DESC`,
    )
    .bind(userId)
    .all<TicketRow>();
  const out: Record<string, unknown>[] = [];
  for (const row of results) {
    const decoded = decodeTicket(row);
    if (decoded) out.push(decoded);
  }
  return out;
}

async function findTicket(db: D1Database, id: string): Promise<TicketRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, serial, race_key, payload, state, payout_base, returned, created_at
         FROM tickets
        WHERE id = ?`,
    )
    .bind(id)
    .first<TicketRow>();
}

/**
 * Owner-checked update. Returns:
 *   - {status:404} when the row doesn't exist
 *   - {status:403} when the row exists but belongs to another user
 *   - {status:200, row} on success
 *
 * Only `state` and `returned` are mutable. Phase 3 removed `claps` from this
 * surface — claps are now server COUNT(*) from cheers.
 */
async function patchTicket(
  db: D1Database,
  id: string,
  userId: string,
  patch: PatchBody,
): Promise<{ status: 200; row: Record<string, unknown> } | { status: 404 } | { status: 403 }> {
  const row = await findTicket(db, id);
  if (!row) return { status: 404 };
  if (row.user_id !== userId) return { status: 403 };

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // Flat column updates.
  let newState = row.state;
  let newReturned = row.returned;
  if (typeof patch.state === "string" && TICKET_STATES.has(patch.state)) {
    newState = patch.state;
  }
  if (typeof patch.returned === "number" && Number.isFinite(patch.returned)) {
    newReturned = Math.floor(patch.returned);
  } else if (patch.returned === null) {
    newReturned = null;
  }

  // Phase 3: strip any cached claps on write too, so the next read stays clean.
  delete body.claps;

  const newPayload = JSON.stringify(body);
  await db
    .prepare(
      `UPDATE tickets
          SET state = ?, returned = ?, payload = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(newState, newReturned, newPayload, id, userId)
    .run();

  const decoded = decodeTicket({
    ...row,
    state: newState,
    returned: newReturned,
    payload: newPayload,
  });
  return { status: 200, row: decoded ?? body };
}

/**
 * Owner-less state transition used by the cron settle sweep. Idempotent:
 * the `WHERE state = 'open'` clause makes concurrent sweeps + client PATCH
 * races safe (a sweep can't re-settle an already-settled row). Does NOT
 * rewrite the payload — `decodeTicket` overlays the flat columns on top of
 * the stale payload, so the rendered state stays correct.
 *
 * Returns true iff a row was actually updated.
 */
export async function patchTicketState(
  db: D1Database,
  id: string,
  state: "won" | "miss" | "refunded",
  returned: number | null,
): Promise<boolean> {
  const { meta } = await db
    .prepare(
      `UPDATE tickets
          SET state = ?, returned = ?
        WHERE id = ? AND state = 'open'`,
    )
    .bind(state, returned, id)
    .run();
  const changes = (meta as { changes?: number } | null)?.changes ?? 0;
  return changes > 0;
}

// ---------------------------------------------------------------------------
// Phase 3 — social primitives (follows, cheers, rate limits, profile, feed).
// ---------------------------------------------------------------------------

/** Public-safe user projection. NEVER include clerk_user_id, email, age_verified. */
function publicUser(u: UserRow, extra?: { follower_count?: number; followee_count?: number; is_following?: boolean }): Record<string, unknown> {
  return {
    id: u.id,
    handle: u.handle,
    display_name: u.display_name,
    avatar: u.avatar,
    created_at: u.created_at,
    ...(extra ?? {}),
  };
}

/** Rate-limit check; returns true if the action is allowed (and records it). */
async function rateLimitCheck(
  db: D1Database,
  userId: string,
  action: string,
): Promise<boolean> {
  const limit = RATE_LIMITS[action];
  if (!limit) return true; // unknown action: don't block
  const bucket = Math.floor(NOW() / RATE_WINDOW);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (user_id, action, bucket, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id, action, bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(userId, action, bucket)
    .first<{ count: number }>();
  // row.count is the post-increment value; allow iff it's within the limit.
  return (row?.count ?? 0) <= limit;
}

async function userById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
}

async function userByHandle(db: D1Database, handle: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE handle = ?`).bind(handle).first<UserRow>();
}

/** Insert-or-nothing follow. Idempotent — a repeat follow is a no-op 200. */
async function followUser(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO follows (follower_id, followee_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(follower_id, followee_id) DO NOTHING`,
    )
    .bind(followerId, followeeId, NOW())
    .run();
}

async function unfollowUser(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`,
    )
    .bind(followerId, followeeId)
    .run();
}

async function isFollowing(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?`,
    )
    .bind(followerId, followeeId)
    .first<{ "1": number }>();
  return !!row;
}

async function followerCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function followeeCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Count of cheers on a ticket (Decision 1: COUNT(*), never a denormalized column). */
async function cheerCount(db: D1Database, ticketId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM cheers WHERE ticket_id = ?`)
    .bind(ticketId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function hasCheered(
  db: D1Database,
  ticketId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM cheers WHERE ticket_id = ? AND user_id = ?`)
    .bind(ticketId, userId)
    .first<{ "1": number }>();
  return !!row;
}

/**
 * Insert-or-nothing cheer. Returns the post-call count + cheeredByMe state.
 * Caller enforces won-only + self-cheer rules before calling.
 */
async function addCheer(
  db: D1Database,
  ticketId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cheers (ticket_id, user_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(ticket_id, user_id) DO NOTHING`,
    )
    .bind(ticketId, userId, NOW())
    .run();
}

async function removeCheer(
  db: D1Database,
  ticketId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM cheers WHERE ticket_id = ? AND user_id = ?`)
    .bind(ticketId, userId)
    .run();
}

// ---------------------------------------------------------------------------
// Phase 4 — block + report primitives.
//
// Block is asymmetric + one-way (Twitter model): INSERT means `blocker` has
// blocked `blocked`. A block:
//   1. Severs existing follows in BOTH directions (A blocks B → A unfollows
//      B AND B unfollows A).
//   2. Prevents future follow/cheer between the pair, in either direction
//      (A can't follow or cheer B; B can't follow or cheer A).
//   3. Filters the blocked user's tickets out of the BLOCKER's feed (one-way
//      — the blocked user can still see the blocker's tickets, mirroring the
//      "I don't want to see them" intent of a block).
//
// Report is write-only: rows land in `reports` for later moderation review
// (Phase 4 backlog — no review UI ships in this phase).

/** Returns true if EITHER user has blocked the other (block is symmetric for
 *  the purpose of social interaction guards — either side blocks the pair). */
async function blockExistsEitherDirection(
  db: D1Database,
  aId: string,
  bId: string,
): Promise<boolean> {
  if (aId === bId) return false;
  const row = await db
    .prepare(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?)
           OR (blocker_id = ? AND blocked_id = ?)`,
    )
    .bind(aId, bId, bId, aId)
    .first<{ "1": number }>();
  return !!row;
}

/** Insert-or-nothing block + sever existing follows both ways. Idempotent. */
async function blockUser(
  db: D1Database,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO blocks (blocker_id, blocked_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(blocker_id, blocked_id) DO NOTHING`,
    )
    .bind(blockerId, blockedId, NOW())
    .run();
  // Sever follows in both directions. Two DELETEs, not one — the pair is
  // asymmetric (follower/followee) so each direction needs its own clause.
  await db
    .prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`)
    .bind(blockerId, blockedId)
    .run();
  await db
    .prepare(`DELETE FROM follows WHERE follower_id = ? AND followee_id = ?`)
    .bind(blockedId, blockerId)
    .run();
}

async function unblockUser(
  db: D1Database,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?`)
    .bind(blockerId, blockedId)
    .run();
}

/** Write a report row. Returns true on success. Caller validates fields + rate. */
async function addReport(
  db: D1Database,
  reporterId: string,
  targetType: "ticket" | "user",
  targetId: string,
  reason: string,
): Promise<boolean> {
  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, reporterId, targetType, targetId, reason, NOW())
      .run();
    return true;
  } catch {
    // FK violation (target user doesn't exist) or CHECK — caller has already
    // validated; treat any error as a soft failure.
    return false;
  }
}

/** Decode a TicketWithSocial into the client's CommittedTicket shape. */
function decodeSocialTicket(
  row: TicketWithSocial,
  cheeredByMe: boolean,
): Record<string, unknown> | null {
  // owner per Decision 9: client derives TicketOwner; server sends flat fields.
  const owner =
    row.owner_handle || row.owner_display_name
      ? {
          id: row.user_id,
          handle: row.owner_handle,
          display_name: row.owner_display_name,
          avatar: row.owner_avatar,
        }
      : null;
  return decodeTicket(row, {
    owner,
    cheers: row.cheers_count ?? 0,
    cheeredByMe,
  });
}

/**
 * Feed: caller's own tickets + followees' tickets, newest first, cap 100.
 * Each ticket carries owner + cheers count + cheeredByMe.
 *
 * Phase 4: filters out tickets owned by users the caller has blocked
 * (one-way — the blocked user can still see the blocker's tickets).
 */
async function buildFeed(
  db: D1Database,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.user_id, t.serial, t.race_key, t.payload, t.state,
              t.payout_base, t.returned, t.created_at,
              u.handle AS owner_handle,
              u.display_name AS owner_display_name,
              u.avatar AS owner_avatar,
              COALESCE(c.n, 0) AS cheers_count
         FROM tickets t
         JOIN users u ON u.id = t.user_id
         LEFT JOIN (SELECT ticket_id, COUNT(*) AS n FROM cheers GROUP BY ticket_id) c
           ON c.ticket_id = t.id
        WHERE (t.user_id = ?
           OR t.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?))
           AND NOT EXISTS (
             SELECT 1 FROM blocks
              WHERE blocker_id = ? AND blocked_id = t.user_id
           )
        ORDER BY t.created_at DESC
        LIMIT 100`,
    )
    .bind(userId, userId, userId)
    .all<TicketWithSocial>();
  const out: Record<string, unknown>[] = [];
  for (const row of results) {
    // Single-row cheeredByMe lookup — N+1 is fine at cap 100 with an index.
    const byMe = await hasCheered(db, row.id, userId);
    const decoded = decodeSocialTicket(row, byMe);
    if (decoded) out.push(decoded);
  }
  return out;
}

/** Public profile: a user's public-safe fields + their tickets (newest first). */
async function buildProfile(
  db: D1Database,
  profileUser: UserRow,
  viewerUserId: string | null,
): Promise<Record<string, unknown>> {
  const [folls, follees, ticketsRaw] = await Promise.all([
    followerCount(db, profileUser.id),
    followeeCount(db, profileUser.id),
    db
      .prepare(
        `SELECT t.id, t.user_id, t.serial, t.race_key, t.payload, t.state,
                t.payout_base, t.returned, t.created_at,
                u.handle AS owner_handle,
                u.display_name AS owner_display_name,
                u.avatar AS owner_avatar,
                COALESCE(c.n, 0) AS cheers_count
           FROM tickets t
           JOIN users u ON u.id = t.user_id
           LEFT JOIN (SELECT ticket_id, COUNT(*) AS n FROM cheers GROUP BY ticket_id) c
             ON c.ticket_id = t.id
          WHERE t.user_id = ?
          ORDER BY t.created_at DESC
          LIMIT 50`,
      )
      .bind(profileUser.id)
      .all<TicketWithSocial>(),
  ]);
  const isFollowing = viewerUserId
    ? await isFollowingCheck(db, viewerUserId, profileUser.id)
    : false;
  const tickets: Record<string, unknown>[] = [];
  for (const row of ticketsRaw.results) {
    const byMe = viewerUserId ? await hasCheered(db, row.id, viewerUserId) : false;
    const decoded = decodeSocialTicket(row, byMe);
    if (decoded) tickets.push(decoded);
  }
  return {
    ...publicUser(profileUser, {
      follower_count: folls,
      followee_count: follees,
      is_following: isFollowing,
    }),
    tickets,
  };
}

async function isFollowingCheck(
  db: D1Database,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  if (followerId === followeeId) return false;
  return isFollowing(db, followerId, followeeId);
}

interface FriendsAvatars {
  count: number;
  avatars: { handle: string | null; display_name: string | null; avatar: string | null }[];
}

/** Friends-on-race: followed users with ≥1 ticket on this raceKey. */
async function friendsOnRace(
  db: D1Database,
  userId: string,
  raceKey: string,
): Promise<FriendsAvatars> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.handle, u.display_name, u.avatar
         FROM follows f
         JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ?
          AND EXISTS (
            SELECT 1 FROM tickets t
             WHERE t.user_id = f.followee_id AND t.race_key = ?
          )`,
    )
    .bind(userId, raceKey)
    .all<{ handle: string | null; display_name: string | null; avatar: string | null }>();
  return {
    count: results.length,
    avatars: results.slice(0, 8),
  };
}

/** Friends-on-card: followed users with ≥1 ticket on ANY race in the snapshot. */
async function friendsOnCard(
  db: D1Database,
  userId: string,
  raceKeys: string[],
): Promise<FriendsAvatars> {
  if (raceKeys.length === 0) return { count: 0, avatars: [] };
  // D1 prepared bindings cap at a conservative number; chunk with an IN list.
  const placeholders = raceKeys.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT DISTINCT u.handle, u.display_name, u.avatar
         FROM follows f
         JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id = ?
          AND EXISTS (
            SELECT 1 FROM tickets t
             WHERE t.user_id = f.followee_id AND t.race_key IN (${placeholders})
          )`,
    )
    .bind(userId, ...raceKeys)
    .all<{ handle: string | null; display_name: string | null; avatar: string | null }>();
  return {
    count: results.length,
    avatars: results.slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

const TICKET_PATH = /^\/api\/social\/tickets(\/([^/]+))?$/;
const TICKET_CHEER_PATH = /^\/api\/social\/tickets\/([^/]+)\/cheer$/;
const FOLLOW_PATH = /^\/api\/social\/follow\/([^/]+)$/;
const BLOCK_PATH = /^\/api\/social\/block\/([^/]+)$/;
const PROFILE_PATH = /^\/api\/social\/users\/([^/]+)$/;
const RACE_FRIENDS_PATH = /^\/api\/social\/races\/([^/]+)\/friends$/;
const FEED_PATH = "/api/social/feed";
const FRIENDS_ON_CARD_PATH = "/api/social/friends/on-card";
const REPORT_PATH = "/api/social/report";
// ADR-0018: account-backed impression marks. GET = the caller's full map;
// PUT = transactional full-replace. Lives under /me/ because impressions are
// strictly per-user and never public.
const IMPRESSIONS_PATH = "/api/social/me/impressions";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    return router(request, env, cors);
  },

  // ADR-0007 Phase 4: cron settle sweep. Trigger every 5 min UTC (see
  // wrangler.jsonc `triggers.crons`). The sweep fetches /api/live from the
  // racing Worker via LIVE_BASE and settles OPEN tickets whose race has
  // reached `status === 'result'`. ctx.waitUntil keeps the request alive
  // past the response so the cron doesn't cut the sweep short.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(settleSweep(env));
  },
};

async function router(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // /api/social/me — Phase 1 identity (+ Phase 3 handle/dn/avatar patch).
  if (pathname === "/api/social/me") {
    return handleMe(request, env, cors);
  }

  // /api/social/me/impressions — ADR-0018 account-backed marks (GET full map,
  // PUT transactional full-replace). Auth required.
  if (pathname === IMPRESSIONS_PATH) {
    return handleImpressions(request, env, cors);
  }

  // /api/social/follow/:userId — Phase 3 follow graph.
  const followMatch = FOLLOW_PATH.exec(pathname);
  if (followMatch) {
    return handleFollow(request, env, cors, decodeURIComponent(followMatch[1]));
  }

  // /api/social/block/:userId — Phase 4 block graph (POST = block, DELETE = unblock).
  const blockMatch = BLOCK_PATH.exec(pathname);
  if (blockMatch) {
    return handleBlock(request, env, cors, decodeURIComponent(blockMatch[1]));
  }

  // /api/social/report — Phase 4 moderation intake.
  if (pathname === REPORT_PATH) {
    return handleReport(request, env, cors);
  }

  // /api/social/tickets/:id/cheer — Phase 3 cheers.
  const cheerMatch = TICKET_CHEER_PATH.exec(pathname);
  if (cheerMatch) {
    return handleCheer(request, env, cors, decodeURIComponent(cheerMatch[1]));
  }

  // /api/social/tickets and /api/social/tickets/:id — Phase 2 persistence.
  const ticketMatch = TICKET_PATH.exec(pathname);
  if (ticketMatch && !TICKET_CHEER_PATH.exec(pathname)) {
    return handleTickets(request, env, cors, ticketMatch[2] ?? null);
  }

  // /api/social/feed — Phase 3 feed.
  if (pathname === FEED_PATH) {
    return handleFeed(request, env, cors);
  }

  // /api/social/friends/on-card — Phase 3 today's-card strip.
  if (pathname === FRIENDS_ON_CARD_PATH) {
    return handleFriendsOnCard(request, env, cors, url);
  }

  // /api/social/races/:raceKey/friends — Phase 3 friends-on-race.
  const raceFriendsMatch = RACE_FRIENDS_PATH.exec(pathname);
  if (raceFriendsMatch) {
    return handleRaceFriends(request, env, cors, decodeURIComponent(raceFriendsMatch[1]));
  }

  // /api/social/users/:handle — Phase 3 public profile.
  const profileMatch = PROFILE_PATH.exec(pathname);
  if (profileMatch) {
    return handleProfile(request, env, cors, decodeURIComponent(profileMatch[1]));
  }

  // Only the route prefixes above are served here. /api/live stays on
  // the racing Worker; everything else is 404 (no collision with racing origin).
  return json({ error: "not_found" }, 404, cors);
}

async function handleMe(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) {
    return json({ error: "unauthorized" }, 401, cors);
  }
  const patch: {
    age_verified?: number | null;
    handle?: string | null;
    display_name?: string | null;
    avatar?: string | null;
  } = {};
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as {
        age_verified?: unknown;
        handle?: unknown;
        display_name?: unknown;
        avatar?: unknown;
      };
      if (typeof body.age_verified === "number") patch.age_verified = body.age_verified;
      // Phase 3: handle/dn/avatar. Empty string clears; null also accepted.
      if (typeof body.handle === "string") {
        const h = body.handle.trim();
        if (h.length === 0 || h.length > 32) {
          return json({ error: "bad_handle" }, 400, cors);
        }
        if (!/^[a-zA-Z0-9_]+$/.test(h)) {
          return json({ error: "bad_handle" }, 400, cors);
        }
        patch.handle = h;
      } else if (body.handle === null) {
        patch.handle = null;
      }
      if (typeof body.display_name === "string") {
        const d = body.display_name.trim();
        if (d.length > 64) return json({ error: "bad_display_name" }, 400, cors);
        patch.display_name = d;
      } else if (body.display_name === null) {
        patch.display_name = null;
      }
      if (typeof body.avatar === "string") {
        if (body.avatar.length > 2048) return json({ error: "bad_avatar" }, 400, cors);
        patch.avatar = body.avatar;
      } else if (body.avatar === null) {
        patch.avatar = null;
      }
    } catch {
      // Empty / non-JSON body is fine — treat as upsert-only.
    }
  }
  const result = await upsertUser(env.DB, verified.sub, patch);
  if (!result.ok) {
    if (result.code === "handle_taken") {
      return json({ error: "handle_taken" }, 409, cors);
    }
    return json({ error: "server_error" }, 500, cors);
  }
  return json(result.row, 200, cors);
}

// ---------------------------------------------------------------------------
// ADR-0018: account-backed impression marks.
//
// GET /api/social/me/impressions → { impressions: Row[] }  (Row ≈ client Impression)
// PUT /api/social/me/impressions (body: { impressions: Record<comp_key, Impression> })
//   → { ok: true }  (transactional full-replace: DELETE all user rows, then INSERT)
//
// comp_key is the existing `${race_id}|${horse_key}` store key from
// frontend/src/lib/impressions.ts — server treats it as an opaque string.
// mark is one of the 5 IntuitionKind values (validated); the rest are passed
// through verbatim. The PRIMARY KEY (user_id, comp_key) is the uniqueness
// invariant — full-replace (not upsert-per-key) makes a locally-cleared mark
// propagate server-side without tombstones.
// ---------------------------------------------------------------------------

const ALLOWED_MARKS = new Set(["like", "distrust", "priceHorse", "avoid", "anchor"]);

interface ImpressionRow {
  user_id: string;
  comp_key: string;
  mark: string;
  umaban: number | null;
  odds_when_marked: number | null;
  odds_snapshot_at: string | null;
  formed_at: number;
  updated_at: number;
}

/** Validate + normalize a PUT body into a list of rows ready for INSERT. */
function parseImpressionsBody(
  body: unknown,
  userId: string,
  now: number,
): { ok: true; items: ImpressionRow[] } | { ok: false; code: string } {
  if (!body || typeof body !== "object") return { ok: false, code: "bad_body" };
  const map = (body as { impressions?: unknown }).impressions;
  if (!map || typeof map !== "object") return { ok: false, code: "bad_body" };
  const items: ImpressionRow[] = [];
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (typeof k !== "string" || k.length === 0 || k.length > 512) {
      return { ok: false, code: "bad_comp_key" };
    }
    if (!v || typeof v !== "object") return { ok: false, code: "bad_impression" };
    const imp = v as Record<string, unknown>;
    if (typeof imp.mark !== "string" || !ALLOWED_MARKS.has(imp.mark)) {
      return { ok: false, code: "bad_mark" };
    }
    if (imp.umaban !== null && imp.umaban !== undefined && typeof imp.umaban !== "number") {
      return { ok: false, code: "bad_umaban" };
    }
    if (
      imp.odds_when_marked !== null &&
      imp.odds_when_marked !== undefined &&
      typeof imp.odds_when_marked !== "number"
    ) {
      return { ok: false, code: "bad_odds" };
    }
    if (
      imp.odds_snapshot_at !== null &&
      imp.odds_snapshot_at !== undefined &&
      typeof imp.odds_snapshot_at !== "string"
    ) {
      return { ok: false, code: "bad_snapshot" };
    }
    if (typeof imp.formed_at !== "number" || !Number.isFinite(imp.formed_at)) {
      return { ok: false, code: "bad_formed_at" };
    }
    items.push({
      user_id: userId,
      comp_key: k,
      mark: imp.mark,
      umaban: typeof imp.umaban === "number" ? imp.umaban : null,
      odds_when_marked: typeof imp.odds_when_marked === "number" ? imp.odds_when_marked : null,
      odds_snapshot_at: typeof imp.odds_snapshot_at === "string" ? imp.odds_snapshot_at : null,
      formed_at: imp.formed_at,
      updated_at: now,
    });
  }
  // Bound the per-PUT row count so a hostile/buggy client can't blow up the
  // request. 5k is well above a season's worth of marks (each <200 bytes).
  if (items.length > 5000) return { ok: false, code: "too_many" };
  return { ok: true, items };
}

async function listImpressions(
  db: D1Database,
  userId: string,
): Promise<ImpressionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT comp_key, mark, umaban, odds_when_marked, odds_snapshot_at, formed_at, updated_at
         FROM user_impressions
        WHERE user_id = ?`,
    )
    .bind(userId)
    .all<ImpressionRow>();
  return results;
}

/**
 * Full-replace. Two statements in a single D1 batch (transactional): DELETE
 * all the caller's rows, then INSERT the new set. On failure the transaction
 * rolls back, so the user's prior marks survive a partial-write bug.
 */
async function replaceImpressions(
  db: D1Database,
  userId: string,
  items: ImpressionRow[],
): Promise<void> {
  const del = db
    .prepare(`DELETE FROM user_impressions WHERE user_id = ?`)
    .bind(userId);
  if (items.length === 0) {
    await del.run();
    return;
  }
  const inserts = items.map((it) =>
    db
      .prepare(
        `INSERT INTO user_impressions
           (user_id, comp_key, mark, umaban, odds_when_marked, odds_snapshot_at, formed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        it.user_id,
        it.comp_key,
        it.mark,
        it.umaban,
        it.odds_when_marked,
        it.odds_snapshot_at,
        it.formed_at,
        it.updated_at,
      ),
  );
  await db.batch([del, ...inserts]);
}

async function handleImpressions(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "PUT") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const caller = await ensureCaller(env, cors, verified.sub);
  if ("res" in caller) return caller.res;
  const userId = caller.user.id;

  if (request.method === "GET") {
    const rows = await listImpressions(env.DB, userId);
    return json({ impressions: rows }, 200, cors);
  }

  // PUT
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_body" }, 400, cors);
  }
  const parsed = parseImpressionsBody(body, userId, Date.now());
  if (!parsed.ok) return json({ error: parsed.code }, 400, cors);
  await replaceImpressions(env.DB, userId, parsed.items);
  return json({ ok: true }, 200, cors);
}

/**
 * Phase 3 social handlers call this on every request to guarantee the caller
 * has a user row (the FK on follows/cheers/rate_limits requires it). Returns
 * the row on success; on failure, emits the right HTTP error and returns null
 * so the caller can early-exit.
 */
async function ensureCaller(
  env: Env,
  cors: Record<string, string>,
  clerkSub: string,
): Promise<{ user: UserRow } | { res: Response }> {
  const result = await upsertUser(env.DB, clerkSub, {});
  if (result.ok) return { user: result.row };
  // handle_taken can't happen here (empty patch); surface as 500 regardless.
  return { res: json({ error: "server_error" }, 500, cors) };
}

async function handleTickets(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  id: string | null,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) {
    return json({ error: "unauthorized" }, 401, cors);
  }

  // Ensure the caller has a user row (Phase 1 upsert on first touch). Cheap
  // and keeps the FK valid even if the client skipped POST /api/social/me.
  const caller = await ensureCaller(env, cors, verified.sub);
  if ("res" in caller) return caller.res;
  const userId = caller.user.id;

  if (id === null) {
    // /api/social/tickets
    if (request.method === "GET") {
      const rows = await listTickets(env.DB, userId);
      return json({ tickets: rows }, 200, cors);
    }
    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_body" }, 400, cors);
      }
      // Rate-limit ticket POSTs (Decision 8).
      const allowed = await rateLimitCheck(env.DB, userId, "ticket");
      if (!allowed) {
        return json(
          { error: "rate_limited" },
          429,
          cors,
          { "Retry-After": String(RATE_WINDOW) },
        );
      }
      const parsed = parseTicketBody(body);
      if (!parsed.ok) {
        return json({ error: parsed.code }, 400, cors);
      }
      const row = await insertTicket(env.DB, userId, parsed.ticket);
      if (!row) {
        return json({ error: "server_error" }, 500, cors);
      }
      const decoded = decodeTicket(row);
      return json(decoded ?? { ok: true }, 200, cors);
    }
    return json({ error: "method_not_allowed" }, 405, cors);
  }

  // /api/social/tickets/:id
  if (request.method === "PATCH") {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_body" }, 400, cors);
    }
    const patch: PatchBody =
      body && typeof body === "object" ? (body as PatchBody) : {};
    const result = await patchTicket(env.DB, id, userId, patch);
    if (result.status === 200) {
      return json(result.row, 200, cors);
    }
    const status = result.status;
    return json(
      { error: status === 404 ? "not_found" : "forbidden" },
      status,
      cors,
    );
  }
  return json({ error: "method_not_allowed" }, 405, cors);
}

async function handleFollow(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  targetId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  if (targetId === caller.id) {
    return json({ error: "cannot_follow_self" }, 403, cors);
  }
  // 404 if the target user doesn't exist (don't leak existence via 200).
  const target = await userById(env.DB, targetId);
  if (!target) return json({ error: "not_found" }, 404, cors);

  // Phase 4: a block in EITHER direction forbids follow. The block check
  // happens after the 404 so a missing user still surfaces as not_found,
  // not as a leaky 403.
  const blocked = await blockExistsEitherDirection(env.DB, caller.id, targetId);
  if (blocked) {
    return json({ error: "blocked" }, 403, cors);
  }

  if (request.method === "POST") {
    const allowed = await rateLimitCheck(env.DB, caller.id, "follow");
    if (!allowed) {
      return json(
        { error: "rate_limited" },
        429,
        cors,
        { "Retry-After": String(RATE_WINDOW) },
      );
    }
    await followUser(env.DB, caller.id, targetId);
    return json({ ok: true }, 200, cors);
  }
  // DELETE
  const allowed = await rateLimitCheck(env.DB, caller.id, "follow");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }
  await unfollowUser(env.DB, caller.id, targetId);
  return json({ ok: true }, 200, cors);
}

/**
 * Phase 4 — /api/social/block/:userId.
 *   POST   = block (idempotent; severs follows both ways)
 *   DELETE = unblock (idempotent)
 *
 * Self-block is forbidden (CHECK constraint is the backstop). A 404 for a
 * missing target user is reported as `not_found` (block existence is private;
 * we don't leak it via a different status).
 */
async function handleBlock(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  targetId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  if (targetId === caller.id) {
    return json({ error: "cannot_block_self" }, 403, cors);
  }
  // 404 if the target user doesn't exist (don't leak existence via 200).
  const target = await userById(env.DB, targetId);
  if (!target) return json({ error: "not_found" }, 404, cors);

  // Rate-limit (Phase 4: block gets 30/min — generous, but capped so a
  // compromised token can't DOS the blocks table).
  const allowed = await rateLimitCheck(env.DB, caller.id, "block");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }

  if (request.method === "POST") {
    await blockUser(env.DB, caller.id, targetId);
  } else {
    await unblockUser(env.DB, caller.id, targetId);
  }
  return json({ ok: true }, 200, cors);
}

/**
 * Phase 4 — POST /api/social/report.
 * Body: { target_type: "ticket" | "user", target_id: string, reason: string }
 *
 * Write-only: rows land in `reports` for later moderation review. No UI for
 * review ships in Phase 4 (backlog item). Reason is capped at 500 chars to
 * keep the table cheap; reporters who need more room can file a ticket.
 */
async function handleReport(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub);
  if ("res" in callerR) return callerR.res;
  const caller = callerR.user;

  let body: { target_type?: unknown; target_id?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "bad_body" }, 400, cors);
  }

  if (body.target_type !== "ticket" && body.target_type !== "user") {
    return json({ error: "bad_target_type" }, 400, cors);
  }
  if (typeof body.target_id !== "string" || !body.target_id) {
    return json({ error: "bad_target_id" }, 400, cors);
  }
  if (typeof body.reason !== "string") {
    return json({ error: "bad_reason" }, 400, cors);
  }
  const reason = body.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    return json({ error: "bad_reason" }, 400, cors);
  }

  const allowed = await rateLimitCheck(env.DB, caller.id, "report");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }

  const ok = await addReport(
    env.DB,
    caller.id,
    body.target_type,
    body.target_id,
    reason,
  );
  if (!ok) return json({ error: "server_error" }, 500, cors);
  return json({ ok: true }, 200, cors);
}

async function handleCheer(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  ticketId: string,
): Promise<Response> {
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  if (request.method !== "POST" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;

  const ticket = await findTicket(env.DB, ticketId);
  if (!ticket) return json({ error: "not_found" }, 404, cors);

  // Won-only (Decision table): cheering is a celebration, not pre-race hype.
  if (ticket.state !== "won") {
    return json({ error: "not_won" }, 409, cors);
  }
  // Self-cheer forbidden (Decision 2).
  if (ticket.user_id === caller.id) {
    return json({ error: "cannot_cheer_own_ticket" }, 409, cors);
  }
  // Phase 4: a block in EITHER direction forbids cheer (same rule as follow).
  const blocked = await blockExistsEitherDirection(env.DB, caller.id, ticket.user_id);
  if (blocked) {
    return json({ error: "blocked" }, 403, cors);
  }

  const allowed = await rateLimitCheck(env.DB, caller.id, "cheer");
  if (!allowed) {
    return json(
      { error: "rate_limited" },
      429,
      cors,
      { "Retry-After": String(RATE_WINDOW) },
    );
  }

  if (request.method === "POST") {
    await addCheer(env.DB, ticketId, caller.id);
  } else {
    await removeCheer(env.DB, ticketId, caller.id);
  }
  const [count, byMe] = await Promise.all([
    cheerCount(env.DB, ticketId),
    request.method === "POST"
      ? Promise.resolve(true)
      : Promise.resolve(false),
  ]);
  // For POST, the PK dedupe guarantees the row exists, so cheeredByMe=true
  // is correct without a re-read. For DELETE, even if the row didn't exist
  // (idempotent uncheer), the user is not cheering now.
  return json({ count, cheeredByMe: byMe }, 200, cors);
}

async function handleFeed(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  const tickets = await buildFeed(env.DB, caller.id);
  return json({ tickets }, 200, cors);
}

async function handleProfile(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  handle: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  // JWT OPTIONAL — a signed-out viewer can read a public profile.
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  let viewerId: string | null = null;
  if (verified) {
    const v = await ensureCaller(env, cors, verified.sub);
    if ("res" in v) return v.res;
    viewerId = v.user.id;
  }

  const profileUser = await userByHandle(env.DB, handle);
  if (!profileUser || !profileUser.handle) {
    return json({ error: "not_found" }, 404, cors);
  }
  const profile = await buildProfile(env.DB, profileUser, viewerId);
  return json(profile, 200, cors);
}

async function handleRaceFriends(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  raceKeyRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  // raceKey arrives URL-encoded; the regex already captured the raw segment,
  // and decodeURIComponent was applied by the router. Pipe chars are part of
  // the key ("date|venue|Rn|name") — they're fine.
  void raceKeyRaw;
  return json(await friendsOnRace(env.DB, caller.id, raceKeyRaw), 200, cors);
}

async function handleFriendsOnCard(
  request: Request,
  env: Env,
  cors: Record<string, string>,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed" }, 405, cors);
  }
  const verified = await verifyToken(env, request.headers.get("Authorization"));
  if (!verified) return json({ error: "unauthorized" }, 401, cors);
  const callerR = await ensureCaller(env, cors, verified.sub); if ("res" in callerR) return callerR.res; const caller = callerR.user;
  // The client supplies the current snapshot's raceKeys via ?race= query
  // params (?race=k1&race=k2...). Empty list = empty result.
  const raceKeys = url.searchParams.getAll("race").filter(Boolean);
  return json(await friendsOnCard(env.DB, caller.id, raceKeys), 200, cors);
}
