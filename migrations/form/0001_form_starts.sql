-- form_starts: one row per completed JRA start, the projection of
-- keibamon_core.marts.form.build_form_marts PLUS trainer_id (merged in from
-- jockey_form by the publisher so the jockey card's by_trainer combo works).
-- Source of truth: src/keibamon_core/marts/form.py — DO NOT change that
-- builder; the Worker must reproduce its cards from these rows byte-for-byte.
--
-- The schema is intentionally SQLite-compatible so the parity suite can run
-- the Worker's exact SQL strings against an in-process better-sqlite3 db.
-- D1 is API-compatible with the same SQL.
--
-- Point-in-time filter is applied AT READ TIME: every SELECT binds
-- `available_at < ?`. `available_at` is the start's own event time (JST→UTC),
-- never the bulk-download time.

CREATE TABLE IF NOT EXISTS form_starts (
  horse_name_key       TEXT,
  horse_name           TEXT,
  jockey_id            TEXT,
  trainer_id           TEXT,
  race_id              TEXT,
  horse_number         INTEGER,
  available_at         TEXT,        -- ISO UTC; the PIT column
  race_date            TEXT,
  racecourse           TEXT,
  surface              TEXT,
  distance_m           INTEGER,
  distance_band        TEXT,
  going                TEXT,
  going_wetness        INTEGER,
  is_wet               INTEGER,     -- bool as 0/1
  grade_label          TEXT,
  field_size           INTEGER,
  finish_position      INTEGER,
  finish_time_seconds  REAL,
  margin               TEXT,
  last_3f_seconds      REAL,
  last_3f_rank         INTEGER,
  win_odds             REAL,
  popularity           INTEGER,
  beat_market          INTEGER,
  style_signal         TEXT
);

CREATE INDEX IF NOT EXISTS ix_fs_horse  ON form_starts (horse_name_key, available_at);
CREATE INDEX IF NOT EXISTS ix_fs_jockey ON form_starts (jockey_id, available_at);
CREATE INDEX IF NOT EXISTS ix_fs_race   ON form_starts (race_id);
