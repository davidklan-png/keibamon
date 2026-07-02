-- ADR-0018 — account-backed impression marks (Session 5b).
--
-- The signed-out My Tickets empty state (ADR-0013) promises "sign in to save
-- your marks." Until this migration, marks lived only in localStorage
-- (kbm.impressions.v1) — signing in saved nothing. This table makes the
-- promise true and gives marks cross-device continuity.
--
-- Schema mirrors the client ImpressionMap shape 1:1. comp_key is the existing
-- `${race_id}|${horse_key}` store key ( horse_key = NFKC + whitespace-strip,
-- NO lowercasing — see frontend/src/lib/normalizeName.ts). The PRIMARY KEY
-- enforces "at most one mark per (user, horse-in-a-race)" without extra app
-- code; full-replace on PUT (DELETE+INSERT) makes clears propagate without
-- tombstones.
--
-- The flat mark/umaban/odds_when_marked/odds_snapshot_at/formed_at columns are
-- the write surface; the client reads GET as a flat map (comp_key → Impression)
-- and rebuilds the ImpressionMap on sign-in via LWW merge (keep newer formed_at
-- per comp_key).
--
-- FK to users.id keeps the row valid even if the client skipped POST
-- /api/social/me (the Worker's ensureCaller upserts on first touch, same as
-- the tickets table).

CREATE TABLE IF NOT EXISTS user_impressions (
  user_id           TEXT NOT NULL REFERENCES users(id),
  comp_key          TEXT NOT NULL,
  mark              TEXT NOT NULL,           -- 'like' | 'distrust' | 'priceHorse' | 'avoid' | 'anchor'
  umaban            INTEGER,                 -- may be NULL when marked from an offline FormPanel
  odds_when_marked  REAL,                    -- NULL when odds context was unavailable at mark time
  odds_snapshot_at  TEXT,                    -- publisher's published_at heartbeat at mark time
  formed_at         INTEGER NOT NULL,        -- ms epoch — client-stamped, the LWW tiebreaker
  updated_at        INTEGER NOT NULL,        -- ms epoch — server-stamped on each PUT
  PRIMARY KEY (user_id, comp_key)
);

CREATE INDEX IF NOT EXISTS idx_user_impressions_user
  ON user_impressions (user_id);
