# CLI agent prompt — R2: official-result gating (審議) + late-race coverage (ADR-0007)

> Dev agent runs this on the **Mac** (mac-dev / racing tier). Verification layer
> (Claude in Cowork) checks the output. R2 closes the two residual risks the R1
> verification flagged: a provisional (審議) result auto-settling and then being
> overturned, and races that finish after the publish window never settling.

```
You are implementing R2 (ADR-0007 follow-up to R1). R1 landed the per-race
`result` block on /api/live and is verified/merged; the app's resolver + sweep
settle tickets from it. R1 v1 attaches a result whenever placings parse cleanly —
which has TWO known holes (documented in `adapters/jravan.DATA_TRAPS`):

  1. 審議 (inquiry) / 保留 (provisional): netkeiba can show PROVISIONAL placings
     before the order is official. R1 attaches them, so a ticket can auto-settle
     to "won", the user shares a HIT card, and then the placings change on
     adjudication. This is the only path to a visibly-wrong, shareable settlement.
  2. Result window: `tools/jravan/expose_live.py`'s race window ends 17:00 JST.
     A race that finishes late (or is confirmed after the window) never gets a
     result block — and the Phase-4 sweep reads /api/live, so it can't settle
     those either.

This is racing-tier work only. Run `python tools/whichdevice.py` first. Read
CLAUDE.md (PIT rules, DATA_TRAPS) and `src/keibamon_core/live/result.py` +
`tools/jravan/expose_live.py::_maybe_result` (the R1 code you are tightening).

## Goal
Never attach a result block until the race is OFFICIAL/確定, and make sure
late-finishing or late-confirmed races still get one.

## The resolver contract does NOT change
Do NOT touch `workers/social/src/settle.ts`, `frontend/`, or the `RaceResult`
shape. R2 only changes WHEN/WHETHER `result.py` emits a block — not its shape.

## Task 1 — Official-confirmation gate (the 審議 fix)
- Add a confirmation signal so `build_result` (or `_maybe_result`) returns no
  block while a race is provisional. Use the most reliable signal available on
  the netkeiba result page, in this order of preference:
    a. An explicit confirmed/inquiry status on the page (確定 vs 審議/保留/
       〇審) — scrape it in `adapters/netkeiba_results.py` and surface it.
    b. Failing a reliable status marker: require CONFIRMED PAYOUTS to be present
       before attaching. JRA withholds payouts until the order is official, so
       "payouts published" is a strong proxy for 確定. (This is a deliberate
       tightening of R1, which allowed placings-without-payouts.)
- Keep the per-line `source:'estimate'` fallback ONLY for a CONFIRMED race where
  a specific pool's payout row is missing — never as a reason to attach a
  provisional race. The gate is at the attach level; the estimate stays a
  within-confirmed-result detail.
- Idempotent overwrite: when a race goes 審議 → 確定 across publish cycles, the
  later confirmed block must overwrite cleanly (the producer already re-publishes
  under key='current').

## Task 2 — Late-race / after-hours coverage
- Ensure a race that finishes (or is confirmed) after the current race window
  still gets a result block on a subsequent run. Either widen the window for
  races whose `post_time` has passed but that lack a confirmed result, OR add a
  result-only cycle that runs after the main window and only fills `result`
  blocks for finished-but-unsettled races. Don't re-scrape entries/odds in that
  path — result only.
- Confirm the Phase-4 social-Worker sweep can settle these once /api/live
  carries the block (no Worker change expected — verify, don't modify).

## Task 3 (minor) — DQ placing assumption
- R1's docstring claims 失格/降着 "keeps gate-order placing." Verify against a
  real DQ/demotion result page that the placings you emit are the
  POST-adjudication official order (netkeiba shows the corrected order), and fix
  the comment/logic if not. Add a fixture.

## Provide for the verification layer (REQUIRED)
1. Fixtures: a 審議/provisional result page → `build_result` returns `{}`
   (no attach); the SAME race once 確定 → returns the full block; a DQ/降着 race
   → correct post-adjudication placings.
2. A test proving the provisional→confirmed transition: provisional cycle emits
   no block (race stays open), confirmed cycle emits and overwrites.
3. A note on which confirmation signal you used (status marker vs payouts-present)
   and why.

## Constraints
- Racing tier only. Resolver, Worker, and frontend untouched.
- PIT intact: still never attach pre-`post_time`; the 確定 gate is additional.
- Keep `PYTHONPATH=src python -m pytest -q` green; add tests for the gate, the
  transition, the late-race path, and the DQ fixture. New netkeiba quirks →
  `DATA_TRAPS`.
- Never commit secrets.

## Workflow
Branch `feat/adr-0007-r2-result-confirmation`. Small commits, commit on the Mac.
Hand back: diff scope, the fixtures, the confirmation-signal note, and a sample
provisional vs confirmed producer output. Do NOT merge — verification layer first.
```
