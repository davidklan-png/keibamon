-- Friend Interactions Phase 3 — comments + congratulations.
--
-- comments: single-level (no nesting in v1), anchored to a SHARE so they are
-- audience-scoped and a retract hides them with the share. Soft-delete
-- (deleted_at) backs owner-deletes-any + author-deletes-own. Body capped at 500
-- chars (the route validates; the CHECK is the defense-in-depth backstop).
--
-- congratulations: one row per (share, user) — the win-card reaction. This
-- REPLACES the legacy ticket-keyed `cheers` table, which is dropped below.
-- Count = COUNT(*) per share (no denormalized counter to drift). A win card
-- shows the count; one congratulate per user per win (the PK enforces it).
--
-- The legacy `cheers` system is deleted in THIS phase per the same-phase rule
-- (its replacement, congratulate, ships here). cheers rows are derived reaction
-- state — not user-authored content — so dropping them is safe.

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  share_id   TEXT NOT NULL REFERENCES shares(id),
  author_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comments_share ON comments (share_id, created_at);

CREATE TABLE IF NOT EXISTS congratulations (
  share_id   TEXT NOT NULL REFERENCES shares(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_congrats_share ON congratulations (share_id);

DROP TABLE IF EXISTS cheers;
