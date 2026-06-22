# CLI agent prompt — root-cause the Tokyo card truncation + re-prove against the DEPLOYED endpoint (ADR-0007)

> Runs on the **Mac** (mac-dev). Triggered by the verification layer. The R3
> handback claimed "36 races, jra-20260621-05-12 present, ¥2,160 proven." The
> verification layer independently fetched the DEPLOYED endpoint
> (https://keibamon.com/api/live?key=current, cache-busted) and found the
> OPPOSITE:
>   - published_at = 2026-06-22T13:08:12Z (your re-publish DID run), BUT
>   - the card is still ~32 races: Hakodate(02) R1–12 and Hanshin(09) R1–12
>     are complete, but Tokyo(05) stops at R8. jra-20260621-05-09…-05-12 are
>     ABSENT. There is no Tokyo R12 in production.
> So Task A did not actually fix anything (the timestamp advanced, the truncation
> remained), and Task B's proof was computed against a result block that the live
> endpoint does not serve. Your §4 self-check disagreed with production because it
> read a /tmp artifact, not the deployed URL.

```
You are fixing the Tokyo card truncation for real and re-proving the settlement
AGAINST THE DEPLOYED ENDPOINT. Read CLAUDE.md, the R1–R3 prompts, and your own
branch fix/adr-0007-partial-publish-resettlement. Run `python tools/whichdevice.py`
— mac-dev. Do not change settle.ts's resolver rules.

Hard evidence to reconcile (deployed, cache-busted, key=current):
  Hakodate jra-20260621-02-01..02-12  ✓ (12)
  Hanshin  jra-20260621-09-01..09-12  ✓ (12)
  Tokyo    jra-20260621-05-01..05-08  ✓ (8)  — 05-09..05-12 MISSING
  total ≈ 32, NOT 36. No 05-12. published_at 2026-06-22T13:08:12Z.

## Task 1 — Root-cause WHY Tokyo R9–R12 don't publish
Hakodate and Hanshin get all 12; Tokyo stops at 8. Instrument the publish path
and find the ACTUAL cause — do not guess. Distinguish:
  a. Discovery miss: did discover_card() (the day-index discovery, ADR-0004)
     return only 8 Tokyo races? (Then 05-09..05-12 were never enumerated.)
  b. Per-race failure: were 05-09..05-12 discovered but their result/entries
     fetch or parse threw, and the loop dropped them (or aborted the rest of the
     Tokyo card)?
  c. A cap/pagination/venue-ordering bug that stops Tokyo at 8.
Capture the real failure for 05-09..05-12 (log the discovery list and each
race's fetch/parse outcome). Fix the root cause so all 12 Tokyo races — including
05-12 with a full result block — are discovered AND published.

## Task 2 — Make the guard detect incompleteness instead of masking it
The R3 anti-shrink guard (should_skip_publish) allowed a 32-race re-publish over
a 32-race card, advancing the timestamp while Tokyo stayed broken — it HID the
problem. Strengthen it: gate completeness against the EXPECTED race count for the
day (the registered races discover_card knows about), and refuse-to-finalize OR
loudly flag a publish that is missing races that were registered for a venue.
"Not smaller than last time" is not "complete." A truncated card must be
detectable from the meta (e.g. a counts/expected vs published field).

## Task 3 — Verify ONLY against the deployed endpoint (no /tmp)
All evidence must come from the live Worker, not local files or your own build:
  curl -s 'https://keibamon.com/api/live?key=current' | jq '{published_at:.meta.published_at, n:([.races[].race_id]|length)}'
  curl -s 'https://keibamon.com/api/live?key=current' | jq '[.races[].race_id] | map(select(test("-05-")))'
Assert: published_at NEWER than 13:08:12Z, total = 36, and the Tokyo list runs
05-01..05-12. A /tmp file is NOT acceptable proof — the last two handbacks cited
/tmp and curl results that did not match what the deployed URL returns.

## Task 4 — Re-prove the won ticket against the genuinely-live block
Once 05-12 is in production:
  - Pull jra-20260621-05-12's `result` block FROM the deployed endpoint.
  - Run workers/social/src/settle.ts::resolveTicket(ticket, 300, result) for
    kb-mqnccwqh (wide, lines [10,15][10,1][10,12][10,5]).
  - Report state + returned, and compare to the D1 row. Do not hand-edit numbers.
  - Confirm the R3 re-settlement sweep re-evaluates kb-mqnccwqh against this real
    result (and advances/backfills its settle_result_hash).

## Task 5 — Keep re-settlement (Task C) separately mergeable
The R3 re-settlement work (sweep.ts hash + transitions, migration 0005, its
tests) is sound and may merge on its own — do NOT entangle it with the Task 1
producer fix. Split if needed so the verification layer can sign off C
independently of the still-open Tokyo root-cause.

## Constraints
- Task 1/2 are racing-tier (tools/jravan, src/keibamon_core). Don't touch
  settle.ts rules or the frontend shim. Keep PYTHONPATH=src pytest and the worker
  suite green. PIT intact. Commit on Mac. Secrets out of git.
- Do not report success from a local build or /tmp. The only acceptance signal is
  the deployed https://keibamon.com/api/live.

## Hand back to the verification layer
- The root cause for the Tokyo truncation (a/b/c above) with the captured
  evidence, and the fix.
- Deployed-endpoint proof: published_at (newer), 36 races, 05-01..05-12 present.
- The literal jra-20260621-05-12 result block as served by the deployed URL, plus
  the kb-mqnccwqh D1 row before/after — so the verifier re-runs resolveTicket.
Do NOT merge the producer fix until the verification layer confirms 05-12 on the
deployed endpoint.
```
