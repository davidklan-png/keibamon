# CLI agent prompt — backfill 3 orphaned June 28 tickets + deploy the R5 placings column

> Runs on the **Mac** (mac-dev: real network access, wrangler auth, git).
> Goal: settle three specific tickets that never went through any settle path,
> and deploy the R5 schema change (result-breakdown `placings` column) that
> shipped alongside this investigation. The Cowork/Claude agent (sandbox) did
> the investigation, wrote the fix code, and verified it with the full test
> suite + a real-fixture parse smoke test — but could not reach netkeiba.com
> or Cloudflare from the sandbox, so the two network-dependent steps below
> are unverified against production and need to happen here.

```
You are finishing a fix that spans two independent pieces of work already
committed to this branch (or staged — check `git status` first):

  1. R5 (ships regardless of part 2): a `placings` column on the tickets
     table so settled tickets can show their actual finishing order, even
     after the race ages out of /api/live's rolling window. Touches
     workers/social/{migrations/0007_settlement_placings.sql,src/{index,
     settle,sweep}.ts}, frontend/src/{lib/{types,settle}.ts,
     screens/MyTickets.tsx,i18n/{en,ja}.ts,styles.css}.

  2. A one-time backfill for 3 tickets (kb-mqwyu29w, kb-mqwyu4ms,
     kb-mqwyueff) that settled_result_hash=NULL forever — every OTHER
     ticket on their exact same two races (20260628|Fukushima|11|ラジオNIK,
     20260628|Hakodate|11|函館記念) settled fine, so this isn't a "race
     never resolved" problem, it's 3 specific rows that fell through a gap
     between a 2026-07-03 manual lake backfill and the live cron sweep (a
     ~45min window that day where the two races were apparently absent from
     /api/live — same bug class as docs/prompts/r3-resettlement-and-publish-fix.md).
     /api/live no longer carries 2026-06-28 at all, so nothing else can ever
     reach these 3 rows again except a targeted re-fetch of the original
     result pages.

Read CLAUDE.md, docs/adr/0007-my-tickets-social-surface.md, and
workers/social/src/{settle,sweep}.ts before touching anything. Run
`python tools/whichdevice.py` — MUST be mac-dev. If not, stop.

## STEP 0 — Diagnose, report BEFORE changing anything
  - git status / git diff --stat — confirm what's already staged from the
    sandbox session (the files listed above) vs. what you need to do.
  - PYTHONPATH=src python -m pytest -q  — must be green before you start.
  - cd workers/social && npm run tsc && npx vitest run  — must be green
    (one PRE-EXISTING unrelated failure is expected and OK to ignore:
    test/social.test.ts "cheer dedupe" returns 409 instead of 200 — this
    failed before this session's changes too; do not spend time on it here,
    just confirm it's the ONLY failure).
  - cd frontend && npx tsc --noEmit && npm test — must be green (449 tests).
Print the report. Do not proceed until it's printed.

## STEP 1 — Deploy the R5 schema + code (unblocks all FUTURE settlements)
  1. cd workers/social
  2. npx wrangler d1 migrations apply keibamon_social --remote
     (then --local, per the project's usual two-step)
  3. npx wrangler deploy
  4. Confirm the deploy picked up sweep.ts + settle.ts + index.ts changes
     (check `npx wrangler deployments list` timestamp is fresh).
VERIFY: PATCH a test ticket's state via the API (or wait for the next cron
tick against any currently-open ticket) and confirm the `placings` column is
now populated in D1 for a freshly-settled ticket:
     npx wrangler d1 execute keibamon_social --remote \
       --command "SELECT id, placings FROM tickets WHERE state != 'open' ORDER BY created_at DESC LIMIT 5"
Don't proceed to Step 2 until this is deployed — Step 2's script imports
`../src/settle`, which is fine either way, but you want the sweep itself
fixed first so this whole bug class stops recurring going forward.

## STEP 2 — Re-fetch the two stuck races' official results (network, Mac-only)
  1. cd to repo root.
  2. PYTHONPATH=src python tools/jravan/backfill_20260628_results.py \
       --out /tmp/backfill_20260628_results.json
     This re-discovers the 2026-06-28 card and re-fetches + re-parses BOTH
     races' result.html pages using the SAME adapters
     (netkeiba_discovery/netkeiba_results/netkeiba_payouts/live.result) the
     production pipeline already uses — not a new code path. It is
     READ-ONLY: it writes only the output JSON, touches no ticket, no D1 row,
     no lake table. Verified in the sandbox against a real captured fixture
     (tests/fixtures/netkeiba/result_202609030411.html) that the parse
     pipeline itself works end-to-end; the venue/race_no MATCHING logic
     against the real day-index page is NOT yet verified against the real
     network (sandbox has no route to netkeiba.com) — that's what this step
     actually tests for the first time.
  3. If it prints "MISSING from day index" for either race: STOP. Do not
     guess or hand-construct a result block. Report back with what the day
     index actually returned for that venue/date instead (the venue-code
     lookup in the script's VENUE_CODE_JA map may need extending, or the
     race may need a manual netkeiba race_id lookup — either way, a human
     decision, not a silent script change).
VERIFY: eyeball the printed placings/payout counts for both races look like
a normal G3 (16-18ish placings entries would be wrong for a top-3-only
placings block — expect exactly the officially-placed runners, typically 3-5
entries covering ties, NOT the full field. Compare against the fixture output
above: 17 entries there because that race apparently carries dead-heat/DNF
detail down the whole field — use your judgment, but a suspiciously empty or
suspiciously huge placings list is worth a second look before Step 3).

## STEP 3 — Resolve the 3 tickets against the fetched results (dry run first)
  1. cd workers/social
  2. npm install --no-save tsx  (if not already available)
  3. npx tsx scripts/backfill-stuck-tickets.ts \
       --results /tmp/backfill_20260628_results.json
     This is a DRY RUN — it prints each ticket's current state, the computed
     outcome (won/miss/refunded + amount), the placings, the result hash, and
     the exact SQL it WOULD run. It does not write anything yet.
  4. Read the dry-run output carefully. For each of the 3 tickets, sanity
     check the computed outcome against what you'd expect given the placings
     (e.g. a trifecta ticket naming horses NOT in the top 3 should compute
     "miss"; the "wide" ticket on ラジオNIK should be checked against
     whichever pairs made the top 3). Cross-check against a SIBLING ticket on
     the same race that already settled (query D1 for
     race_key='20260628|Fukushima|11|ラジオNIK' AND state != 'open' — several
     exist) — the placings your script computes should be internally
     consistent with what those tickets already show for state/returned,
     since they settled against the same real result.
  5. Only once that checks out: re-run with --apply.
       npx tsx scripts/backfill-stuck-tickets.ts \
         --results /tmp/backfill_20260628_results.json --apply
VERIFY: 
     npx wrangler d1 execute keibamon_social --remote \
       --command "SELECT id, state, returned, placings, settle_result_hash FROM tickets WHERE id IN ('kb-mqwyu29w','kb-mqwyu4ms','kb-mqwyueff')"
All three should now show a non-open state, a non-null settle_result_hash,
and a populated placings array.

## Constraints
- Don't touch the racing lake / PIT rules / recommender. Keep
  PYTHONPATH=src python -m pytest -q and the worker/frontend suites green.
- The backfill script (Step 3) is hardcoded to exactly these 3 ticket ids —
  do not widen it into a general tool in this pass; if more stuck tickets
  turn up later, that's a follow-up, not scope creep here.
- Commit on the Mac. Never print secrets (CF_API_TOKEN, etc.) in logs.

## Handback to the verifier (Cowork/Claude, sandbox)
Report:
  - The Step 0 report (must be clean, modulo the known pre-existing
    social.test.ts failure).
  - Whether Step 2's venue/race_no match succeeded on the first try, and if
    not, what you had to change and why.
  - The full dry-run output from Step 3.4 and your sanity-check reasoning
    against the sibling tickets.
  - The final D1 row state for all 3 tickets after --apply.
  - Confirmation the R5 migration is applied + deployed (Step 1's verify).
Do NOT mark this done unless all 3 tickets show a settled state with a
populated placings array, and the sibling-ticket cross-check in 3.4 actually
matched (not just "the script ran without erroring").
```
