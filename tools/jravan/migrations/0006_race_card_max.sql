-- ADR-0007 R4 (Tokyo truncation root cause) -- per-(date, venue) high-water
-- mark for the number of races published.
--
-- Context: a single transient miss in netkeiba's race_list_sub.html (one
-- venue's R9-R12 not linked on a single fetch) became a PUBLISHED truncation
-- because live_snapshot's INSERT OR REPLACE clobbered the prior complete card
-- unconditionally. The R3 anti-shrink guard only compared per-date totals --
-- "32 -> 32" passed, "36 -> 32" refused -- so a same-size truncated re-publish
-- advanced meta.published_at while the card stayed broken. The verification
-- layer proved this bites: a snapshot published_at=2026-06-22T13:08:12Z with
-- only 8 Tokyo races (R1-R8) made the app look fresh when it was actually
-- truncated.
--
-- This table is the INDEPENDENT baseline the guard needs. The publisher reads
-- it before each push; if the would-be-published count for any (date, venue)
-- is BELOW the stored high-water mark, the publish is REFUSED (the existing
-- snapshot stays). When the count meets or exceeds the stored mark, the mark
-- is updated. Storing the mark in D1 (not embedded in the snapshot payload)
-- means it survives across publishes -- a transient discovery miss cannot
-- lower the bar.
--
-- Seed: a one-off backfill from the current live_snapshot payload is run after
-- the migration applies, so existing complete cards (e.g. Jun 21 with 12 per
-- venue) become the floor immediately instead of waiting for a "first complete
-- publish" that may not come if the producer happens to miss again.

CREATE TABLE IF NOT EXISTS race_card_max (
  date_yyyymmdd TEXT NOT NULL,
  venue_code    TEXT NOT NULL,
  max_races     INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (date_yyyymmdd, venue_code)
);
