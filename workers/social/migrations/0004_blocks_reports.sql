-- ADR-0007 Phase 4 — block + report primitives.
--
-- Two new tables on the existing keibamon_social D1. No datastore change.
--
--   blocks  — asymmetric, one-way block graph (Twitter model).
--             INSERT = blocked; DELETE = unblock; idempotent on both sides.
--             A block severs existing follows in BOTH directions (see handler)
--             and prevents future follow/cheer between the pair (either
--             direction). A blocked user's tickets are filtered out of the
--             blocker's feed (one-way: the blocked user can still see the
--             blocker's tickets).
--
--   reports — write-only moderation intake. No UI for review yet (Phase 4
--             backlog); the table + endpoint exist so reports aren't lost.
--             target_type is 'ticket' | 'user'; target_id is the row id.

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks (blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('ticket','user')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (target_type, target_id);
