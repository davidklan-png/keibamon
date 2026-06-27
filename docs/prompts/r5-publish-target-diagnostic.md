# CLI agent prompt — R5: why don't publishes reach keibamon.com? (D1 target vs guard)

> Mac (mac-dev). DIAGNOSTIC, not a feature build. Three rounds of handbacks have
> claimed the Jun 21 card is published/complete; the deployed endpoint
> `https://keibamon.com/api/live?key=current` has stayed frozen at
> `published_at=2026-06-22T13:08:12Z`, 32 races, Tokyo R1–R8, no `05-12`
> (verified independently, cache-busted, 3×). So a "successful" publish is not
> landing in what the Worker serves. Find out why. Only two suspects; prove which.

```
Run `python tools/whichdevice.py` — mac-dev. Do NOT add features or re-run a
publish and call it done. Your job is to locate why publishes don't reach
production and apply the MINIMAL fix. The ONLY accepted evidence of success is a
cache-busted curl of the live URL (see Hand-back). Local builds, /tmp files, and
the publisher's own "exit 0 / published 36" logs are NOT evidence — those have
been wrong every round.

Ground truth to reconcile:
  Worker binding (wrangler.jsonc): D1 `keibamon-live`,
    database_id 7b3cf063-a19a-4a6a-a42a-61d4879b2582, served from row key='current'.
  Deployed now: published_at 2026-06-22T13:08:12Z, total ~32, Tokyo truncated.

## Suspect 1 — write/read target mismatch
The publisher (tools/jravan/publish_d1.py) writes via the CF API using CF_* env.
If its database_id (or account, or key) isn't the one the Worker binds, every
"successful" publish writes to the wrong place and production never moves.
1. Print the publisher's RESOLVED target at runtime: CF account_id, database_id,
   and the row key it writes. Diff database_id against 7b3cf063-…; diff key
   against 'current'.
2. Read the Worker's DB directly (this is what the Worker will serve):
     npx wrangler d1 execute keibamon-live --remote \
       --command "SELECT key, json_extract(payload,'\$.meta.published_at') AS pub, json_extract(payload,'\$.meta.counts.total') AS total FROM live_snapshot"
   Does row key='current' show 13:08:12Z / ~32, or your claimed 22:14 / 36? Does
   a fresh publish change THIS row? If the publisher writes a different db/key
   than this query reads, that's the bug.

## Suspect 2 — the new guard is freezing production
R4's `should_skip_publish` refuses any venue below its floor. If discovery still
intermittently returns <12 for a venue, every such cycle is refused and
production stays at the last (truncated) write forever.
1. Run the ACTUAL publisher once, with the guard's decision logged: did it
   publish or skip, and the exact reason? Capture discover_card's per-venue
   counts on that run.
2. If it skipped: the guard is locking in the truncated card. If it published:
   re-run the Suspect-1 d1 execute to see whether the row actually advanced.

## Decide & fix (minimal)
- Publisher logs "published" but the `wrangler d1 execute` row stays 13:08 →
  Suspect 1 (wrong db/account/key). Fix the target to 7b3cf063-…/'current'.
- Publisher logs "skip (regressed venue)" → Suspect 2 (guard freeze on flaky
  discovery). Fix so a complete discovery actually publishes (retry-merge must
  reliably reach 12; the guard must not refuse a genuinely-complete card), and so
  the guard never permanently blocks once a complete card is available.
Apply only the fix the evidence points to. Don't touch settle.ts or the frontend.
Keep PYTHONPATH=src pytest green. Commit on Mac.

## Hand-back — the live curl, and nothing else
Paste the raw output of EXACTLY this, run by you at the end:

  curl -s "https://keibamon.com/api/live?key=current&_cb=$(date +%s)" \
    | jq '{published_at:.meta.published_at, total:([.races[].race_id]|length), tokyo:([.races[].race_id]|map(select(test("-05-")))|sort), has_05_12:([.races[].race_id]|any(.=="jra-20260621-05-12"))}'

Sign-off requires: published_at NEWER than 2026-06-22T13:08:12Z, total 36, tokyo
list 05-01..05-12, has_05_12 true. Plus ONE line naming which suspect was the
cause and the one-line fix. No other artifacts. If that curl doesn't show it,
the task is OPEN — do not hand back a pass.
```
