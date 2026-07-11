-- Friend Interactions Phase 1 — the unified social-edge graph + the in-app
-- notification log. Two additive tables on keibamon_social; no change to
-- existing tables. Applied via `wrangler d1 migrations apply keibamon-social`.
--
-- WHY A NEW GRAPH (the mutual-friend model; the legacy `follows` table is
-- dropped in 0013 — beta, aggressive legacy elimination):
--   social_edges models DIRECTED EDGES WITH A STATE so that:
--     - mutual friendship  = (a→b friend accepted) AND (b→a friend accepted)
--     - a friend request    = one directed edge (a→b friend pending)
--     - follow (future)     = type='follow', always accepted, no handshake
--   …the "directed edges with a mutual state rather than a single symmetric
--   row" shape the spec asks for, so a later one-way follow mode is a
--   re-enable, not a rewrite. The `type` column + enum are retained for that
--   future; no follow rows are seeded (the old graph is gone, not migrated).
--
-- NOTIFICATIONS table ships in Phase 1 (not Phase 4) because friend events
-- write records now ("sending a request notifies the recipient"); Phase 4 only
-- adds the BELL UI + read/mark endpoints + retention sweep on top. The columns
-- (type, actor, subject entity, timestamp, read state) are chosen so OS push
-- layers on later WITHOUT a schema change — push delivery will live in a new
-- push_tokens + notification_deliveries pair, leaving this table untouched.

CREATE TABLE IF NOT EXISTS social_edges (
  source_id  TEXT NOT NULL REFERENCES users(id),   -- the actor (requester / follower)
  target_id  TEXT NOT NULL REFERENCES users(id),   -- the subject
  type       TEXT NOT NULL CHECK (type IN ('friend', 'follow')),
  -- friend: pending = outstanding request, accepted = live edge, declined = reserved
  -- follow: always accepted (no handshake; future mode)
  state      TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,                               -- when pending → accepted/declined
  PRIMARY KEY (source_id, target_id, type),
  CHECK (source_id <> target_id)
);
-- Mutual-friend lookups ("who are my friends") read by target+state; the
-- incoming-pending list (badged count on the Friends tab) reads target+pending.
CREATE INDEX IF NOT EXISTS idx_social_edges_target ON social_edges (target_id, type, state);
CREATE INDEX IF NOT EXISTS idx_social_edges_source ON social_edges (source_id, type, state);

CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),  -- recipient (the bell owner)
  type         TEXT NOT NULL CHECK (type IN (
                 'friend_request_received',
                 'friend_request_accepted',
                 'ticket_shared_with_you',
                 'comment_on_your_ticket',
                 'comment_on_ticket_you_commented',
                 'congratulation_received',
                 'friends_ticket_won'
               )),
  actor_id     TEXT REFERENCES users(id),           -- who caused it; NULL for system
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'ticket', 'share', 'comment', 'friend_request')),
  subject_id   TEXT NOT NULL,                        -- id within subject_type
  created_at   INTEGER NOT NULL,
  read_at      INTEGER                               -- NULL = unread
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);
-- Unread-badge count is a hot read on every bell render; a partial index keeps
-- it cheap and lets the 90-day retention sweep scan only unread rows.
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id, read_at) WHERE read_at IS NULL;
