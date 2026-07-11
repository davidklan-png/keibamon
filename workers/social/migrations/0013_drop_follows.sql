-- Friend Interactions Phase 2 — drop the legacy asymmetric follow graph.
--
-- The mutual-friend model (social_edges, 0011) replaces it; the /follow
-- endpoints, the follow graph functions, and the follower/followee/is_following
-- profile fields were deleted in this phase. Beta policy: when new-model
-- functionality replaces legacy, delete the legacy in the SAME phase — no
-- frozen endpoints, no compatibility shims. Existing follow edges are derived
-- social graph state (not user-authored content), so dropping them is safe.
--
-- The `type` column + 'follow' value remain in social_edges (0011) so a future
-- one-way follow mode can re-enable without a schema change; only the data +
-- table backing the OLD model go away.

DROP TABLE IF EXISTS follows;
