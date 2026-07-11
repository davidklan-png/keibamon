// Phase 2 — ticket persistence. Split out of index.ts 2026-07-08 (mechanical,
// no behavior change).
//
// POST body shape (a frontend CommittedTicket; payload is opaque to us):
//   {
//     id: "kb-...", serial: "KB-XXXXXX", state: "open", payoutBase: N,
//     ticket: {...}, race: {...}, mood, unit, createdAt: epoch_ms, ...
//   }
// The body's `id` is the PRIMARY KEY; we don't regenerate it. The race_key
// column is extracted from `race.raceKey` so we can scan by race later if
// settlement is ever moved server-side (today: client-side PATCH).

import { TICKET_STATES, TicketRow } from "./core";

/**
 * Mirror of frontend/src/lib/fairvalue.ts `BetType`. NOTE: win/place are NOT
 * committable bet types in this codebase (confirmed against the resolver in
 * fairvalue.ts and the manual builder — the recommender/manual paths produce
 * only these six exotic types). The original audit brief listed win/place too;
 * they are intentionally absent here so a phantom type can't be stored.
 */
export const TICKET_TYPES = new Set([
  "quinella",
  "wide",
  "exacta",
  "trio",
  "trifecta",
  "bracket_quinella",
]);

/** Mirror of frontend TicketStructure (ADR-0011). */
export const TICKET_STRUCTURES = new Set(["single", "box", "wheel", "formation"]);

// Sanity bounds — generous enough to admit any ticket the UI can build, tight
// enough to reject abuse. A full-field trifecta FORMATION expands to 18P3 =
// 4896 priced lines (~390KB), which sets the floor for MAX_LINES and the byte
// cap; D1 rows are practically capped near 1MB. (The audit's suggested ~16KB
// cap would reject legitimate large boxes/formations — flagged for review.)
const MAX_PAYLOAD_BYTES = 1_000_000;
const MAX_LINES = 5_000;
const MAX_UNIT = 1_000_000; // yen per line
const MAX_UMABAN = 18; // JRA max field size
const MAX_RACE_NO = 12; // JRA max races per venue per day

// UTF-8 byte length. A JS string's `.length` counts UTF-16 code units, NOT
// bytes — a payload of CJK chars (3 bytes/codepoint in UTF-8) can be ~3×
// larger in UTF-8 than `.length` claims. D1 stores UTF-8, so the byte cap must
// measure UTF-8 or a multibyte payload sails past it. TextEncoder is global in
// the Workers runtime (and Node ≥11); one reused instance.
const _utf8Encoder = new TextEncoder();
function utf8ByteLength(s: string): number {
  return _utf8Encoder.encode(s).length;
}

interface TicketLineBody {
  combo?: unknown;
}
interface TicketBody {
  type?: unknown;
  lines?: unknown;
  cost?: unknown;
  structure?: unknown;
}

interface CommittedTicketBody {
  id?: unknown;
  serial?: unknown;
  state?: unknown;
  payoutBase?: unknown;
  unit?: unknown;
  createdAt?: unknown;
  race?: { raceKey?: unknown } | null;
  ticket?: TicketBody | null;
  // The rest is opaque recommender output + race snapshot.
  [k: string]: unknown;
}

export interface PatchBody {
  state?: unknown;
  returned?: unknown;
  /** `{pos, umabans}[]`, top-N finish (see topPlacings in settle.ts). */
  placings?: unknown;
}

/** Loose runtime check — good enough to reject garbage without importing a schema lib. */
function isValidPlacings(v: unknown): v is { pos: number; umabans: number[] }[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (p) =>
      p &&
      typeof p === "object" &&
      typeof (p as { pos?: unknown }).pos === "number" &&
      Array.isArray((p as { umabans?: unknown }).umabans) &&
      (p as { umabans: unknown[] }).umabans.every((u) => typeof u === "number"),
  );
}

export interface ParsedTicketBody {
  id: string;
  serial: string;
  raceKey: string;
  payload: string;
  state: string;
  payoutBase: number;
  createdAt: number;
  /**
   * Stage 4 derived flat columns — payload stays authoritative; these mirror it
   * for queryable feeds/analytics. NULL where the payload didn't carry the field.
   */
  ticketType: string | null;
  lineCount: number | null;
  cost: number | null;
  unit: number | null;
  structure: string | null;
  venue: string | null;
  raceNo: number | null;
}

