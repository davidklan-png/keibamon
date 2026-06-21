// ADR-0007 Phase 2 — keibamon-social Worker.
//
// Identity (Phase 1) + per-user ticket persistence (Phase 2). ISOLATED from
// the racing Worker:
//   - separate D1 (keibamon_social) — NEVER references keibamon-live
//   - separate origin (Phase 1: *.workers.dev subdomain; custom domain later)
//   - routes are /api/social/me + /api/social/tickets (+ /:id). /api/live
//     stays on the racing Worker; this Worker returns 404 for everything else.
//
// Auth: Clerk JWT in `Authorization: Bearer <jwt>`, verified with jose against
// Clerk's JWKS. Missing/invalid → 401. CORS is handled here (racing Worker
// untouched). Profile upsert is by clerk_user_id (INSERT ... ON CONFLICT).
//
// Phase 2 ticket model: payload is the verbatim CommittedTicket JSON; the flat
// columns (state, returned, race_key, payout_base) are the resolver / query
// surface. Ownership is enforced on every write: a row's user_id is fixed at
// INSERT and PATCH checks it before any update.

import { jwtVerify, createRemoteJWKSet } from "jose";

export interface Env {
  DB: D1Database;
  CLERK_ISSUER: string;
  /** Optional override. Defaults to `${CLERK_ISSUER}/.well-known/jwks.json`. */
  CLERK_JWKS_URL?: string;
  /** Comma-separated list of allowed origins for CORS. */
  ALLOWED_ORIGINS: string;
  /** Reserved for a later phase that writes publicMetadata from the Worker. */
  CLERK_SECRET_KEY?: string;
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

const TOKEN_RE = /^Bearer\s+(.+)$/i;
const NOW = () => Math.floor(Date.now() / 1000);

/** Allowed state values on insert/update. Keep in sync with frontend CommittedState. */
const TICKET_STATES = new Set(["open", "won", "miss"]);

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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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
 * Insert-or-update by clerk_user_id. On POST with age_verified, set it; on GET
 * (or POST without body), upsert with no metadata change. id is generated
 * client-side per the migration spec.
 */
async function upsertUser(
  db: D1Database,
  clerkUserId: string,
  ageVerified: number | null,
): Promise<UserRow | null> {
  const id = crypto.randomUUID();
  const createdAt = NOW();
  if (ageVerified !== null) {
    const stmt = db.prepare(
      `INSERT INTO users (id, clerk_user_id, age_verified, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(clerk_user_id) DO UPDATE SET age_verified = excluded.age_verified
       RETURNING *`,
    );
    return stmt.bind(id, clerkUserId, ageVerified, createdAt).first<UserRow>();
  }
  // GET (or POST without age_verified): create-if-missing, then read.
  await db
    .prepare(
      `INSERT INTO users (id, clerk_user_id, age_verified, created_at)
       VALUES (?, ?, 0, ?)
       ON CONFLICT(clerk_user_id) DO NOTHING`,
    )
    .bind(id, clerkUserId, createdAt)
    .run();
  return db
    .prepare(`SELECT * FROM users WHERE clerk_user_id = ?`)
    .bind(clerkUserId)
    .first<UserRow>();
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
  claps?: unknown;
}

function parseTicketBody(body: unknown): {
  ok: true;
  ticket: Required<
    Pick<CommittedTicketBody, "id" | "serial" | "state" | "payoutBase" | "createdAt">
  > & { raceKey: string; payload: string };
} | { ok: false; code: string } {
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
 */
function decodeTicket(row: TicketRow): Record<string, unknown> | null {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  body.state = row.state;
  body.returned = row.returned;
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
 * Only `state`, `returned`, and `claps` are mutable; `claps` lives in payload
 * (Phase 3 will hoist it into its own table — for now we patch the JSON).
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

  // claps (still local-only Phase 2; persisted inside payload so the cache
  // survives a reload, NOT shared across users yet).
  if (typeof patch.claps === "number" && Number.isFinite(patch.claps)) {
    body.claps = Math.max(0, Math.floor(patch.claps));
  }

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

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

const TICKET_PATH = /^\/api\/social\/tickets(\/([^/]+))?$/;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // /api/social/me — Phase 1 identity.
    if (pathname === "/api/social/me") {
      return handleMe(request, env, cors);
    }

    // /api/social/tickets and /api/social/tickets/:id — Phase 2 persistence.
    const ticketMatch = TICKET_PATH.exec(pathname);
    if (ticketMatch) {
      return handleTickets(request, env, cors, ticketMatch[2] ?? null);
    }

    // Only the two route prefixes above are served here. /api/live stays on
    // the racing Worker; everything else is 404 (no collision with racing origin).
    return json({ error: "not_found" }, 404, cors);
  },
};

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
  let ageVerified: number | null = null;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { age_verified?: unknown };
      if (typeof body.age_verified === "number") {
        ageVerified = body.age_verified;
      }
    } catch {
      // Empty / non-JSON body is fine — treat as upsert-only.
    }
  }
  const row = await upsertUser(env.DB, verified.sub, ageVerified);
  if (!row) {
    return json({ error: "server_error" }, 500, cors);
  }
  return json(row, 200, cors);
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
  const user = await upsertUser(env.DB, verified.sub, null);
  if (!user) {
    return json({ error: "server_error" }, 500, cors);
  }
  const userId = user.id;

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
