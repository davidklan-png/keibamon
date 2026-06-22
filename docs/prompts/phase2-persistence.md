# CLI agent prompt — Keibamon Phase 2: per-user persistence + settle (ADR-0007)

> Paste the fenced block below into the CLI agent on the **Mac** (mac-dev).
> Assumes ADR-0007 Phase 1 (Clerk auth + keibamon_social D1 + users table +
> /api/social/me) is merged.

```
You are implementing Phase 2 of ADR-0007 ("My Tickets" social surface) in the
Keibamon repo. Read docs/adr/0007-my-tickets-social-surface.md, CLAUDE.md, and
docs/runbooks/phase1-clerk-auth.md before doing anything. Phase 1 (Clerk identity
+ the keibamon_social D1 with a users table) is merged. You are adding
SERVER-SIDE TICKET PERSISTENCE and SETTLEMENT only.

## First
Run `python tools/whichdevice.py`. This is mac-dev work. If you are not on
mac-dev, stop and tell me.

## Goal
Move committed tickets off localStorage into the existing keibamon_social D1
(per authenticated user), make localStorage an offline read cache only, and
resolve win/miss when a ticket's race reaches status 'result' — driven by the
existing /api/live poll, not a manual button.

## Hard constraints (do not violate)
- DO NOT touch the racing D1, /api/live's data source, the splash/app asset
  worker, or anything under tools/jravan, ingestion, src/keibamon_core, or the
  JV-Link/capture pipeline. You READ /api/live; you never write to it.
- DO NOT build Phase 3 (follows, cheers shared across users, public profiles,
  share-image export). Cheers stay a local-only counter for now — leave the
  clap UI working but do not add a cheers table or cross-user sync yet.
- Reuse the Phase 1 Worker (workers/social) + Clerk JWT auth + keibamon_social
  D1. No new datastore.
- Keep both suites green: `cd frontend && npm test` and, from repo root,
  `PYTHONPATH=src python -m pytest -q`.
- Bilingual (en + ja) for any new strings. Honesty guardrails enforced by
  frontend/src/i18n/guardrails.test.ts: never "guaranteed", "lock", "sure thing",
  "beat the market"; keep the not-advice Footer + under-20 notice.
- Never commit secrets.

## Tasks

1. Schema — add a tickets table (migration workers/social/migrations/0002_tickets.sql)
       tickets(
         id           TEXT PRIMARY KEY,        -- the CommittedTicket.id ("kb-…")
         user_id      TEXT NOT NULL REFERENCES users(id),
         serial       TEXT NOT NULL,
         race_key     TEXT NOT NULL,           -- date|venue|race_no|name
         payload      TEXT NOT NULL,           -- JSON: full CommittedTicket (ticket + RaceSnapshot + mood + unit)
         state        TEXT NOT NULL,           -- open | won | miss
         payout_base  INTEGER NOT NULL,
         returned     INTEGER,                 -- set on settle
         created_at   INTEGER NOT NULL
       );
       -- index on (user_id, created_at desc)
   Store the verbatim CommittedTicket JSON in payload (the recommender output is
   opaque to the social tier); the columns are for querying.

2. Worker endpoints (workers/social, all Clerk-authenticated; 401 without a valid token)
   - POST   /api/social/tickets        — commit: body = CommittedTicket; insert; return it.
   - GET    /api/social/tickets        — the caller's feed, newest first.
   - PATCH  /api/social/tickets/:id    — update state/returned (settle) and/or claps;
                                         only the owner may patch their ticket.
   Validate ownership on every write. Reject unknown ids with 404.

3. Frontend — server is source of truth, localStorage is a cache
   - On a signed-in load, GET /api/social/tickets and render that as the feed.
     Mirror the response into localStorage (keyed by Clerk user id, from Phase 1)
     so the feed renders instantly/offline on next load (read-through cache).
   - Commit (the New-bet flow) writes optimistically to local state + cache, then
     POSTs to the server; on failure, queue and retry on next load (simple
     offline queue is fine — document it).
   - Remove the demo seed for signed-in users (seed was a Phase 0 stand-in). Keep
     an empty-state for new accounts.

4. Settlement — driven by /api/live, not a button
   - The app already polls /api/live every 45s. For each of the user's OPEN
     tickets, find its race by race_key; when that race reports status 'result',
     resolve win/miss against the result payload and PATCH the ticket
     (state + returned). Inspect the actual /api/live result payload shape first
     (do not assume) and implement resolution for every bet type the recommender
     emits: quinella, wide, exacta, trio, trifecta. If the result payload lacks
     payout figures, settle state (won/miss) and show the commit-time estimate,
     and leave a clear TODO + log for the missing payout source.
   - Keep the manual "Watch the result" trigger ONLY behind a dev/storybook flag
     (e.g. import.meta.env.DEV); it must not appear in production.

5. Tests
   - Worker: ticket CRUD + ownership enforcement (owner can PATCH, others get 403),
     401 without token, 404 unknown id.
   - Frontend: read-through cache (server response overwrites cache), optimistic
     commit + retry queue, and win/miss resolution unit tests for all five bet
     types (table-driven against sample result payloads).
   - All existing suites stay green.

6. Setup & docs (human-in-the-loop — prepare, don't guess)
   - Give me the exact commands to apply the new migration to keibamon_social
     (local + remote `wrangler d1 migrations apply`).
   - Update docs/runbooks/phase1-clerk-auth.md (or add phase2-persistence.md):
     schema, endpoints, the settlement resolution rules + the payout-source gap if
     any, and deploy/rollback.
   - Update docs/adr/0007-my-tickets-social-surface.md: mark Phase 2 status and
     record decisions (offline-queue approach, settlement source, payout gaps).

## Acceptance criteria
- A committed ticket persists to keibamon_social.tickets and reappears after a
  full reload / on another device for the same account.
- localStorage is a cache only: clearing it does not lose committed tickets
  (they reload from the server).
- An open ticket whose race reaches 'result' auto-settles to won/miss with the
  correct resolution per bet type — no manual button in production.
- Ownership is enforced on every write; racing D1 / /api/live / ingestion are
  untouched (show me the diff scope).
- `cd frontend && npm run build` succeeds; both test suites pass; no secrets committed.

## Workflow
Branch `feat/adr-0007-phase2-persistence`. Small commits. When done, summarize the
diff, the migration/secret commands I must run myself, the settlement resolution
rules you implemented (and any payout-data gap), and follow-ups for Phase 3
(follows, cheers, public profiles, share export). Do not merge — open for review.
```