export function parseTicketBody(body: unknown): { ok: true; ticket: ParsedTicketBody } | { ok: false; code: string } {
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

  // Byte cap (abuse backstop), measured in UTF-8 bytes (not UTF-16 code units).
  // Computed after the cheap field checks so a garbage id doesn't pay for a
  // stringify.
  const payload = JSON.stringify(body);
  if (utf8ByteLength(payload) > MAX_PAYLOAD_BYTES) return { ok: false, code: "payload_too_large" };

  // ticket block: type allowlist + line bounds + per-line combo shape.
  const t = b.ticket;
  if (!t || typeof t !== "object") return { ok: false, code: "bad_ticket" };
  const tb = t as TicketBody;
  if (typeof tb.type !== "string" || !TICKET_TYPES.has(tb.type)) {
    return { ok: false, code: "bad_ticket_type" };
  }
  const lines = tb.lines;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > MAX_LINES) {
    return { ok: false, code: "bad_lines" };
  }
  for (const ln of lines) {
    const combo = (ln as TicketLineBody | null | undefined)?.combo;
    if (!Array.isArray(combo) || combo.length < 1 || combo.length > MAX_UMABAN) {
      return { ok: false, code: "bad_line_combo" };
    }
    for (const c of combo) {
      // umabans arrive as strings ("01".."18"); reject non-numeric / out-of-range.
      if (typeof c !== "string" || !/^\d{1,2}$/.test(c)) {
        return { ok: false, code: "bad_line_combo" };
      }
      const n = Number(c);
      if (!Number.isInteger(n) || n < 1 || n > MAX_UMABAN) {
        return { ok: false, code: "bad_line_combo" };
      }
    }
  }

  // unit (stake per line) — validated only when present. Must be an INTEGER
  // number of yen; a fractional unit is rejected (bad_unit), NOT silently
  // floored — flooring would let a client understate the derived cost
  // (200.5 → 200) and pass a matching forged ticket.cost.
  let unit: number | null = null;
  if (b.unit !== undefined && b.unit !== null) {
    if (
      typeof b.unit !== "number" ||
      !Number.isFinite(b.unit) ||
      !Number.isInteger(b.unit) ||
      b.unit < 1 ||
      b.unit > MAX_UNIT
    ) {
      return { ok: false, code: "bad_unit" };
    }
    unit = b.unit;
  }

  // structure (optional ADR-0011 classification).
  let structure: string | null = null;
  if (tb.structure !== undefined && tb.structure !== null) {
    if (typeof tb.structure !== "string" || !TICKET_STRUCTURES.has(tb.structure)) {
      return { ok: false, code: "bad_structure" };
    }
    structure = tb.structure;
  }

  // cost is DERIVED server-side from validated unit × line_count — NEVER
  // trusted from the payload. If the payload supplies ticket.cost, it must be
  // finite, integral, non-negative, and EXACTLY equal to the derived cost. A
  // supplied cost with NO unit is rejected (bad_cost): the equality can't be
  // checked and cost must be derivable — persisting NULL would not meet
  // "supplied cost must equal server-derived unit × line_count." Any mismatch
  // → bad_cost.
  const derivedCost = unit !== null ? unit * lines.length : null;
  if (tb.cost !== undefined && tb.cost !== null) {
    const clientCost = tb.cost;
    if (
      typeof clientCost !== "number" ||
      !Number.isFinite(clientCost) ||
      !Number.isInteger(clientCost) ||
      clientCost < 0
    ) {
      return { ok: false, code: "bad_cost" };
    }
    if (derivedCost === null) {
      return { ok: false, code: "bad_cost" };
    }
    if (clientCost !== derivedCost) {
      return { ok: false, code: "bad_cost" };
    }
  }
  const cost = derivedCost;

  // venue + race_no from raceKey "<date>|<venue>|<raceNo>|<name>".
  const parts = raceKey.split("|");
  const venue = parts.length > 1 && parts[1] ? parts[1] : null;
  let raceNo: number | null = null;
  if (parts.length > 2 && /^\d{1,2}$/.test(parts[2])) {
    const rn = Number(parts[2]);
    if (Number.isInteger(rn) && rn >= 1 && rn <= MAX_RACE_NO) raceNo = rn;
  }

  return {
    ok: true,
    ticket: {
      id: b.id,
      serial: b.serial,
      state: b.state,
      payoutBase: b.payoutBase,
      createdAt: b.createdAt,
      raceKey,
      payload,
      ticketType: tb.type,
      lineCount: lines.length,
      cost,
      unit,
      structure,
      venue,
      raceNo,
    },
  };
}

