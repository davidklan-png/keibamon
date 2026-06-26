# ADR-0009: Weekly report publish path (manual vs. authenticated endpoint)

- **Status:** Deferred — **manual publish retained** (decision artifact only, no
  code change)
- **Date:** 2026-06-26
- **Surface:** Reference → Weekend roundup publish flow (`weekly_report` D1 table)

## Summary

The Weekend Roundup is published by an **operator running `wrangler d1 execute`
to INSERT** a serialized `WeekendInput` (Friday v1, Saturday v2) into the
`keibamon-live` D1 `weekly_report` table. There is deliberately **no open POST
endpoint** on the racing worker — and therefore no admin-auth surface.

This memo records the trade-off and a **trigger condition** for revisiting it.
**No code is changed by this decision.**

## The tension

Manual publish is a deliberate safety choice, but it **couples the weekly
content cadence to David being present at the Mac**. The project has already
been burned by a host being asleep or traveling on a race day (the closed-lid
capture failure, ADR-0004 context). A stakes weekend with no operator at the
keyboard means no Friday edition publishes — the feature silently falls back to
`{status:"sample"}` and readers see bundled fixtures, not live data.

## Option A — keep manual publish (current)

Publish = `wrangler d1 execute keibamon-live --command "INSERT INTO weekly_report ..."`
run by hand on the Mac, against serialized `WeekendInput` JSON.

**Pros**
- **Zero auth attack surface.** The racing Worker has no write endpoints at all;
  there is no admin route to probe, brute-force, or token-replay. The Worker
  stays read-only (`GET /api/live`, `GET /api/weekly-report`, form `GET`s).
- **No new secret to manage.** No publish token, no Clerk role check, no
  rotating API key. D1 writes happen via `wrangler` + the existing `CF_*`
  account credentials, which already have a preflight.
- **Human-in-the-loop review.** The operator sees the `WeekendInput` before it
  ships — a last gate against publishing malformed/garbage data to a
  not-betting-advice surface.

**Cons**
- **Single-operator / single-host dependency.** No David at the Mac → no
  edition. This is the exact fragility profile that killed a race-day
  afternoon's capture.
- **Operational friction.** Two INSERTs per weekend, hand-built JSON; easy to
  skip on a busy week.
- **Cadence ceiling.** Can't scale to a second publisher or an automated
  Friday/Saturday pipeline without re-introducing a write path.

## Option B — authenticated publish endpoint

Add `POST /api/weekly-report` (and/or `PUT`) to the Worker, gated by an auth
check (a publish token or a Clerk role claim). A publisher script (Mac cron, or
later a second operator) PUTs the `WeekendInput`; the Worker validates + INSERTs.

**Pros**
- **Removes the presence dependency.** A launchd timer on the Mac (or any host
  with the token) can publish on a schedule; a second operator can publish from
  anywhere.
- **Unblocks an automated pipeline** — Friday/Saturday editions generated from
  the lake's graded-stakes races + JV-Link odds and pushed without a human at
  the keyboard.

**Cons**
- **Adds an auth surface the racing Worker does not currently have.** Every
  write endpoint is a place a bug or a leaked token can corrupt the
  not-betting-advice surface. A malformed-publish risk (garbage JSON reaching
  readers) moves from "operator eyeballs it" to "the validator must be airtight."
- **A secret to manage + rotate.** A publish token (or Clerk role enforcement)
  is a new long-lived credential; the social Worker already carries
  `CLERK_ISSUER`/`LIVE_BASE`, but the racing Worker is presently secret-free on
  the write side.
- **More code + tests.** Request validation, auth middleware, a rate limit, and
  a guardrail pass on the published input before INSERT.

## Recommendation

**Keep manual publish for now (Option A).** The cadence is one or two editions
per week — the friction is tolerable, and the zero-auth-surface posture is worth
more than the convenience until the feature has proven its value and a stable
`WeekendInput` shape.

## Trigger conditions for revisiting

Move to Option B (authenticated endpoint) when **any** of these becomes true:

1. **Publish cadence increases** — e.g. mid-week editions, daily refreshes, or
   more than two editions per weekend. At that point the manual friction is the
   bottleneck.
2. **A second publisher** — someone other than David needs to publish (a
   collaborator, an editor). Manual `wrangler` access implies full D1 write
   power, which is too broad to hand out; a scoped publish endpoint is safer.
3. **David traveling on a stakes weekend** — if a known graded-stakes weekend
   (Takarazuka Kinen, Arima Kinen, Tenno Sho) coincides with travel and no Mac
   is available, build the endpoint ahead of that weekend rather than miss the
   edition.
4. **Automated generation is ready** — once a pipeline can build a correct
   `WeekendInput` from the lake unattended, the manual INSERT is the only human
   step left; an authenticated endpoint closes the loop.

Until a trigger fires, the manual path is the decision. This memo exists so the
trade is recorded and the trigger is explicit, not ad-hoc.
