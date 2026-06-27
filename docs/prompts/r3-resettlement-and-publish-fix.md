# CLI agent prompt — fix truncated publish, re-verify settlement, add re-settlement (ADR-0007)

> Runs on the **Mac** (mac-dev). Triggered by the verification layer: after the
> go-live sync, production `/api/live` (published_at 2026-06-22T12:12:06Z) shows
> only **32 races** — Hakodate R1–12, Hanshin R1–12, but **Tokyo only R1–R8**.
> Tokyo R12 (`jra-20260621-05-12`) is MISSING, yet a stored ticket on that race
> is marked won/¥2,160. And the proof's placings (15→12→10) are impossible
> against the live data (umaban 10 and 15 never share a top-3 in any of the 32
> races). So the publish is incomplete AND the settlement is unproven/stale.

```
You are fixing three linked defects found by the verification layer. Read
CLAUDE.md, docs/adr/0007-my-tickets-social-surface.md, the R1/R2 prompts, and
workers/social/src/{settle.ts,sweep.ts}. Run `python tools/whichdevice.py` —
mac-dev. Don't change the resolver rules in settle.ts; match them.

Race id scheme: jra-YYYYMMDD-VV-RR. Venue 02=Hakodate, 05=Tokyo, 09=Hanshin.
Current /api/live: key='current', published_at 12:12:06Z, 32 races, Tokyo
truncated at R8.

## A. Fix the truncated / partial publish
1. Diagnose why key='current' holds an incomplete Tokyo card (R1–R8 only). Check:
   - Did the Jun 21 publish for venue 05 fail/timeout on R9–R12 (scrape error,
     rate limit, a race the parser choked on)?
   - Is a LATER publish overwriting a previously-complete card with a partial
     one? (i.e., a cycle that publishes whatever it scraped, clobbering 'current'
     even when it got fewer races than the prior payload.)
2. Re-run the full Jun 21 publish so ALL three venues × their full card are
   present, including Tokyo R9–R12. Idempotent.
3. Add a guard so a publish does NOT overwrite 'current' with a strictly smaller
   / less-complete card for the same date (don't let a partial cycle clobber a
   complete one). Document the rule.
VERIFY: curl -s https://keibamon.com/api/live | jq '[.races[].race_id] | length'
   and confirm jra-20260621-05-12 is present with a result block.

## B. Re-verify the won ticket against the REAL result
The stored ticket (social D1): type=wide, unit=¥300,
lines=[[10,15],[10,1],[10,12],[10,5]], currently state=won, returned=2160.
1. Pull the ACTUAL Tokyo R12 (jra-20260621-05-12) result block from /api/live
   once A is fixed.
2. Run it through workers/social/src/settle.ts::resolveTicket(ticket, 300,
   result). Report the true state + returned.
3. Compare to the stored D1 row. If they differ, the row is STALE/WRONG — that
   is the evidence motivating C. Either way, report the discrepancy honestly;
   do not "fix" the number by hand.

## C. Re-settlement on result change (the real bug)
Today settlement is a one-way latch: a ticket goes open→settled once and is never
re-evaluated. So a ticket settled against a partial/earlier/provisional result
stays frozen even after the result is corrected or completed (exactly what
happened here). Make settlement a PURE FUNCTION of (ticket, current result):
1. Record, per settled ticket, the identity of the result it settled against
   (e.g. a stable hash of the race's result block, or its placings+payouts).
   Add a column/field if needed (migration in workers/social/migrations).
2. In the sweep (workers/social/src/sweep.ts), for every race with
   status:'result', re-run resolveTicket for its tickets and, if the outcome OR
   the result-hash changed, UPDATE the ticket (state/returned) and log the
   transition (e.g. won→miss, miss→won, amount change, →refunded). Guard against
   thrash: only update when the new result-hash differs from the stored one.
3. Keep R2's 確定 gate authoritative — only official results attach, so
   re-settlement reconciles partial→complete and any rare 確定 correction, not
   provisional flapping.
4. Tests: a ticket settled against an OLD/partial result re-settles correctly
   when the corrected/complete result arrives (won→miss, miss→won, amount
   change). Keep all suites green.

## Constraints
- A is racing-tier (tools/jravan, src/keibamon_core); C is workers/social. Do
  NOT change settle.ts's resolution rules or the frontend resolver shim. Keep
  PYTHONPATH=src pytest and the worker suite green. PIT intact. Commit on Mac.
  Secrets stay out of git.

## Hand back to the verification layer (REQUIRED)
- The literal Tokyo R12 (jra-20260621-05-12) `result` block JSON, and the won
  ticket's stored D1 row before/after — so the verifier can re-run resolveTicket
  independently (last time the cited numbers did not reconcile).
- Confirmation that /api/live now has the complete Jun 21 card (32→full count)
  with jra-20260621-05-12 present.
- The re-settlement test output and a sample logged transition.
Do NOT merge — verification layer first.
```
