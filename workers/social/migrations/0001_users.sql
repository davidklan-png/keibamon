-- ADR-0007 Phase 1 — users table for the social tier.
-- Isolated from keibamon-live; this D1 (keibamon_social) owns identity + the
-- future home of tickets/follows/cheers (ADR-0007 Phase 2/3). id is generated
-- client-side (crypto.randomUUID()) on first insert. clerk_user_id is the
-- natural key the Worker routes by. age_verified is a self-attestation per
-- Decision 9 — NOT document KYC.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  clerk_user_id TEXT UNIQUE NOT NULL,
  handle        TEXT,
  display_name  TEXT,
  avatar        TEXT,
  age_verified  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
