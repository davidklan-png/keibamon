// Weekly graded-stakes report — worker-side read path.
//
// Route:
//   GET /api/weekly-report
//
// Reads versioned WeekendInput editions from the keibamon-live D1 table
// `weekly_report(edition_key, version, payload, published_at)`. Each row's
// payload is a serialized WeekendInput (the frontend generates the report
// deterministically). Returns the latest edition first.
//
// If the table doesn't exist yet (migration not applied) or holds no rows,
// returns { status: "empty" } so the frontend renders the no-data empty state
// (cadence message + real upcoming graded stakes from /api/live) instead of
// fabricated sample races. No edition is published until an operator runs the
// publish step (documented in docs/prompts/weekly-roundup.md).
//
// Publish is a manual step (wrangler d1 execute INSERT of the WeekendInput
// JSON), NOT an open POST endpoint — there is no admin-auth surface in this
// worker, so write access stays with the operator who runs wrangler.

export interface WeeklyReportEnv {
  DB: D1Database; // keibamon-live
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

const SELECT_EDITIONS = `
  SELECT edition_key, version, payload, published_at
  FROM weekly_report
  ORDER BY edition_key DESC, version DESC
`;

export async function handleWeeklyReportRoutes(
  request: Request,
  env: WeeklyReportEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/weekly-report") return null;
  if (request.method !== "GET") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  // No D1 binding → empty path (local dev / a deploy without the binding).
  if (!env || !env.DB) {
    return jsonResponse({ status: "empty" });
  }

  try {
    const { results } = await env.DB.prepare(SELECT_EDITIONS).all();
    const rows = (results ?? []) as Array<{
      edition_key: string;
      version: number;
      payload: string;
      published_at: string;
    }>;
    if (rows.length === 0) {
      return jsonResponse({ status: "empty" });
    }
    // SELECT_EDITIONS is ordered edition_key DESC, so rows[0] is the latest
    // edition. Limit to that one edition (all its versions) instead of
    // streaming the full history of past editions — the surface renders only
    // the current edition, and this bounds the payload.
    const latestEdition = rows[0].edition_key;
    const latest = rows.filter((r) => r.edition_key === latestEdition);
    // Parse each payload; skip any row that doesn't deserialize so one bad
    // row can't blank the whole surface.
    const inputs: unknown[] = [];
    for (const r of latest) {
      try {
        inputs.push(JSON.parse(r.payload));
      } catch {
        /* skip malformed row */
      }
    }
    if (inputs.length === 0) return jsonResponse({ status: "empty" });
    return jsonResponse({ status: "published", inputs });
  } catch {
    // Table not migrated, or transient D1 error → degrade to empty.
    return jsonResponse({ status: "empty" });
  }
}
