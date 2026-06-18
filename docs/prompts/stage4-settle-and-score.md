# CLI agent task: implement weekend stage 4 (settle + score the card)

You are working in the Keibamon repo on the **Mac (`mac-dev`)**. Read `CLAUDE.md`
and `docs/modeling-spine.md`, and run `python tools/whichdevice.py` to confirm
`mac-dev` before doing device-specific work; if not, stop. Use `venv64`.

## Context

The weekend pipeline (`docs/adr/0003-weekend-pipeline.md`) has stages 1-2 done.
Stage 4 ("settle") is the batch job that turns the frozen `model_card` (our
pre-market belief) plus the official results into the **calibration verdict** —
how, where, and by how much our model diverged from the market and from reality.
It is deliberately built before stage 3 (live capture) because it has no live
dependency.

This is **calibration measurement, not betting**. The lake's 6-for-6 null on
public-data edges stands; do not add a bet recommender or any profit claim. Settle
strictly at **official final payouts, never decision-time odds**
(`modeling-spine.md` step 1).

## The one decision to get right: do NOT mutate the frozen card

`curve_log` settles *in place* (result fields start NULL, filled at settle).
`model_card` is **immutable / append-only** (ADR-0003 D2): it has no result
columns and must never gain any. So stage 4 writes a **separate sibling table**
`model_card_settled`, keyed `(race_id, horse_number, card_version)`, that joins
the frozen belief to the outcome. The frozen card stays byte-identical forever;
the join lives elsewhere. Do not "just add finish_position to model_card."

## Step 1 — settle the curve log (reuse, don't reinvent)

Stage 4 first settles the market curve via the existing path — call into
`tools/jravan/settle_curve_log.py` / `ingestion.curve_log.settle_curve_records`.
Do not duplicate that logic; just invoke it for the weekend's races so both
artifacts (market curve + our card) are settled in one stage.

## Step 2 — new module `weekend/settle_card.py`

`settle_card(lake, race_ids, *, results=None) -> list[dict]`:

- **Read** the frozen `model_card` rows for the races via `lake_query` scoped to
  those `race_id`s (predicate pushdown, not a whole-table scan — CLAUDE.md).
- **Join to official results**: build `{(canonical_race_id, horse_number):
  (finish_position, final_odds)}` from the lake results, same shape
  `curve_log.settle_curve_records` already consumes. Carry the `posted_before_market`
  flag through from the frozen card.
- **Settle the model's top pick** as a hypothetical 1-unit win bet at official
  payouts: pick the highest-`model_p` runner per `(race_id, card_version)`, build a
  `settlement.Bet(race_id=..., pool="win", selection=<horse_number>)`, and settle
  the batch via `settlement.settle_many` (one connection, the batch path). Honor
  its refund/scratch handling — do not reconstruct payouts from odds.
- **Write** `model_card_settled` rows (append-only, mirroring `model_card`'s write
  discipline): the frozen-card key + `finish_position`, `won`, `top3`,
  `settle_odds`, `settled_payout`, plus the carried `posted_before_market`. Add a
  runtime assert that no `model_card` row was touched.

## Step 3 — calibration report `weekend/calibration.py`

A pure scoring function over settled rows (no I/O), following the honest-report
discipline in `modeling-spine.md` step 4:

- **Calibration bins**: observed win-rate vs mean `model_p`, per bin, with counts;
  flag thin bins, never flatter a sparse bucket.
- **Probability quality**: per-race winner log-loss + per-runner Brier of `model_p`,
  reported **against the de-vigged market** as the bar (the market is Model 0; a
  number that doesn't beat it is the expected null, and that's fine — we're
  measuring divergence, not claiming an edge).
- **Top-pick ROI** settled at official payouts vs the ~-0.23 win-takeout floor;
  print the count and required sample size when a slice is too thin.
- **Slice everything by `posted_before_market`** — clean pre-market cards are the
  headline; late/contaminated cards are reported separately, never blended in
  (ADR-0003 D3).

## Step 4 — implement `pipeline.settle`

Keep `_require_role(("mac-dev",), "settle", role_file)`. Wire: settle curve_log
(step 1) → `settle_card` (step 2) → `calibration` report (step 3). Return a
summary dict. Optionally project the report to D1 under a new key
(`model_card_calibration`) using the same best-effort, lake-first, CF_*-preflight
pattern as `pipeline.post` — never raise over the lake write (ADR-0003 D4).

## Step 5 — tests (`tests/test_settle_card.py`, keep suite green)

Follow `tests/test_curve_log.py` / `tests/test_model_card.py` fixture patterns:

- Settlement pays at the official payout row, not decision odds; a missing payout
  is a loss; a scratched single-runner win bet is a refund (use the DATA_TRAPS
  `horse_id='0000000000'` pair to prove refunds don't cross-match).
- `model_card` rows are byte-identical before and after `settle_card` (immutability).
- `posted_before_market` slicing keeps clean and contaminated rows in separate
  buckets; a thin bin is flagged, not silently averaged.
- Calibration math: a deterministic toy card with known finishes yields the
  expected log-loss / Brier / ROI.

Run: `PYTHONPATH=src ./venv64/bin/python -m pytest -q` — all green.

## Step 6 — commit (not pushed; standing instruction)

```
git add src/keibamon_core/weekend/settle_card.py src/keibamon_core/weekend/calibration.py \
        src/keibamon_core/weekend/pipeline.py tests/test_settle_card.py \
        docs/prompts/stage4-settle-and-score.md
git commit -m "weekend stage 4: settle_card + calibration report (immutable card, sibling settled table)"
```

## Guardrails

- Official payouts only; never settle at odds seen before the race.
- `model_card` stays immutable — results live in `model_card_settled`.
- No edge/profit claim; this is divergence measurement. PIT throughout.
- Don't weaken device guards; don't touch JV-Link. If a lake interface differs
  from this description, prefer the real code and note the deviation in the commit.
```
