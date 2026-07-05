-- ADR-0007 R5 — persist the result breakdown a ticket settled against.
--
-- Before this migration, a settled ticket only ever showed won/miss/refunded
-- + an amount; the actual finishing order was never stored anywhere. That was
-- fine for money, but the detail view can't show "who actually won" -- and by
-- the time a user opens an old ticket, the race that produced its result may
-- already have aged out of /api/live's rolling window, so there's no live
-- data left to re-derive it from either.
--
-- This column stores the top-N finishing positions (JSON, same shape as
-- RaceResult.placings: [{pos, umabans: [...]}]), dead-heat aware, computed by
-- workers/social/src/settle.ts::topPlacings at the moment a ticket settles
-- (client PATCH or the cron sweep -- see settle_result_hash's precedent in
-- 0005). NULL on tickets settled before this migration, and on tickets that
-- may never settle automatically (e.g. a race that aged out of the feed
-- before any settle path reached it) -- both are handled as "no breakdown
-- available" in the UI, not an error state.

ALTER TABLE tickets ADD COLUMN placings TEXT;
