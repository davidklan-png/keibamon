# CLI agent prompt — #15: D1 results archive so the sweep can settle rotated-off races

> Runs on the **Mac** (mac-dev: wrangler auth, git). Prepared by the
> Cowork/Claude agent (sandbox) 2026-07-06; all paths/line numbers verified
> against the working tree that day. Fix direction was decided with David —
> **D1 results archive** (not snapshot retention, not a lake-side cron) —
> don't re-litigate.

```
Read CLAUDE.md first. Run `python tools/whichdevice.py` — MUST be mac-dev.
Verify branch is main and the tree is clean before starting.

## Problem (GitHub issue #15 — highest severity of the open backlog)

The 5-minute settlement cron (workers/social/src/sweep.ts, cron in
workers/social/wrangler.jsonc `"*/5 * * * *"`) settles tickets ONLY against
the current /api/live snapshot. That snapshot is a single D1 row
(`live_snapshot` WHERE key='current', served by src/worker.js ~line 57-82)
that the publisher OVERWRITES when next weekend's card goes up. Any ticket
still open at rotation is stranded open forever. This is structural, not a
one-off: it already bit real users (20 tickets, 2026-06-28 capture outage,
manually backfilled via workers/social/scripts/backfill-stuck-tickets.ts —
read that script and docs/prompts/backfill-stuck-june28-tickets.md for the
incident shape before designing).

## Decided fix — results archive in the social Worker's own D1

Settlement stops depending on the snapshot window. Three parts:

### STEP 1 — Migration: workers/social/migrations/0008_race_results.sql

New table, suggested shape (adjust names to repo convention, keep the intent):

  race_results(
    race_key    TEXT PRIMARY KEY,   -- same key raceKeyOf() builds in sweep.ts
    result_json TEXT NOT NULL,      -- the RaceResult block, verbatim
    result_hash TEXT NOT NULL,      -- hashResult() of result_json
    source      TEXT NOT NULL,      -- 'sweep' | 'backfill'
    archived_at INTEGER NOT NULL
  )

NOT write-once: R3 re-settlement (see sweep.ts header comment) means a result
can legitimately change (partial→complete, 確定 correction). Upsert: ON
CONFLICT(race_key) update result_json/result_hash/archived_at ONLY when the
hash differs.

### STEP 2 — sweep.ts: archive + second settlement pass

(a) ARCHIVE: for every snapshot race with status==='result' + a result block,
    upsert into race_results (hash-gated, so steady state is zero writes).
    Do this before settling, so a sweep that settles nothing still archives.

(b) FALLBACK PASS: after the existing snapshot-driven pass, SELECT tickets
    WHERE state='open' AND race_key NOT IN (snapshot result keys), join
    against race_results, and settle exactly as the snapshot path does
    (same resolveTicket/topPlacings/applySweepSettlement flow, same hash
    bookkeeping). Scope deliberately: OPEN tickets only — re-settlement of
    already-settled tickets stays snapshot-window-only, as today (line
    ~214-217's "left alone" comment becomes "left alone unless open").
    SWEEP_CAP must bound the TOTAL work across both passes. Keep the
    never-throws + idempotency contracts. Log lines should carry the source
    ("snapshot" vs "archive") so incident forensics can tell them apart.

### STEP 3 — Promote the backfill script into the standard recovery path

Rework workers/social/scripts/backfill-stuck-tickets.ts (or add a sibling,
your call) so a capture-outage recovery = "insert result rows into
race_results" (source='backfill') and let the NEXT SWEEP settle the tickets —
instead of patching ticket rows directly. Settlement logic then lives in
exactly one place. tools/jravan/backfill_20260628_results.py shows how result
blocks get built from the lake for this purpose. Update the script's header
docs to describe the new runbook.

### STEP 4 — Tests (workers/social/test/sweep.test.ts)

Cover at minimum:
  - sweep archives result races (and hash-gated upsert: same hash → no write,
    changed hash → row updated).
  - THE BUG: open ticket, race absent from snapshot, result present in
    archive → settles on next sweep. This is the regression test for #15.
  - open ticket, race absent from both → stays open, no crash.
  - SWEEP_CAP bounds combined passes; deferred flag still correct.
  - backfill-inserted row (source='backfill') settles identically.

## Verification (all green before commit)

  cd workers/social && npm run tsc && npx vitest run
    (ignore ONLY the known pre-existing social.test.ts cheer-dedupe failure,
     if it still exists)
  cd frontend && npx tsc --noEmit && npm test   (should be untouched)
  PYTHONPATH=src python -m pytest -q            (should be untouched)

## Deployment ordering (do not skip)

The migration must be applied to the REMOTE keibamon_social D1 BEFORE the new
Worker code deploys (sweep would 500-log on a missing table otherwise —
harmless given never-throws, but don't rely on it). Local: wrangler d1
migrations apply keibamon_social --local for tests. REMOTE apply + deploy are
David's sign-off — prepare the exact commands in the handback, don't run them
unprompted.

## Constraints
- Don't touch src/worker.js / the racing Worker or the publisher — this fix
  is entirely inside workers/social (that's the point: no new device or
  producer dependency in the settlement path).
- Don't change client-PATCH settlement (patchTicketState) semantics.
- Never print CF_* secrets.
- If SWEEP_CAP/one-query-per-pass turns out awkward in D1 (e.g. NOT IN with
  many keys), stop and report options rather than silently redesigning.

## Handback to the verifier (Cowork/Claude, sandbox)
Report: migration SQL, sweep.ts diff, script diff, full vitest output
(highlighting the rotated-off-race regression test), the remote-apply +
deploy command sequence for David, and commit list (use "Fixes #15" in the
final commit message). Do NOT mark done unless the regression test exists
and passes.
```
