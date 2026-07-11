-- Friend Interactions Phase 2 — shared tickets + their audience.
--
-- A SHARE is an immutable, audience-scoped publication of a ticket. It IS the
-- privacy gate for the friend feed: per the requirements, "Nothing is visible
-- to friends until explicitly shared." One ACTIVE share per ticket; re-sharing
-- widens the audience, retracting soft-deletes it (drops it from every feed and
-- hides its comments). The ticket row itself is never mutated by sharing —
-- `snapshot` freezes the verbatim CommittedTicket JSON at share time, so a
-- later edit to the owner's open ticket does not change the shared card
-- (immutable snapshot; explicitly NOT a two-way ticket sync).
--
-- FEED CUTOVER IS A CLEAN CUT: legacy auto-feed content (every committed ticket
-- auto-visible to followers) is NOT migrated and NOT grandfathered. Only rows in
-- this table appear in the feed; legacy auto-feed content becomes invisible and
-- nothing is marked shared retroactively.

CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT NOT NULL REFERENCES tickets(id),
  owner_id      TEXT NOT NULL REFERENCES users(id),
  audience_mode TEXT NOT NULL CHECK (audience_mode IN ('all_friends', 'selected')),
  snapshot      TEXT NOT NULL,                 -- frozen CommittedTicket JSON at share time
  is_win        INTEGER NOT NULL DEFAULT 0,    -- Phase 3: promoted to a win post on settle
  retracted_at  INTEGER,                       -- NULL = live; set = silently removed from feeds
  created_at    INTEGER NOT NULL
);
-- One ACTIVE share per ticket. A retracted share frees the ticket to be shared
-- anew (retract → re-share creates a fresh row). Partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_active_ticket
  ON shares (ticket_id) WHERE retracted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shares_owner_created ON shares (owner_id, created_at DESC);
-- The feed scans live shares newest-first; a partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_shares_feed ON shares (created_at DESC) WHERE retracted_at IS NULL;

-- Explicit per-recipient list for audience_mode='selected'. For 'all_friends'
-- the audience is dynamic (resolved as current mutual friends at read time), so
-- no rows are stored. PK dedupes; the user index backs the feed's
-- "selected audience contains viewer" existence check.
CREATE TABLE IF NOT EXISTS share_audience (
  share_id TEXT NOT NULL REFERENCES shares(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_share_audience_user ON share_audience (user_id);
