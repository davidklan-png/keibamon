-- 0009 — covering indexes for the non-(user_id) ticket query paths.
--
-- 0002 indexed only (user_id, created_at DESC), which is fine for listTickets
-- and the buildFeed / buildProfile scans (both lead on user_id). But two ramp
-- paths had no supporting index and table-scanned:
--
--   • settle sweep (workers/social/src/sweep.ts):
--       - SNAPSHOT pass: WHERE race_key IN (...) ORDER BY created_at DESC
--       - FALLBACK pass: WHERE state='open' [AND race_key NOT IN (...)]
--                        ORDER BY created_at DESC   (joined to race_results)
--   • friends-on-race / friends-on-card (workers/social/src/social.ts):
--       correlated EXISTS: WHERE user_id = ? AND race_key = ?   (resp. IN (...))
--
-- Minimal covering set — leftmost-prefix sharing, no standalone (race_key):
--
--   (race_key, state, created_at DESC)
--     Leftmost race_key serves every race_key lookup: the sweep snapshot
--     IN-list AND the friends-on-* equality/IN checks. state + created_at are
--     carried so a future race_key+state filter is covered without a new index.
--     NOTE for review: `state` is NOT a seek column for any current race_key-
--     scoped query (none filters both). It is forward-looking and lets this one
--     index substitute for a plain (race_key) index — the alternative
--     (race_key, created_at DESC) is marginally smaller but less future-proof.
--
--   (state, created_at DESC)
--     The sweep fallback pass has no race_key equality (it joins race_results
--     and uses `race_key NOT IN (...)`, which is non-sargable), so it cannot
--     ride the race_key index — it needs its own state-leading index.
--
-- Additive only — no reader is rewritten. Verify with EXPLAIN QUERY PLAN on the
-- production-shaped queries after remote apply (local tests use a hand-rolled
-- fake D1 that does not run migrations).

CREATE INDEX IF NOT EXISTS idx_tickets_race_state_created
  ON tickets (race_key, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tickets_state_created
  ON tickets (state, created_at DESC);
