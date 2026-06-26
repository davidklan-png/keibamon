-- Weekly graded-stakes report archive.
--
-- One row per published edition/version of the Weekend Roundup. The payload is
-- a serialized WeekendInput (the report generator runs client-side +
-- deterministically, so the raw PIT snapshot is what we archive). Editions are
-- keyed by (edition_key, version); Friday publish is version 1, the Saturday
-- refresh is version 2, etc., so prior versions stay reviewable.
--
-- This table is OPTIONAL for the feature to work: /api/weekly-report returns
-- { status: "empty" } when the table is absent or empty, and the frontend
-- shows a cadence message + the real upcoming graded stakes from /api/live
-- (no fabricated data). Apply this migration (wrangler d1 execute) to promote
-- the feature to live data.
--
-- Publish step (operator-run, NOT an open endpoint — there is no admin-auth in
-- the racing worker): INSERT a WeekendInput JSON produced from the weekend's
-- gates/odds/card snapshots. See docs/prompts/weekly-roundup.md.

CREATE TABLE IF NOT EXISTS weekly_report (
  edition_key   TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  payload       TEXT    NOT NULL,
  published_at  TEXT    NOT NULL,
  PRIMARY KEY (edition_key, version)
);

CREATE INDEX IF NOT EXISTS idx_weekly_report_edition
  ON weekly_report (edition_key, version DESC);
