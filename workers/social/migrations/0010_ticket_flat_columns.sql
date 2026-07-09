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

-- ---- backfill existing rows from the payload ----
-- cost is DERIVED from validated unit × line_count — never trusted from the
-- payload's ticket.cost (which a client could forge). unit/lines missing → NULL.
UPDATE tickets
SET ticket_type = json_extract(payload, '$.ticket.type'),
    line_count  = json_array_length(json_extract(payload, '$.ticket.lines')),
    unit        = json_extract(payload, '$.unit'),
    structure   = json_extract(payload, '$.ticket.structure'),
    cost        = CAST(json_extract(payload, '$.unit') AS INTEGER)
                    * json_array_length(json_extract(payload, '$.ticket.lines'))
WHERE ticket_type IS NULL;

-- venue from raceKey "<date>|<venue>|<raceNo>|<name>" (no CHECK — free text).
-- NULL where raceKey is absent/malformed. `instr(x || '|', '|')` guards a
-- missing trailing field.
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

-- race_no from the 3rd raceKey field. ONLY a canonical 1–12 value is written;
-- anything else becomes NULL. This is load-bearing: SQLite's
-- `CAST('<non-numeric>' AS INTEGER)` coerces to 0, which would violate the new
-- `CHECK (race_no BETWEEN 1 AND 12)` and ABORT a production migration. The
-- GLOB guards accept exactly "1".."9" / "10".."12"; "0", "13", "abc", "01",
-- "" and a missing field all → NULL. Extract the field once per row via a
-- derived table (UPDATE ... FROM), then validate.
UPDATE tickets AS t SET race_no = CASE
  WHEN f.rno GLOB '[1-9]' OR f.rno GLOB '1[0-2]' THEN CAST(f.rno AS INTEGER)
  ELSE NULL
END
FROM (
  SELECT id, substr(after_venue, 1, instr(after_venue || '|', '|') - 1) AS rno
  FROM (
    SELECT id,
      substr(after_date, instr(after_date, '|') + 1) AS after_venue
    FROM (
      SELECT id,
        substr(rk, instr(rk, '|') + 1) AS after_date,
        rk
      FROM (
        SELECT id, json_extract(payload, '$.race.raceKey') AS rk
        FROM tickets
      )
      WHERE rk IS NOT NULL AND instr(rk, '|') > 0
        AND instr(substr(rk, instr(rk, '|') + 1), '|') > 0
    )
  )
) AS f
WHERE t.id = f.id AND t.race_no IS NULL;

-- ---- case-insensitive handle uniqueness (Stage 4) ----
-- 0003 made handles unique CASE-SENSITIVELY (idx_users_handle_unique), so "Bob"
-- and "bob" could coexist and public profile routing was ambiguous. Replace it
-- with a case-insensitive EXPRESSION index: lookups `WHERE lower(handle)=lower(?)`
-- are O(log n), and a case variant of a taken handle is rejected. upsertUser
-- already maps any UNIQUE violation to handle_taken.
--
-- PRE-CHECK (operator, MANDATORY before applying): if any two existing handles
-- collide case-insensitively, the CREATE UNIQUE INDEX below FAILS and the
-- migration ABORTS. Detect and dedupe FIRST:
--   SELECT lower(handle) AS h, COUNT(*) AS n, GROUP_CONCAT(handle) AS examples
--     FROM users WHERE handle IS NOT NULL
--    GROUP BY lower(handle) HAVING COUNT(*) > 1;
--
-- ORDER IS FAIL-SAFE: the case-insensitive index is CREATED FIRST and the
-- case-sensitive predecessor is dropped ONLY AFTER a successful create. So:
--   - On a collision, CREATE fails, the migration aborts, and the ORIGINAL
--     idx_users_handle_unique is still in place → handles stay unique
--     (case-sensitively), the guarantee never broken. Dedupe and re-run.
--   - On success, both briefly coexist (CI is the stricter), then the old one
--     is dropped. Either way a uniqueness guarantee is always present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_ci_unique
  ON users (lower(handle)) WHERE handle IS NOT NULL;
DROP INDEX IF EXISTS idx_users_handle_unique;
