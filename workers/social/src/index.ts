// ADR-0007 Phase 1 — keibamon-social Worker.
//
// Owns identity + age self-attestation. ISOLATED from the racing Worker:
//   - separate D1 (keibamon_social) — NEVER references keibamon-live
//   - separate origin (Phase 1: *.workers.dev subdomain; custom domain later)
//   - the only route is /api/social/me (GET + POST). /api/live stays on the
//     racing Worker; this Worker returns 404 for everything else.
//
// Auth: Clerk JWT in `Authorization: Bearer <jwt>`, verified with jose against
// Clerk's JWKS. Missing/invalid → 401. CORS is handled here (racing Worker
// untouched). Profile upsert is by clerk_user_id (INSERT ... ON CONFLICT).

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

const TOKEN_RE = /^Bearer\s+(.+)$/i;
const NOW = () => Math.floor(Date.now() / 1000);

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    // Only route we serve. /api/live stays on the racing Worker; everything
    // else here is 404 (no collision with the racing origin).
    if (url.pathname !== "/api/social/me") {
      return json({ error: "not_found" }, 404, cors);
    }
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
  },
};
