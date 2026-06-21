-- ADR-0007 Phase 3 — social graph on the existing keibamon_social D1.
--
-- No new datastore. Phase 1 (users) and Phase 2 (tickets) are reused; this
-- migration adds the three Phase 3 primitives:
--
--   follows     — asymmetric follow graph (Twitter-style; no acceptance step)
--   cheers      — 1 row per (ticket, user); COUNT(*) is the source of truth
--                  for a ticket's cheer count (no denormalized counter to drift)
--   rate_limits — per-user per-minute abuse guard only; Phase 4 replaces with
--                  a real token bucket (likely in KV)
--
-- Plus a partial unique index on users(handle) so public profile routes can
-- route by handle without collision. NULL handles (Phase 1/2 users who never
-- set one) are exempt — the partial predicate `WHERE handle IS NOT NULL`
-- keeps them out of the index.

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id),
  followee_id TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows (follower_id);

CREATE TABLE IF NOT EXISTS cheers (
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cheers_ticket ON cheers (ticket_id);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id  TEXT NOT NULL REFERENCES users(id),
  action   TEXT NOT NULL,             -- 'follow' | 'cheer' | 'ticket'
  bucket   INTEGER NOT NULL,          -- floor(now/60)
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, action, bucket)
);

-- Handle uniqueness. Partial index so NULL handles (Phase 1/2 users) don't
-- collide. Lookup by handle is O(log n) via this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle_unique
  ON users (handle) WHERE handle IS NOT NULL;
