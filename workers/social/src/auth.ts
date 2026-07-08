// Identity: Clerk JWT verification (jose + JWKS) and the users-table upsert.
// Split out of index.ts 2026-07-08 (mechanical, no behavior change).
//
// Auth: Clerk JWT in `Authorization: Bearer <jwt>`, verified with jose against
// Clerk's JWKS. Missing/invalid → null (callers 401). Profile upsert is by
// clerk_user_id (INSERT ... ON CONFLICT).

import { jwtVerify, createRemoteJWKSet } from "jose";
import { Env, NOW, UserRow, json } from "./core";

const TOKEN_RE = /^Bearer\s+(.+)$/i;

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

export async function verifyToken(
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
export async function upsertUser(
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

/**
 * Phase 3 social handlers call this on every request to guarantee the caller
 * has a user row (the FK on follows/cheers/rate_limits requires it). Returns
 * the row on success; on failure, emits the right HTTP error and returns null
 * so the caller can early-exit.
 */
export async function ensureCaller(
  env: Env,
  cors: Record<string, string>,
  clerkSub: string,
): Promise<{ user: UserRow } | { res: Response }> {
  const result = await upsertUser(env.DB, clerkSub, {});
  if (result.ok) return { user: result.row };
  // handle_taken can't happen here (empty patch); surface as 500 regardless.
  return { res: json({ error: "server_error" }, 500, cors) };
}
