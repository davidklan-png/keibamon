# ADR-0019: User deletion + data cascade policy

- **Status:** Proposed — David decides (2026-07-09)
- **Date:** 2026-07-09
- **Deciders:** David Klan
- **Builds on:** the social schema from [[ADR-0007]] (`users`, `tickets`,
  `cheers`, `follows`, `blocks`, `reports`, `user_impressions`); the
  flat-column/validation work from the 2026-07-09 hardening pass (migration
  0010); the results archive (`race_results`, 0008).

## Context

There is **no user-deletion path today.** A Clerk user who signs in gets a
`users` row that lives forever, along with every row they touched:

| Table | Owner? | FK → users(id) | `ON DELETE` |
|-------|--------|----------------|-------------|
| `tickets` | own content | `user_id` | none |
| `cheers` | edge (reaction to OTHERS' tickets) | `user_id` | none |
| `follows` | edge | `follower_id`, `followee_id` | none |
| `blocks` | edge | `blocker_id`, `blocked_id` | none |
| `reports` | moderation record | `reporter_id` | none |
| `user_impressions` | own private research marks | `user_id` | none |
| `rate_limits` | ephemeral | `user_id` | none |
| `race_results` | **not user-owned** (shared results archive) | — | n/a |

Because none of the FKs declare an `ON DELETE` action, a literal
`DELETE FROM users WHERE id = ?` **fails** with a foreign-key violation until
every referencing row is removed first. There is also no concept of a "deleted"
or "left" user — feeds and profiles have no filter for it. This is fine at
launch volume but becomes a real problem under GDPR/Account-Deletion requests
and for integrity once a user has participated in others' social data (cheers
on friends' tickets, the settlement history of won tickets).

This ADR proposes the policy. **No migration is included** — it is design-only,
landed for David to accept, amend, or reject.

## Decision (proposed)

Two-tier: **soft-delete the user + own content; hard-cascade the social edges.**

1. **`users` — SOFT-delete.** Add `deleted_at INTEGER` (NULL while active). A
   deletion request sets `deleted_at` (and clears `handle` to free it for
   reuse, after lower-casing it into a `deleted:<id>` tombstone so the
   case-insensitive handle index doesn't collide). The row is retained for
   audit and so historical references (cheers, reports) still resolve an
   identity. Auth rejects a deleted Clerk sub on the next request.

2. **Own content (`tickets`) — SOFT-delete.** A deleted user's tickets are
   hidden from feeds and their own list, but **settlement history is
   preserved** (a `won`/`miss` row is a historical record of a past race; the
   settle sweep and punter-stats aggregates depend on it staying queryable for
   the user's own history and for any aggregate integrity). Add a `deleted_at`
   (or reuse a `hidden` flag) on `tickets`; feeds/profile append
   `AND t.deleted_at IS NULL`.

3. **Social edges — HARD-cascade.** `follows` and `blocks` rows where the user
   is either endpoint are deleted outright (a deleted user follows/blocks no
   one and is followed/blocked by no one). Cheap, correct, and these have no
   historical value once either party is gone.

4. **`cheers` — KEEP, hide author.** A cheer is a reaction on SOMEONE ELSE's
   ticket; deleting it would silently rewrite that ticket's `cheers_count`
   history. Keep the row for count integrity, but feed/profile rendering must
   treat a cheer whose `user_id` is soft-deleted as anonymous (no handle/avatar
   attribution). The count already derives from `COUNT(*)`, so it stays correct.

5. **`reports` — KEEP, mark reporter deleted.** Reports are a moderation
   audit trail; they must survive a reporter's deletion. Rendering redacts the
   reporter identity when `users.deleted_at` is set.

6. **`user_impressions` — HARD-cascade.** A user's research marks are private
   to them and have no shared/historical value. Delete on user deletion.

7. **`rate_limits` — IGNORE.** Ephemeral, TTL-pruned already (Stage 5 sweep).
   No action; rows age out within 60s.

8. **`race_results` — NEVER touched by user deletion.** It is the shared,
   not-user-owned results archive (0008) that the settle sweep falls back to.
   User deletion has no reach into it.

## Impacts

- **Feeds/profile** (`social.ts` `buildFeed`/`buildProfile`): add
  `AND u.deleted_at IS NULL` (hide deleted authors' tickets) and
  `AND t.deleted_at IS NULL` (hide soft-deleted tickets). The owner join
  already exists; an anonymous-cheer path is new (point 4).
- **Settle sweep** (`sweep.ts`): unchanged — it operates on `tickets` by
  `race_key`/`state`, and a soft-deleted ticket's settlement history is
  intentionally retained.
- **Handle reuse**: freeing a handle on soft-delete must respect the
  case-insensitive `idx_users_handle_ci_unique` (0010) — tombstone the
  lower(handle) or the next claim of the same handle in any case collides.
- **D1 results archive**: unaffected (point 8).

## Deferred `state` CHECK (carried from migration 0010)

Stage 4 could not retrofit a `CHECK` on the pre-existing `tickets.state`
column — SQLite's `ALTER TABLE ADD COLUMN` cannot add a constraint to an
existing column, and a rebuild was out of scope for that migration. The
intended constraint is:

```sql
CHECK (state IN ('open','won','miss','refunded'))
```

`parseTicketBody` + `patchTicket` already enforce this set at the application
layer (`TICKET_STATES`), so the DB CHECK is defense-in-depth, not load-bearing.
It should land with whichever migration first rebuilds the `tickets` table
(this ADR's soft-delete columns are a natural occasion — a rebuild for
`tickets.deleted_at` can add the `state` CHECK in the same pass).

## Migration plan (when accepted — NOT in this PR)

1. `0011_user_deletion.sql`: `ALTER TABLE users ADD COLUMN deleted_at INTEGER`;
   `ALTER TABLE tickets ADD COLUMN deleted_at INTEGER`. Rebuild `tickets` to
   add the deferred `state` CHECK in the same migration. Backfill
   `deleted_at = NULL` (no-op for existing rows).
2. Retrofit the FKs that should cascade: `follows`, `blocks`,
   `user_impressions` get `ON DELETE CASCADE` (table rebuild — or rely on the
   deletion endpoint to DELETE the edges in a transaction, avoiding rebuilds).
   `cheers`/`reports` keep `ON DELETE NO ACTION` (rows are retained).
3. Deletion endpoint: `DELETE /api/social/me` → in one D1 batch, set
   `users.deleted_at`, tombstone the handle, hard-delete the user's
   `follows`/`blocks`/`user_impressions`, soft-delete their `tickets`. Idempotent.
4. Feeds/profile get the `deleted_at IS NULL` filters + anonymous-cheer render.
5. A reaper for Clerk users whose `clerk_user_id` no longer exists at the IdP
   (optional, later).

## Open questions for David

- **Tickets on soft-delete — hide immediately, or a grace window** (e.g. 30
  days recoverable, then reaped)? Affects whether `deleted_at` is a timestamp
  used for a reaper or just a boolean.
- **Cheer authorship**: fully anonymous ("a player"), or show "@deleted"?
  Recommendation: anonymous, matching the existing "no PII in social" posture.
- **Reports retention**: keep indefinitely for moderation audit, or age out?
  Recommendation: keep indefinitely (low volume, audit value).
- **Handle tombstone format**: `deleted:<id>` vs a separate `handle_claimed`
  flag. Recommendation: tombstone (simplest, keeps the unique index honest).
- Should deletion also clear `user_impressions` immediately, or is there value
  in retaining aggregate (de-identified) mark density per race? Recommendation:
  hard-delete (marks are personal research notes).
