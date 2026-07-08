// ADR-0018: account-backed impression marks — data layer. Split out of
// index.ts 2026-07-08 (mechanical, no behavior change). The HTTP handler
// lives in routes.ts.
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

const ALLOWED_MARKS = new Set(["like", "distrust", "priceHorse", "avoid", "anchor"]);

export interface ImpressionRow {
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
export function parseImpressionsBody(
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

export async function listImpressions(
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
export async function replaceImpressions(
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
