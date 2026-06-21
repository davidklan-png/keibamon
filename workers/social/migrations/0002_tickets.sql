-- ADR-0007 Phase 2 — per-user ticket persistence in keibamon_social.
-- The payload column carries the verbatim CommittedTicket JSON emitted by the
-- recommender (frontend/src/lib/types.ts); the flat columns are for querying
-- only (by user, by race_key, by state). State is open|won|miss — never NULL;
-- `returned` is NULL until the race reaches status 'result' and the resolver
-- has run. id is the CommittedTicket.id ("kb-…"), generated client-side.
--
-- Phase 1's users table is the only FK; cheers/follows come in Phase 3.

CREATE TABLE IF NOT EXISTS tickets (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  serial       TEXT NOT NULL,
  race_key     TEXT NOT NULL,
  payload      TEXT NOT NULL,
  state        TEXT NOT NULL,
  payout_base  INTEGER NOT NULL,
  returned     INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_created
  ON tickets (user_id, created_at DESC);
