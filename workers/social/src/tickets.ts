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

  // Byte cap (abuse backstop). Computed after the cheap field checks so a
  // garbage id doesn't pay for a stringify.
  const payload = JSON.stringify(body);
  if (payload.length > MAX_PAYLOAD_BYTES) return { ok: false, code: "payload_too_large" };

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

  // unit (stake per line) — validated only when present.
  let unit: number | null = null;
  if (b.unit !== undefined && b.unit !== null) {
    if (typeof b.unit !== "number" || !Number.isFinite(b.unit) || b.unit < 1 || b.unit > MAX_UNIT) {
      return { ok: false, code: "bad_unit" };
    }
    unit = Math.floor(b.unit);
  }

  // structure (optional ADR-0011 classification).
  let structure: string | null = null;
  if (tb.structure !== undefined && tb.structure !== null) {
    if (typeof tb.structure !== "string" || !TICKET_STRUCTURES.has(tb.structure)) {
      return { ok: false, code: "bad_structure" };
    }
    structure = tb.structure;
  }

  // cost: prefer the payload's own cost when it's a sane positive number;
  // otherwise derive unit × line_count. Capped at unit_max × max_lines.
  const costRaw = tb.cost;
  let cost: number | null = null;
  if (
    typeof costRaw === "number" &&
    Number.isFinite(costRaw) &&
    costRaw >= 0 &&
    costRaw <= MAX_UNIT * MAX_LINES
  ) {
    cost = Math.floor(costRaw);
  } else if (unit !== null) {
    cost = unit * lines.length;
  }

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
  | { ok: true; row: TicketRow | null }
  | { ok: false; code: "cannot_edit_settled_ticket" }
  | { ok: false; code: "not_found" };

/**
 * Insert-or-update by id. Used both for fresh ticket creation AND for
 * manual-ticket-builder edit-in-place: a POST with the SAME id overwrites
 * the row in place (the `ON CONFLICT(id) DO UPDATE` below).
 *
 * Two guards run BEFORE the upsert (the lookup is a separate statement rather
 * than a CTE because D1's `ON CONFLICT DO UPDATE` cannot itself be conditional
 * on the existing row in D1's SQLite version):
 *
 *   1. Ownership: if an existing row for this id belongs to ANOTHER user,
 *      reject with `{ok:false, code:"not_found"}`. We deliberately return the
 *      SAME shape as "doesn't exist" rather than a distinct "forbidden" so
 *      this endpoint is not an oracle for probing which ids are taken
 *      (defense-in-depth on top of the high-entropy client ids — coverage for
 *      the case where a client id ever leaks). The `ON CONFLICT` update does
 *      NOT touch `user_id`, so without this check a guessed open id would let
 *      another user overwrite the payload while the row stayed attributed to
 *      the victim — a silent hijack. Legit clients only ever POST ids they
 *      generated themselves, so this branch is attacker-only.
 *   2. Settlement: if an existing row for this id is in a settled state
 *      (anything other than 'open'), reject with
 *      `{ok:false, code:"cannot_edit_settled_ticket"}` — otherwise a manual
 *      edit would silently reset `state` to 'open' and NULL out `returned`,
 *      erasing settlement history.
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
  return { ok: true, row };
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

export async function listTickets(db: D1Database, userId: string): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, serial, race_key, payload, state, payout_base, returned, created_at, placings
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
