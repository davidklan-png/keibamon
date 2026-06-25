// D1 SQL strings + row mapping for the form routes.
//
// The SQL is exported as constants so the parity suite (queries.test.ts) can
// execute the EXACT same strings against an in-process better-sqlite3 db
// seeded from the same fixture lake. D1 is API-compatible with sqlite.

import type { FormStartRow } from "./cardBuilder";

// --- PIT-filtered lookups. Every SELECT binds `available_at < ?` ------------
// Order: newest-first — the card builders slice `[:8]` / `[:10]` from the
// front, so the row order MUST be DESC by available_at to match the Python
// read path.

export const HORSE_FORM_SQL = `
  SELECT
    horse_name_key, horse_name, jockey_id, trainer_id, race_id, horse_number,
    available_at, race_date, racecourse, surface, distance_m, distance_band,
    going, going_wetness, is_wet, grade_label, field_size, finish_position,
    finish_time_seconds, margin, last_3f_seconds, last_3f_rank, win_odds,
    popularity, beat_market, style_signal
  FROM form_starts
  WHERE horse_name_key = ? AND available_at < ?
  ORDER BY available_at DESC
`;

export const JOCKEY_FORM_SQL = `
  SELECT
    horse_name_key, horse_name, jockey_id, trainer_id, race_id, horse_number,
    available_at, race_date, racecourse, surface, distance_m, distance_band,
    going, going_wetness, is_wet, grade_label, field_size, finish_position,
    finish_time_seconds, margin, last_3f_seconds, last_3f_rank, win_odds,
    popularity, beat_market, style_signal
  FROM form_starts
  WHERE jockey_id = ? AND available_at < ?
  ORDER BY available_at DESC
`;

// Used to find a known historical race's runner set. NOTE: form_starts only has
// COMPLETED starts — upcoming races have zero rows here. The race batch route
// sources its runner list from the live snapshot first, falling back to this
// for historical/known races.
export const RACE_RUNNERS_FROM_STARTS_SQL = `
  SELECT DISTINCT horse_name_key, horse_name
  FROM form_starts
  WHERE race_id = ?
    AND horse_name_key IS NOT NULL
`;

// Map a raw D1 / sqlite row (column → typed value) to a FormStartRow. D1 and
// better-sqlite3 both return JS-native types for INTEGER/TEXT/REAL columns,
// so the mapping is a pure type-narrow + null-coalesce.
export function mapRow(r: Record<string, unknown> | null | undefined): FormStartRow | null {
  if (!r) return null;
  return r as unknown as FormStartRow;
}

export function mapRows(rows: Record<string, unknown>[] | null | undefined): FormStartRow[] {
  return (rows ?? []) as unknown as FormStartRow[];
}
