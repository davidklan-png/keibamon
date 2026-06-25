// Form service route dispatcher — wires the three /api/.../form routes into
// the racing Worker (src/worker.js). Returns a Response if the path matched,
// or null so the caller falls through to existing behavior.
//
// Routes (parity with backend/keibamon_api/main.py):
//   GET /api/horses/:name/form?as_of=
//   GET /api/jockeys/:id/form?as_of=
//   GET /api/races/:race_id/form?as_of=
//
// Body shape + field names are byte-for-byte with the FastAPI contracts; the
// parity suite (parity.test.ts / queries.test.ts / routes.test.ts) pins this.

import { parseAsOf, formatUtcIso } from "./asOf";
import {
  buildHorseCard,
  buildJockeyCard,
  type FormStartRow,
} from "./cardBuilder";
import { normalizeName } from "./normalize";
import {
  HORSE_FORM_SQL,
  JOCKEY_FORM_SQL,
  RACE_RUNNERS_FROM_STARTS_SQL,
} from "./queries";

export interface FormEnv {
  FORM: D1Database; // keibamon_form
  DB: D1Database; // keibamon-live (live_snapshot, for race post_time + runners)
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export async function handleFormRoutes(
  request: Request,
  env: FormEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const asOfRaw = url.searchParams.get("as_of");

  // /api/horses/:name/form
  let m = path.match(/^\/api\/horses\/([^/]+)\/form$/);
  if (m) {
    const name = decodeURIComponent(m[1]);
    const key = normalizeName(name);
    if (!key) {
      return jsonResponse({ status: "no_history", horse_name: name, as_of: asOfRaw });
    }
    const asOf = formatUtcIso(parseAsOf(asOfRaw));
    const { results } = await env.FORM.prepare(HORSE_FORM_SQL).bind(key, asOf).all();
    const rows = (results ?? []) as unknown as FormStartRow[];
    return jsonResponse(buildHorseCard(rows, name, asOfRaw));
  }

  // /api/jockeys/:id/form
  m = path.match(/^\/api\/jockeys\/([^/]+)\/form$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const asOf = formatUtcIso(parseAsOf(asOfRaw));
    const { results } = await env.FORM.prepare(JOCKEY_FORM_SQL).bind(id, asOf).all();
    const rows = (results ?? []) as unknown as FormStartRow[];
    return jsonResponse(buildJockeyCard(rows, id, asOfRaw));
  }

  // /api/races/:race_id/form
  m = path.match(/^\/api\/races\/([^/]+)\/form$/);
  if (m) {
    const raceId = decodeURIComponent(m[1]);
    return handleRaceForm(raceId, asOfRaw, env);
  }

  return null;
}

async function handleRaceForm(
  raceId: string,
  asOfRaw: string | null,
  env: FormEnv,
): Promise<Response> {
  // PIT anchor: explicit as_of overrides everything. Otherwise the race's own
  // post_time (so each runner's card excludes this race). Fallback: now UTC.
  let asOfInstant: Date;
  if (asOfRaw === null) {
    const postInstant = await findRacePostInstant(raceId, env);
    asOfInstant = postInstant ?? new Date();
  } else {
    asOfInstant = parseAsOf(asOfRaw);
  }
  const asOf = formatUtcIso(asOfInstant);

  // Runner list: try the live snapshot first (works for upcoming races). Fall
  // back to historical form_starts (works for past races where every runner
  // has completed starts).
  let runners: { horse_number: number; horse_name: string | null }[] =
    await readRunnersFromLiveSnapshot(raceId, env);
  if (runners.length === 0) {
    const { results } = await env.FORM
      .prepare(RACE_RUNNERS_FROM_STARTS_SQL)
      .bind(raceId)
      .all();
    runners = (results ?? [])
      .map((r) => r as Record<string, unknown>)
      .map((r) => ({
        horse_number: 0,
        horse_name: (r.horse_name as string | null) ?? null,
      }));
    if (runners.length === 0) {
      // Unknown race → 404 (matches Python HTTPException(404)).
      return jsonResponse({ error: `Race not found: ${raceId}` }, 404);
    }
  }

  // For each runner, fetch their horse form (PIT-filtered to asOf) and build
  // a card. Mirror Python's response shape: race_id + as_of (raw) + runners[].
  const cards: { horse_number: number; horse_name: string | null; form: unknown }[] = [];
  for (const rn of runners) {
    const key = normalizeName(rn.horse_name);
    const rows: FormStartRow[] = key
      ? ((await env.FORM.prepare(HORSE_FORM_SQL).bind(key, asOf).all()).results ?? []) as unknown as FormStartRow[]
      : [];
    cards.push({
      horse_number: rn.horse_number,
      horse_name: rn.horse_name,
      form: buildHorseCard(rows, rn.horse_name, asOfRaw),
    });
  }

  return jsonResponse({ race_id: raceId, as_of: asOfRaw, runners: cards });
}

// Read the race's post_time from the live snapshot. Returns null if the race
// isn't found, the payload is malformed, or the date can't be parsed.
async function findRacePostInstant(raceId: string, env: FormEnv): Promise<Date | null> {
  const payload = await readLiveSnapshot(env);
  if (!payload) return null;
  const race = (payload?.races ?? []).find(
    (r: { race_id?: string }) => r?.race_id === raceId,
  );
  if (!race) return null;
  return postInstantFromRace(raceId, race);
}

// Extract the UTC instant for a race's post_time. race_id format is
// "jra-YYYYMMDD-VV-NN"; post_time is a JST "HH:MM" string.
function postInstantFromRace(
  raceId: string,
  race: { post_time?: string },
): Date | null {
  if (!race.post_time) return null;
  const dateMatch = raceId.match(/^jra-(\d{8})-/);
  if (!dateMatch) return null;
  const y = +dateMatch[1].slice(0, 4);
  const mo = +dateMatch[1].slice(4, 6);
  const d = +dateMatch[1].slice(6, 8);
  const timeMatch = race.post_time.match(/^(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  // JST post_time → UTC: subtract 9 hours.
  const utcMs =
    Date.UTC(y, mo - 1, d, +timeMatch[1], +timeMatch[2]) - 9 * 60 * 60 * 1000;
  return new Date(utcMs);
}

async function readRunnersFromLiveSnapshot(
  raceId: string,
  env: FormEnv,
): Promise<{ horse_number: number; horse_name: string | null }[]> {
  const payload = await readLiveSnapshot(env);
  if (!payload) return [];
  const race = (payload?.races ?? []).find(
    (r: { race_id?: string }) => r?.race_id === raceId,
  );
  if (!race) return [];
  const runners = (race?.runners ?? []) as Array<{
    umaban?: number;
    name?: string;
  }>;
  return runners.map((r) => ({
    horse_number: r.umaban ?? 0,
    horse_name: r.name ?? null,
  }));
}

async function readLiveSnapshot(
  env: FormEnv,
): Promise<{ races?: Array<{ race_id?: string; post_time?: string; runners?: unknown[] }> } | null> {
  // The publisher publishes under key='current' (ADR-0006); legacy single-card
  // fallback is 'hanshin'. Try both before giving up.
  for (const key of ["current", "hanshin"]) {
    const row = await env.DB.prepare("SELECT payload FROM live_snapshot WHERE key = ?")
      .bind(key)
      .first();
    if (row && row.payload) {
      try {
        return JSON.parse(row.payload as string);
      } catch {
        /* try next key */
      }
    }
  }
  return null;
}