type InsertTicketResult =
  | { ok: true; row: TicketRow }
  | { ok: false; code: "cannot_edit_settled_ticket" }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "server_error" };

/**
 * Insert-or-update by id. Used both for fresh ticket creation AND for
 * manual-ticket-builder edit-in-place.
 *
 * The preliminary SELECT below is for user-facing classification only — the
 * common "different owner" / "already settled" cases short-circuit before
 * paying for an upsert. The MUTATION is authoritative: the
 * `ON CONFLICT(id) DO UPDATE` carries
 *   `WHERE tickets.user_id = excluded.user_id AND tickets.state = 'open'`,
 * so a row that appears BETWEEN the SELECT and the upsert (the TOCTOU window —
 * e.g. a concurrent first-write of the same id by another user) CANNOT be
 * overwritten: the conditional update matches no row and RETURNING yields
 * nothing. On that no-row result we re-read and classify safely:
 *
 *   - different owner  → {ok:false, code:"not_found"} — the anti-oracle 404,
 *     indistinguishable from "doesn't exist" so the endpoint can't be probed
 *     for which ids are taken (defense-in-depth on the high-entropy client ids).
 *   - same owner, non-open → {ok:false, code:"cannot_edit_settled_ticket"} —
 *     the row settled in the window; refuse to wipe state/returned.
 *   - no row at all (unreachable: an empty RETURNING implies a conflict
 *     existed) → {ok:false, code:"server_error"}.
 *
 * Legitimate fresh creates and same-owner open-ticket edits return the row.
 */
export async function insertTicket(
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
    // Stage 4 derived flat columns (parsed by parseTicketBody).
    ticketType: string | null;
    lineCount: number | null;
    cost: number | null;
    unit: number | null;
    structure: string | null;
    venue: string | null;
    raceNo: number | null;
  },
): Promise<InsertTicketResult> {
  // Preliminary read — classification only; NOT the authority.
  const existing = await db
    .prepare("SELECT state, user_id FROM tickets WHERE id = ?")
    .bind(parsed.id)
    .first<{ state: string; user_id: string }>();
  if (existing) {
    if (existing.user_id !== userId) {
      return { ok: false, code: "not_found" };
    }
    if (existing.state !== "open") {
      return { ok: false, code: "cannot_edit_settled_ticket" };
    }
  }

  // Authoritative mutation: the conditional WHERE closes the TOCTOU window.
  // RETURNING yields the row on a fresh insert OR a same-owner-open update;
  // yields nothing when a conflicting row fails the WHERE.
  const row = await db
    .prepare(
      `INSERT INTO tickets (id, user_id, serial, race_key, payload, state, payout_base, returned, created_at,
                            ticket_type, line_count, cost, unit, structure, venue, race_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload = excluded.payload,
         state = excluded.state,
         payout_base = excluded.payout_base,
         returned = NULL,
         ticket_type = excluded.ticket_type,
         line_count = excluded.line_count,
         cost = excluded.cost,
         unit = excluded.unit,
         structure = excluded.structure,
         venue = excluded.venue,
         race_no = excluded.race_no
       WHERE tickets.user_id = excluded.user_id AND tickets.state = 'open'
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
      parsed.ticketType,
      parsed.lineCount,
      parsed.cost,
      parsed.unit,
      parsed.structure,
      parsed.venue,
      parsed.raceNo,
    )
    .first<TicketRow>();

  if (row) return { ok: true, row };

  // No row returned → a conflicting row exists that failed the WHERE (it
  // appeared between the preliminary SELECT and this upsert, or settled in
  // that window). Re-read to classify authoritatively.
  const conflicting = await db
    .prepare("SELECT state, user_id FROM tickets WHERE id = ?")
    .bind(parsed.id)
    .first<{ state: string; user_id: string }>();
  if (!conflicting) {
    // Unreachable in practice: an empty RETURNING means a conflict was hit,
    // yet no row is present now. Surface as a server error rather than guess.
    return { ok: false, code: "server_error" };
  }
  if (conflicting.user_id !== userId) {
    return { ok: false, code: "not_found" };
  }
  return { ok: false, code: "cannot_edit_settled_ticket" };
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
export function decodeTicket(
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
  // R5: overlay the settled result breakdown, same pattern as state/returned
  // (the flat column is authoritative; the payload snapshot is commit-time
  // and never carries this). NULL until a settle path writes it, or on
  // tickets settled before this column existed.
  if (row.placings) {
    try {
      body.placings = JSON.parse(row.placings);
    } catch {
      body.placings = undefined;
    }
  } else {
    delete body.placings;
  }
  // Friend Interactions Phase 3: claps + cheers + cheeredByMe are legacy
  // (claps never used; cheers replaced by share-scoped congratulate). Strip
  // them so the client never renders a stale value.
  delete body.claps;
  delete body.cheers;
  delete body.cheeredByMe;
  if (social?.owner !== undefined) {
    body.owner = social.owner;
  }
  return body;
}

export async function listTickets(db: D1Database, userId: string): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, serial, race_key, payload, state, payout_base, returned, created_at, placings
         FROM tickets
        WHERE user_id = ? AND state <> 'deleted'
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

export async function findTicket(db: D1Database, id: string): Promise<TicketRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, serial, race_key, payload, state, payout_base, returned, created_at, placings
         FROM tickets
        WHERE id = ?`,
    )
    .bind(id)
    .first<TicketRow>();
}

