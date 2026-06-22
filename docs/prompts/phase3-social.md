# CLI agent prompt — Keibamon Phase 3: follows, cheers, public profiles, share (ADR-0007)

> Paste the fenced block below into the CLI agent on the **Mac** (mac-dev).
> Assumes ADR-0007 Phase 2 (server-side ticket persistence + settlement) is merged.

```
You are implementing Phase 3 of ADR-0007 ("My Tickets" social surface) in the
Keibamon repo. Read docs/adr/0007-my-tickets-social-surface.md, CLAUDE.md, and the
Phase 1/2 runbooks before doing anything. Phases 1 (Clerk identity) and 2
(server-side tickets + settlement on keibamon_social) are merged. You are adding
the SOCIAL LAYER: follows, real cross-user cheers, public profiles, real
friend/cheer counts, and share-image export.

## First
Run `python tools/whichdevice.py`. This is mac-dev work. If you are not on
mac-dev, stop and tell me.

## Goal
Turn the cosmetic social elements (friend avatars, "N friends on this race",
local clap counter) into real multi-user state on the existing keibamon_social
D1, and let a settled card be exported as an image to share. Per ADR-0007:
public profiles / follow model (Decision 8), realtime via the existing 45s poll
(Decision 7, NO websockets), game framing so every shared card keeps the
not-betting-advice micro-line (Decision 9).

## Hard constraints (do not violate)
- DO NOT touch the racing D1, /api/live's data source, the splash/app asset
  worker, tools/jravan, ingestion, src/keibamon_core, or the JV-Link/capture
  pipeline. You READ /api/live only.
- Reuse the Phase 1/2 Worker (workers/social), Clerk JWT auth, and the
  keibamon_social D1. No new datastore, no websockets/Durable Objects — counts
  refresh on the existing 45s poll.
- Keep both suites green: `cd frontend && npm test` and, from repo root,
  `PYTHONPATH=src python -m pytest -q`.
- Bilingual (en + ja) for all new strings. Honesty guardrails enforced by
  frontend/src/i18n/guardrails.test.ts: never "guaranteed", "lock", "sure thing",
  "beat the market". The not-advice Footer + under-20 notice stay reachable, and
  the share card MUST keep its "for fun — not betting advice" micro-line.
- Never commit secrets.

## Tasks

1. Schema (workers/social/migrations/0003_social.sql)
   - follows(follower_id TEXT NOT NULL REFERENCES users(id),
             followee_id TEXT NOT NULL REFERENCES users(id),
             created_at  INTEGER NOT NULL,
             PRIMARY KEY(follower_id, followee_id));
   - cheers(ticket_id TEXT NOT NULL REFERENCES tickets(id),
            user_id   TEXT NOT NULL REFERENCES users(id),
            created_at INTEGER NOT NULL,
            PRIMARY KEY(ticket_id, user_id));   -- 1 cheer per user per ticket
   - Indexes for the count queries you add (e.g. cheers by ticket_id;
     follows by follower_id and by followee_id).
   - Add a denormalized claps integer on tickets OR compute COUNT(*) from cheers
     — pick one and justify it in the runbook (favor correctness; cache if needed).

2. Worker endpoints (all Clerk-authenticated unless marked public)
   - POST   /api/social/follow/:userId      — follow; idempotent.
   - DELETE /api/social/follow/:userId      — unfollow.
   - POST   /api/social/tickets/:id/cheer   — cheer a WON ticket; idempotent
                                              (PK dedupe); return new count.
   - DELETE /api/social/tickets/:id/cheer   — uncheer (optional; if you add it).
   - GET    /api/social/users/:handle       — PUBLIC profile: display info + that
                                              user's tickets + cheer counts.
   - GET    /api/social/feed                — the caller's feed = own + followed
                                              users' tickets, newest first, with
                                              cheer counts and "cheeredByMe".
   - GET    /api/social/races/:raceKey/friends — count + sample avatars of
                                              followed users who have a ticket on
                                              that race (powers "N friends on this race").
   Enforce: cheers only on state='won'; users may not cheer their own ticket if
   you decide that rule (state it either way in the runbook); ownership unchanged.
   Add light abuse guards (per-user rate limit on follow/cheer); full rate
   limiting is Phase 4 — keep it minimal but present.

3. Frontend — wire the real social data
   - Replace the seeded community strip + "12 friends are on today's card" and the
     detail "8 friends on this race" with real counts from the endpoints above,
     refreshed on the existing 45s poll (no new timer).
   - Cheers: move from the Phase 2 local counter to POST .../cheer; reflect the
     server count + cheeredByMe; keep the kbmBurst animation. Still only on WON
     tickets.
   - Add a minimal public profile view (route by handle): avatar, handle, their
     tickets as read-only cards. Reachable by tapping an owner/avatar.
   - Follow/unfollow button on profiles and on community tickets.

4. Share — image export of the card
   - Add a "Save & share" that exports the detail card to a PNG (html-to-image is
     fine; the card is already self-contained). Use navigator.share() when
     available, else download. The exported image MUST include the
     not-betting-advice micro-line and the @handle. Replace the Phase 0 toast stub.
   - Keep the export client-side for now; note a server-side card renderer as a
     possible Phase 4 upgrade for consistent cross-platform output.

5. Tests
   - Worker: follow/unfollow idempotency; cheer dedupe (PK) + won-only rule;
     public profile returns only public-safe fields; feed includes followed users;
     401 without token on authed routes; counts correct.
   - Frontend: cheer reflects server count + cheeredByMe; friends-on-race count
     renders from the endpoint; share export produces an image containing the
     not-advice line (assert the node is present pre-export).
   - All existing suites stay green.

6. Setup & docs (human-in-the-loop — prepare, don't guess)
   - Give me the exact `wrangler d1 migrations apply` commands (local + remote) for
     0003_social.sql.
   - Write docs/runbooks/phase3-social.md: schema, endpoints, the cheer/follow
     rules, the claps count strategy, share-export approach, deploy/rollback.
   - Update docs/adr/0007-my-tickets-social-surface.md: mark Phase 3 status and
     record decisions (count denormalization, cheer-own-ticket rule, share lib).
   - Note the Phase 4 follow-ups you did NOT do: full rate limiting, block/report,
     self-host fonts, server-side card render, visual-regression sign-off.

## Acceptance criteria
- Two real accounts: A follows B; B's settled ticket shows in A's feed; A cheers
  it once (second tap is a no-op); B sees the cheer count rise within one poll.
- "N friends on this race" reflects followed users who actually have a ticket on
  that race.
- A public profile loads for a signed-out-safe handle and lists that user's tickets.
- Exporting a card yields an image that still carries the not-advice micro-line.
- Racing D1 / /api/live / ingestion untouched (show the diff scope); no websockets
  added; `cd frontend && npm run build` succeeds; both suites pass; no secrets.

## Workflow
Branch `feat/adr-0007-phase3-social`. Small commits. When done, summarize the diff,
the migration commands I must run, the social rules you chose, and the Phase 4
hardening backlog. Do not merge — open for review.
```
