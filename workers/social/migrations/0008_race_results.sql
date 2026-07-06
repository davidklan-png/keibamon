-- #15 — D1 results archive so the sweep can settle rotated-off races.
--
-- The 5-minute settle sweep (workers/social/src/sweep.ts) reads /api/live,
-- which is a single rolling row the racing publisher OVERWRITES when next
-- weekend's card goes up. Any ticket still open at rotation used to be
-- stranded open forever — structural, not a one-off. It already bit real
-- users: 2026-06-28 capture outage stranded 20 tickets (3 specifically
-- never reached any settle path; resolved via a manual
-- tools/jravan/backfill_20260628_results.py +
-- workers/social/scripts/backfill-stuck-tickets.ts run — see
-- docs/prompts/backfill-stuck-june28-tickets.md for the incident shape).
--
-- This table is the durable record of race results the sweep can fall back
-- to when /api/live no longer carries the race. Filled by the sweep itself
-- (source='sweep') for every snapshot race with status='result', and by
-- the recovery importer (source='backfill') after capture outages.
--
-- NOT write-once — R3 re-settlement (see 0005_settlement_fingerprint.sql)
-- means a result can legitimately change (partial→complete, 確定
-- correction). The sweep's upsert is hash-gated via ON CONFLICT ... WHERE
-- result_hash != excluded.result_hash, so steady state is zero writes.
-- result_hash is the same SHA-256 the ticket fingerprint uses
-- (workers/social/src/settle.ts::hashResult) — one identity function
-- across both surfaces.

CREATE TABLE IF NOT EXISTS race_results (
  race_key    TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  source      TEXT NOT NULL,    -- 'sweep' | 'backfill'
  archived_at INTEGER NOT NULL
);
