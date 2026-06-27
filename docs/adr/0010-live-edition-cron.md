# ADR-0010: Auto-publish a rolling live roundup edition via Worker Cron

- **Status:** Accepted — supersedes ADR-0009's "deferred manual publish" stance
- **Date:** 2026-06-27
- **Surface:** Racing Worker `scheduled` handler + Weekend Roundup read path

## Summary

Add a 5-minute Cloudflare Cron Trigger to the racing Worker that turns the
latest `live_snapshot` into a Weekend Roundup edition deterministically and
UPSERTs it as a single rolling row. **No LLM**, no new auth surface, no
public/admin write endpoint — the write stays internal to the scheduled
handler, and the deterministic generator (already on the read path) renders
the report.

This **supersedes** the trigger condition in ADR-0009 ("David traveling on a
stakes weekend / cadence pressure"). The manual Friday/Saturday INSERT path
stays available for milestone editions; the cron publishes a separate rolling
live version that joins the same `edition_key`.

## The decision

Every 5 minutes the Worker's `scheduled` handler:

1. Reads `live_snapshot` key=`current` from the `keibamon-live` D1.
2. Calls the pure `buildLiveEdition(snapshot, now)` helper
   (`src/reference/buildLiveEdition.ts`) which:
   - Filters the snapshot to graded (G1/G2/G3) races via the same NFKC + roman
     numeral grade ladder the app uses (`gradeClass`).
   - Returns `null` when no graded races are present (off-day → no-op).
   - Emits the existing `WeekendInput` race shape so the read-path generator
     consumes it unchanged.
3. UPSERTs the result into `weekly_report` at the **reserved version 90**
   (`LIVE_VERSION` constant) under the weekend's `edition_key` (ISO-week of
   the race date — e.g. `2026-W26`).

The read path (`src/reference/weekly.ts`) does
`ORDER BY edition_key DESC, version DESC`, so the live row at v90 surfaces as
the latest edition for the weekend, with manual v1/v2 rows retained beneath
for an immutable audit trail.

## Why this is safe (vs. ADR-0009 Option B)

ADR-0009 rejected the authenticated-publish endpoint because it added an auth
surface, a secret to manage, and a malformed-publish risk that moved from
"operator eyeballs it" to "the validator must be airtight." This decision
avoids ALL three:

- **No new auth surface.** The Worker still has zero write endpoints. The
  cron runs inside the Worker with `env.DB`; there is no HTTP route to probe,
  no token to leak, no admin role to enforce. The write path is unreachable
  from outside Cloudflare.
- **No new secret.** No `CLERK_ISSUER`, no publish token. The cron is
  registered in `wrangler.jsonc` and authenticates via the existing account
  credentials.
- **The validator IS airtight AND testable.** `buildLiveEdition` is a pure
  function: same inputs → byte-identical output. It's unit-tested at the
  boundary (graded filter, malformed payload → null, no-graded → null, runner
  count, snapshot-time stamping). The producer→snapshot→cron→report chain has
  no human-judgement step — every byte the Worker writes is the deterministic
  output of a tested function. A garbage snapshot degrades to a no-op
  (`null`), never to a garbage row.

## Rolling version vs. immutable milestones

The live row is a single **rolling** version (90) that the cron UPSERTs in
place. It never accumulates new versions, so:

- The audit trail of manual Friday/Saturday editions stays clean (v1, v2, …).
- The 5-minute cadence doesn't churn versions; one row per weekend is the
  steady state.
- The `RoundupView` edition selector sees one "Live" entry per weekend and N
  milestone entries beneath — readers pick the live one by default (it sorts
  first) but can browse the milestones.

`LIVE_VERSION=90` is the named constant in `src/reference/buildLiveEdition.ts`
and is referenced by both the scheduled handler and the read-path tests; bump
it (e.g. to 95) only with a coordinated test + ADR update.

## Dependency chain + freshness ceiling

```
netkeiba scrape (Mac, ~120s)
        ↓
publish_d1 → live_snapshot[current]
        ↓
Worker Cron (every 5 min)
        ↓
buildLiveEdition → UPSERT weekly_report[edition_key, v90]
        ↓
GET /api/weekly-report → frontend generateReport → RoundupView
```

**Freshness ceiling ≈ snapshot.published_at + 5 min.** The 5-minute cadence is
deliberately tighter than JRA's ~120s odds refresh so a published live edition
is never more than one cron tick behind the producer. The single-row UPSERT
means each tick is one D1 write — the cost is negligible (Cloudflare bills
per request, and the scheduled invocation counts as one).

Off-days are free: when `live_snapshot` is empty or carries no graded races,
`buildLiveEdition` returns `null` and the handler no-ops without writing.
Window-gating (restricting the cron to weekend JST hours) lives in code rather
than in the cron expression so the failure mode is "no-op mid-week" rather
than "never runs because the expression drifted."

## Honesty framing

The live edition is the SAME research framing the manual editions use — same
deterministic generator, same `sanitizeNarrative` banned-phrase scan
(`lib/guardrails`), same `not_advice_reminder`. The `buildLiveEdition` module
emits the input shape only; it carries no copy of its own, so there is nothing
new for the guardrail scan to police. Recreational research only — never
betting advice, never an edge claim.

## What stays manual

- **Friday/Saturday milestone editions** — still operator-run via
  `wrangler d1 execute` when a polished Friday-night (post-gates) or
  Saturday-midday snapshot deserves a permanent row. These versions are 1, 2,
  … and are never overwritten by the cron.
- **`buildLiveEdition`'s NAME_POLISH lookup** — the editorial bilingual
  name map for this weekend's graded stakes. Updated by hand as the weekend's
  feature races become known; falls back to the feed name when unmapped.

## Trigger conditions for revisiting

1. **Cron cadence becomes a cost concern.** At 5-min intervals this is ~288
   invocations/day per Worker. Revisit if a Cloudflare billing line item
   attributes non-trivial cost to it.
2. **The freshness ceiling is too coarse for race-day traders.** If the
   feature pivots to sub-minute odds commentary (a different surface than the
   roundup intends), add a dedicated real-time path; don't tighten this cron.
3. **The producer goes sub-120s.** Tighten the cron expression first; only
   add a second cron if the Producer and Worker Cron drift apart in cadence.

## Migration plan

This change is forward-only: the cron is registered on the next
`wrangler deploy`, and from that tick on the live row appears for whatever
the current weekend's graded stakes are. Existing `weekly_report` rows are
untouched (the handler only ever INSERTs/UPDATEs at version 90 under the
active edition_key). Roll back by removing the `triggers.crons` block and
redeploying — the live row stops refreshing immediately, and the manual
milestones continue to surface as before.

## Staleness guard (fast-follow)

`buildLiveEdition` refuses to build when `meta.published_at` is missing,
unparseable, or older than `MAX_SNAPSHOT_STALENESS_MS` (20 min — ~10× the JRA
~120s odds cadence). On a stalled producer the existing v90 row freezes in
place instead of being republished with stale odds under a fresh-looking
"auto-refreshed" label. The scheduled handler emits a `console.warn` only on
the stale case (distinct from the routine no-graded/off-day silent no-op) so
the stall is visible in `wrangler tail`.
