// Shared bindings, row types, constants, and HTTP helpers for the
// keibamon-social Worker. Split out of index.ts 2026-07-08 (mechanical module
// split, no behavior change — see docs/codebase-review-2026-07-08.md #5).
// Module map: core (this file) ← auth ← tickets/social/impressions ← routes
// ← index (entry). settle.ts / sweep.ts predate the split and are unchanged.

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

export interface UserRow {
  id: string;
  clerk_user_id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
  age_verified: number;
  created_at: number;
}

/** Flat row kept in D1; payload is the verbatim CommittedTicket JSON. */
export interface TicketRow {
  id: string;
  user_id: string;
  serial: string;
  race_key: string;
  payload: string;
  state: string;
  payout_base: number;
  returned: number | null;
  created_at: number;
  /** JSON `{pos, umabans}[]` (top-N finish, dead-heat aware); NULL until settled. */
  placings: string | null;
  /**
   * Stage 4 (0010) derived flat columns — payload stays authoritative; these
   * mirror it so feeds/analytics can filter/sort without parsing JSON. NULL
   * where the payload didn't carry the field (or pre-0010 rows not backfilled).
   * Not yet SELECTed by the read paths — write-only until feeds migrate.
   */
  ticket_type?: string | null;
  line_count?: number | null;
  cost?: number | null;
  unit?: number | null;
  structure?: string | null;
  venue?: string | null;
  race_no?: number | null;
}

/** A ticket row joined with its owner, for the profile ticket list. (Friend
 *  Interactions Phase 3: the legacy cheer aggregate fields were removed with
 *  the cheer system; congratulate is share-scoped, not ticket-scoped.) */
export interface TicketWithSocial extends TicketRow {
  owner_handle: string | null;
  owner_display_name: string | null;
  owner_avatar: string | null;
}

export const NOW = () => Math.floor(Date.now() / 1000);

/** Allowed state values on insert/update. Keep in sync with frontend CommittedState. */
export const TICKET_STATES = new Set(["open", "won", "miss", "refunded"]);

/** Rate-limit ceilings per action per minute. Decision 8. */
export const RATE_LIMITS: Record<string, number> = {
  ticket: 20,
  // Phase 4: block + report abuse guards. Block is generous (users curating
  // their feed shouldn't hit it); report is tight (the moderation queue
  // shouldn't be spammed).
  block: 30,
  report: 10,
  // Friend Interactions Phase 1. Friend requests are the abuse/poke-spam
  // surface, so capped at the same generous-but-finite band as follow/block.
  // Search is read-heavy (typeahead), so generous.
  friend_request: 30,
  search: 60,
  // Phase 2: sharing fans out one notification per recipient, so cap it like
  // the other fan-out actions.
  share: 30,
  // Phase 3: comments + congratulate. Comments notify (owner + prior
  // commenters), so capped; congratulate is a one-tap reaction (high freq, no
  // fan-out to a list), so generous.
  comment: 60,
  congratulate: 120,
};
export const RATE_WINDOW = 60; // seconds

// ---- Friend Interactions Phase 2: share audience modes + row type.
export const AUDIENCE_MODES = new Set(["all_friends", "selected"] as const);

// ---- Friend Interactions: social_edges enums (mirror 0011 CHECK constraints).
// Keeping the allowed values in one place lets the data layer + routes validate
// without re-stating the literals; the migration's CHECK is the backstop.
export const EDGE_TYPES = new Set(["friend", "follow"] as const);
export const EDGE_STATES = new Set(["pending", "accepted", "declined"] as const);

/** One directed row in social_edges (see migrations/0011). */
export interface SocialEdgeRow {
  source_id: string;
  target_id: string;
  type: string;
  state: string;
  created_at: number;
  decided_at: number | null;
}

// ---- Notifications: type + subject enum (mirror 0011 CHECK constraints).
export const NOTIF_TYPES = new Set([
  "friend_request_received",
  "friend_request_accepted",
  "ticket_shared_with_you",
  "comment_on_your_ticket",
  "comment_on_ticket_you_commented",
  "congratulation_received",
  "friends_ticket_won",
] as const);
export const NOTIF_SUBJECT_TYPES = new Set([
  "user",
  "ticket",
  "share",
  "comment",
  "friend_request",
] as const);

/** One row in notifications (see migrations/0011). read_at NULL = unread. */
export interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  created_at: number;
  read_at: number | null;
}

/** One row in shares (see migrations/0012). retracted_at NULL = live. */
export interface ShareRow {
  id: string;
  ticket_id: string;
  owner_id: string;
  audience_mode: string;
  snapshot: string;
  is_win: number;
  retracted_at: number | null;
  created_at: number;
}

export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function corsHeaders(env: Env, origin: string | null): Record<string, string> {
  const allow = origin && allowedOrigins(env).includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(body: unknown, status: number, cors: Record<string, string>, extraHeaders: Record<string, string> = {}): Response {
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
