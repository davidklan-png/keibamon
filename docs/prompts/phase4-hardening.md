# CLI agent prompt — Keibamon Phase 4: hardening (ADR-0007)

> Paste the fenced block below into the CLI agent on the **Mac** (mac-dev).
> Assumes ADR-0007 Phases 1–3 are merged. Phase 4 makes the feature reliable and
> safe for general availability.

```
You are implementing Phase 4 (hardening) of ADR-0007 ("My Tickets" social
surface) in the Keibamon repo. Read docs/adr/0007-my-tickets-social-surface.md,
CLAUDE.md, and the Phase 1–3 runbooks before doing anything. Phases 1–3
(identity, server-side tickets + client settlement, social layer) are merged.
This phase adds reliability, safety, and visual sign-off — no new product surface.

## First
Run `python tools/whichdevice.py`. This is mac-dev work. If you are not on
mac-dev, stop and tell me.

## Goal
Make settlement reliable for offline users, make the resolver correct on real
JRA edge cases, add basic abuse/safety controls to the public social graph,
remove the runtime font dependency, and lock the light theme with a
visual-regression gate.

## Hard constraints (do not violate)
- DO NOT touch the racing D1, /api/live's data source, the splash/app asset
  worker, tools/jravan, ingestion, src/keibamon_core, or the JV-Link/capture
  pipeline. You READ /api/live only. (Driving the producer to emit results with
  ties/scratches is a SEPARATE racing-tier PR — follow-up #1 — NOT in this prompt.)
- Reuse the existing Worker (workers/social) + keibamon_social D1 + Clerk auth.
- Keep both suites green: `cd frontend && npm test` and, from repo root,
  `PYTHONPATH=src python -m pytest -q`.
- Bilingual (en + ja) for new strings. Honesty guardrails enforced by
  guardrails.test.ts: never "guaranteed", "lock", "sure thing", "beat the
  market"; keep the not-advice Footer + under-20 notice; the share card keeps
  its not-advice micro-line.
- Never commit secrets.

## Tasks

1. Server-side settle sweep (reliability)
   - Add a scheduled reconciler in workers/social (Cron Trigger, or a Durable
     Object alarm) that periodically: reads /api/live, finds OPEN tickets whose
     race reports status 'result', runs the SAME resolver as the client
     (share lib/settle logic — do not fork the rules), and PATCHes
     state + returned. Idempotent: a ticket already settled is a no-op.
   - This makes settlement reliable for users who are offline at post time. The
     client auto-settle effect stays as the fast path; the sweep is the backstop.
   - Document the cadence and the wrangler cron config in the runbook.

2. Dead-heat & scratch correctness in the resolver (settle.ts)
   - Derive the placing SET from the result's placing data (which may list ≥2
     horses at a position) rather than one strict ordered array, so 同着 (dead
     heat) races that legitimately hit do not mis-settle as MISS.
   - Handle scratched horses (出走取消・返還): a line containing a scratch resolves
     to a refund path, not an automatic MISS.
   - Add table-driven tests against SYNTHETIC result payloads covering: a clean
     win/miss per bet type, a dead-heat at 2nd and at 3rd, and a scratch in the
     line. (These run now against fixtures; real data arrives with follow-up #1.)
   - Keep the resolver pure + idempotent; client and sweep both consume it.

3. Rate limiting & abuse guards (write paths)
   - Per-user rate limits on POST /tickets, follow, and cheer (token-bucket or a
     simple counter keyed in D1 / KV). Return 429 with a friendly message.
   - Document the limits in the runbook.

4. Safety controls for public profiles
   - Block: a user can block another user (hides their content from the blocker,
     prevents follow/cheer between them). Add a `blocks` table + endpoints.
   - Report: a user can report a ticket or profile (store reports for review).
   - These are minimal moderation primitives appropriate to the public-profile
     model (Decision 8); keep them simple but present.

5. Self-host fonts (remove runtime dependency)
   - Vendor M PLUS Rounded 1c + Space Mono (the weights used) as self-hosted
     woff2 and replace the Google Fonts @import in styles.css with @font-face +
     local files. No external font request at runtime. Verify the bundle still
     builds and the light theme renders identically.

6. Share image — optional server-side render (stretch)
   - If cross-platform inconsistency in the client html-to-image export is a
     problem, add a server-side card renderer for a consistent share image;
     otherwise keep the client export and record the decision. Either way the
     output keeps the not-advice micro-line.

7. Visual-regression sign-off
   - Add a visual-regression check (e.g. Playwright snapshots) across all
     screens in BOTH languages: My Tickets feed / new / detail, and the four
     legacy screens (race / style / tickets / explain) under the light theme.
     Commit baseline snapshots. This is the gate that the app-wide re-theme
     (Decision 1) did not regress the existing screens.

## Acceptance criteria
- A user offline at post time has their ticket settled by the sweep on the next
  scheduled run (demonstrate with a fixture result).
- settle.ts passes dead-heat and scratch fixtures for all bet types; no
  mis-settlement on ties.
- Write paths return 429 past the configured limit; block/report endpoints work
  and are owner/relationship-checked.
- No runtime Google Fonts request; bundle builds; theme visually unchanged.
- Visual-regression baselines committed; both test suites pass; racing tier
  untouched (show the diff scope); no secrets committed.

## Workflow
Branch `feat/adr-0007-phase4-hardening`. Small commits. When done, summarize the
diff, the cron/secret/migration commands I must run, the rate-limit + moderation
rules you chose, and confirm the dead-heat/scratch fixtures. Note that real
settlement still depends on the racing-tier producer change (follow-up #1). Do
not merge — open for review.
```
