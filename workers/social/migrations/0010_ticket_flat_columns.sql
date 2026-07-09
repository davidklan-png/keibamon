-- 0010 — derived flat columns on tickets (Stage 4) + case-insensitive handle.
--
-- The tickets table stored only the opaque payload + a few flat columns (state,
-- race_key, payout_base). This adds queryable derived columns so feeds and
-- analytics can filter/sort by ticket_type / line_count / cost / venue without
-- parsing JSON. THE PAYLOAD STAYS AUTHORITATIVE — these mirror it. The insert
-- path (parseTicketBody + insertTicket) populates them; existing rows are
-- backfilled below via json_extract. Read paths are NOT rewritten yet (they
-- still parse payload); feeds migrate to the flat columns later.
--
-- CHECK constraints attach to the new columns in the ADD COLUMN. SQLite allows
-- CHECK on ADD COLUMN; existing rows are NULL for the new columns and SQL CHECK
-- treats NULL as pass (unknown), so no table rebuild is needed. The existing
-- `state` column is NOT retrofitted with a CHECK here (it would require a table
-- rebuild) — that deferred CHECK is noted in ADR 0019.

-- ---- derived flat columns ----
ALTER TABLE tickets ADD COLUMN ticket_type TEXT
  CHECK (ticket_type IS NULL OR ticket_type IN
    ('quinella','wide','exacta','trio','trifecta','bracket_quinella'));
ALTER TABLE tickets ADD COLUMN line_count INTEGER
  CHECK (line_count IS NULL OR line_count BETWEEN 1 AND 5000);
ALTER TABLE tickets ADD COLUMN cost INTEGER
  CHECK (cost IS NULL OR cost BETWEEN 0 AND 5000000000);
ALTER TABLE tickets ADD COLUMN unit INTEGER
  CHECK (unit IS NULL OR unit BETWEEN 1 AND 1000000);
ALTER TABLE tickets ADD COLUMN structure TEXT
  CHECK (structure IS NULL OR structure IN ('single','box','wheel','formation'));
ALTER TABLE tickets ADD COLUMN venue TEXT;
ALTER TABLE tickets ADD COLUMN race_no INTEGER
  CHECK (race_no IS NULL OR race_no BETWEEN 1 AND 12);

-- ---- backfill existing rows from the payload (direct json_extract paths) ----
UPDATE tickets
SET ticket_type = json_extract(payload, '$.ticket.type'),
    line_count  = json_array_length(json_extract(payload, '$.ticket.lines')),
    unit        = json_extract(payload, '$.unit'),
    structure   = json_extract(payload, '$.ticket.structure'),
    cost        = COALESCE(json_extract(payload, '$.ticket.cost'),
                           json_extract(payload, '$.unit')
                             * json_array_length(json_extract(payload, '$.ticket.lines')))
WHERE ticket_type IS NULL;

-- venue + race_no from raceKey "<date>|<venue>|<raceNo>|<name>". raceKey parsing
-- in pure SQL (no SPLIT_PART): peel the date prefix, take the next |-field as
-- venue, then the next as race_no. NULL where raceKey is absent/malformed.
-- `instr(x || '|', '|')` guards a missing trailing field.
UPDATE tickets SET venue = CASE
  WHEN json_extract(payload,'$.race.raceKey') IS NULL
    OR instr(json_extract(payload,'$.race.raceKey'), '|') = 0 THEN NULL
  ELSE substr(
    substr(json_extract(payload,'$.race.raceKey'),
           instr(json_extract(payload,'$.race.raceKey'),'|') + 1),
    1,
    instr(substr(json_extract(payload,'$.race.raceKey'),
                 instr(json_extract(payload,'$.race.raceKey'),'|') + 1) || '|', '|') - 1
  )
END
WHERE venue IS NULL;

UPDATE tickets SET race_no = CAST(
  CASE
    WHEN json_extract(payload,'$.race.raceKey') IS NULL
      OR instr(json_extract(payload,'$.race.raceKey'), '|') = 0 THEN NULL
    -- rest after date + venue; if it has no '|', there is no race_no field.
    WHEN instr(substr(json_extract(payload,'$.race.raceKey'),
                      instr(json_extract(payload,'$.race.raceKey'),'|') + 1), '|') = 0 THEN NULL
    ELSE substr(
      substr(substr(json_extract(payload,'$.race.raceKey'),
                    instr(json_extract(payload,'$.race.raceKey'),'|') + 1),
             instr(substr(json_extract(payload,'$.race.raceKey'),
                          instr(json_extract(payload,'$.race.raceKey'),'|') + 1), '|') + 1),
      1,
      instr(substr(substr(json_extract(payload,'$.race.raceKey'),
                          instr(json_extract(payload,'$.race.raceKey'),'|') + 1),
                   instr(substr(json_extract(payload,'$.race.raceKey'),
                                instr(json_extract(payload,'$.race.raceKey'),'|') + 1), '|') + 1)
            || '|', '|') - 1
    )
  END AS INTEGER
)
WHERE race_no IS NULL;

-- ---- case-insensitive handle uniqueness (Stage 4) ----
-- 0003 made handles unique CASE-SENSITIVELY (idx_users_handle_unique), so "Bob"
-- and "bob" could coexist and public profile routing was ambiguous. Replace it
-- with a case-insensitive EXPRESSION index: lookups `WHERE lower(handle)=lower(?)`
-- are O(log n), and a case variant of a taken handle is rejected. upsertUser
-- already maps any UNIQUE violation to handle_taken.
--
-- PRE-CHECK (operator): if existing rows collide case-insensitively, the CREATE
-- UNIQUE INDEX below FAILS. Detect first and dedupe:
--   SELECT lower(handle) AS h, COUNT(*) AS n, GROUP_CONCAT(handle) AS examples
--     FROM users WHERE handle IS NOT NULL
--    GROUP BY lower(handle) HAVING COUNT(*) > 1;
DROP INDEX IF EXISTS idx_users_handle_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_ci_unique
  ON users (lower(handle)) WHERE handle IS NOT NULL;
