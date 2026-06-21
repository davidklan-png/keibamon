// ADR-0007 — thin client for the social Worker.
//
// Phase 1: /api/social/me (profile upsert + age self-attestation).
// Phase 2: /api/social/tickets (CRUD). The server is the source of truth
// for committed tickets; localStorage mirrors the GET response so the feed
// renders instantly on next load (read-through cache).
//
// Offline-first: every call rejects to a typed failure so callers can queue
// or fall back. The My Tickets UI must not block on the social backend being
// up — a failed commit is held in a localStorage retry queue (see App.tsx
// `commit`) and flushed on the next signed-in load.

import type { CommittedTicket } from "../lib/types";

/** Base URL of the social Worker, no trailing slash. Empty → same-origin. */
export function base(): string {
  const v = (import.meta.env.VITE_SOCIAL_API_BASE as string | undefined) ?? "";
  // Tolerate a stray trailing slash so builds don't silently break.
  return v.endsWith("/") ? v.slice(0, -1) : v;
}

export interface SocialProfile {
  id: string;
  clerk_user_id: string;
  handle?: string | null;
  display_name?: string | null;
  avatar?: string | null;
  age_verified: number;
  created_at: number;
}

/** Fetch failure tagged so callers can distinguish offline from auth. */
export type SocialError =
  | { kind: "no_token" }
  | { kind: "network" }
  | { kind: "http"; status: number };

async function authedFetch(
  token: string | null,
  path: string,
  init: RequestInit,
): Promise<{ ok: true; res: Response } | { ok: false; err: SocialError }> {
  if (!token) return { ok: false, err: { kind: "no_token" } };
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
      cache: "no-store",
    });
    return { ok: true, res };
  } catch {
    return { ok: false, err: { kind: "network" } };
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * POST /api/social/me with the Clerk JWT. Body optional (e.g. {age_verified:1}).
 * Resolves to null on any failure — callers MUST tolerate null.
 *
 * (Phase 1 surface — kept here alongside the Phase 2 ticket calls.)
 */
export async function postMe(
  token: string | null,
  body?: { age_verified?: number },
): Promise<SocialProfile | null> {
  if (!token) return null;
  const r = await authedFetch(token, "/api/social/me", {
    method: "POST",
    body: body ? JSON.stringify(body) : "{}",
  });
  if (!r.ok || !r.res.ok) return null;
  return (await r.res.json()) as SocialProfile;
}

/**
 * GET /api/social/tickets — the caller's committed-ticket feed (newest first).
 * Resolves to null on any failure so the caller can fall back to the cache.
 */
export async function listTickets(
  token: string | null,
): Promise<
  | { ok: true; tickets: CommittedTicket[] }
  | { ok: false; err: SocialError }
> {
  const r = await authedFetch(token, "/api/social/tickets", { method: "GET" });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const body = (await readJson(r.res)) as { tickets?: CommittedTicket[] } | null;
  const tickets = body?.tickets;
  if (!Array.isArray(tickets)) {
    return { ok: false, err: { kind: "http", status: 200 } };
  }
  return { ok: true, tickets };
}

/**
 * POST /api/social/tickets — commit a ticket (insert). On 409/id-collision
 * the Worker upserts; callers treat the returned ticket as canonical.
 */
export async function postTicket(
  token: string | null,
  body: CommittedTicket,
): Promise<
  | { ok: true; ticket: CommittedTicket }
  | { ok: false; err: SocialError }
> {
  const r = await authedFetch(token, "/api/social/tickets", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const ticket = (await readJson(r.res)) as CommittedTicket | null;
  if (!ticket) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, ticket };
}

/**
 * PATCH /api/social/tickets/:id — settle (state + returned) and/or claps.
 * Only the owner may PATCH; the Worker returns 403 otherwise (caller drops).
 */
export async function patchTicket(
  token: string | null,
  id: string,
  patch: { state?: "won" | "miss" | "open"; returned?: number | null; claps?: number },
): Promise<
  | { ok: true; ticket: CommittedTicket }
  | { ok: false; err: SocialError }
> {
  const r = await authedFetch(token, `/api/social/tickets/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!r.ok) return { ok: false, err: r.err };
  if (!r.res.ok) return { ok: false, err: { kind: "http", status: r.res.status } };
  const ticket = (await readJson(r.res)) as CommittedTicket | null;
  if (!ticket) return { ok: false, err: { kind: "http", status: 200 } };
  return { ok: true, ticket };
}