/**
 * Owner-checked SOFT delete. The row is kept (state = 'deleted') and excluded
 * from listTickets, NOT hard-deleted — the `shares→tickets` FOREIGN KEY
 * (migration 0012, ON DELETE NO ACTION) would otherwise reject a delete while a
 * share row references the ticket, and a hard cascade through shares → comments
 * → congrats → share_audience is out of scope. Keeping the row also means a
 * notification whose subject is this ticket degrades gracefully (the row still
 * exists) rather than pointing at nothing. No new column / migration: `state`
 * has no CHECK constraint (0010 deliberately omitted one), so 'deleted' is a
 * safe sentinel. The route retracts the ticket's active share as a cascade so
 * the ticket vanishes from friends' feeds.
 *
 * Returns 404 (missing), 403 (not owner), or 200.
 */
export async function deleteTicket(
  db: D1Database,
  id: string,
  userId: string,
): Promise<{ status: 200 } | { status: 404 } | { status: 403 }> {
  const row = await findTicket(db, id);
  if (!row) return { status: 404 };
  if (row.user_id !== userId) return { status: 403 };
  await db
    .prepare(`UPDATE tickets SET state = ? WHERE id = ? AND user_id = ?`)
    .bind("deleted", id, userId)
    .run();
  return { status: 200 };
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
export async function patchTicket(
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
  // R5: result breakdown, written by the client's auto-settle path. Garbage
  // (wrong shape) is silently ignored rather than rejecting the whole PATCH —
  // state/returned are the load-bearing fields; placings is a display extra.
  let newPlacings = row.placings;
  if (isValidPlacings(patch.placings)) {
    newPlacings = JSON.stringify(patch.placings);
  }

  // Phase 3: strip any cached claps on write too, so the next read stays clean.
  delete body.claps;

  const newPayload = JSON.stringify(body);
  await db
    .prepare(
      `UPDATE tickets
          SET state = ?, returned = ?, payload = ?, placings = ?
        WHERE id = ? AND user_id = ?`,
    )
    .bind(newState, newReturned, newPayload, newPlacings, id, userId)
    .run();

  const decoded = decodeTicket({
    ...row,
    state: newState,
    returned: newReturned,
    payload: newPayload,
    placings: newPlacings,
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
