# Modeling spine — settlement, market baseline, ROI

This is the spine every signal is judged against. Each step is non-negotiable;
relaxing any one of them flatters backtests with leakage or look-ahead.

## 1. Settlement at official final payouts (never odds)

Pari-mutuel bets settle at the official JRA payout table for the pool, never at
the decimal odds visible at decision time.

- Source of truth: silver `jravan_payouts` (one row per winning combo per pool).
- `ingestion/settlement.py` looks up the matching `(race_id, pool, combo)` row
  and scales `payout_yen * stake_yen / 100`. Dead-heats collapse to the larger
  payout per combo (matching the prior `ORDER BY payout_yen DESC LIMIT 1`).
- Missing payouts are a loss, unless the bet is a single-runner win/place bet
  whose runner is in entries but absent from results -- that is a scratch/refund.
- The refund check joins `entries` to `results` on `(race_id, horse_id)` AND
  `horse_number` when available, so two placeholder-id horses in the same race
  cannot cross-match and hide a refund (DATA_TRAPS['SE.ketto_num=0000000000']).
- Why not reconstruct from odds: the takeout, dead-heat rules, and special
  payout cases (e.g. 1-2-3 finish refunds) are encoded in the official row but
  not in the decimal odds.

### Batch API

`settle(lake, bet)` opens a fresh connection per call (~12 ms/bet). For
backtests or full payout audits use `settle_many(lake, bets)` -- one connection,
one payouts scan, resolves the whole list in memory (~0.08 ms/bet, ~150x
speedup). The ROI backtest uses the batch path so its cost is dominated by the
walk over gold feature rows, not by per-race settlement.

## 2. Calibrated market baseline (Model 0)

The market is the bar every signal must beat. Three steps, in order:

1. **De-vig within race** (`raw_implied_prob / SUM(raw_implied_prob) OVER race`).
   Raw `1/odds` sums to >1 because of the track takeout. Comparing a model to
   the un-de-vigged market compares to an overconfident baseline -- meaningless.
2. **Favorite-longshot beta** fit walk-forward only on prior settled races.
   Beta rescales probabilities (`p ** beta`, renormalized) to correct the
   favorite-longshot bias. A global beta fit on the whole sample leaks winner
   information into the calibration of past races.
3. **Result-gated history**: beta is rebuilt only from races whose
   `result_available_at <= as_of_time` of the race being scored. This is a
   stricter gate than "race_date <= race_date" -- it accounts for the delay
   between a race running and its official result becoming available.

The grid search minimizes in-sample log-loss on the calibration window itself.
This is empirical-Bayes shrinkage, not held-out evaluation -- each row's
`calibrated_market_prob` is the model's pre-race belief given everything known
before post, and the validation harness judges it on later races the fit has
never seen.

Every gold row carries the columns honest evaluation needs without re-deriving
them from raw odds: `raw_implied_prob`, `devigged_market_prob`, `market_beta`,
`calibrated_market_prob`, `as_of_time`, `max_source_available_at` (with
`max_source_available_at <= as_of_time` asserted before any row is written).

CLI: `python -m keibamon_core.ingestion.market_baseline` rebuilds the gold.

### Empirical result (2026-06-16, 9,821 races): the beta earns no OOS benefit

`market_baseline.calibration_quality` measures Model 0's out-of-sample probability
quality: per-race winner log-loss + per-runner Brier, calibrated vs devigged. On
the local lake the walk-forward beta does **not** help — calibrated log-loss
1.91558 vs devigged 1.91484 (delta **+0.00074**, i.e. marginally worse) and Brier
within 0.00001. The JRA win market is already near-perfectly calibrated in the
dense bins (0.0–0.4, observed-vs-predicted within ±0.007), so the favorite-longshot
correction has nothing material to fix.

Aggregate log-loss is favorite-dominated (longshots rarely win, so their
contribution to log-loss is tiny). The honest test of "the beta earns its keep"
is the longshot tail. `market_baseline.calibration_by_prob_bin` slices finely at
the low end (0.01-wide bins under 0.05, then 0.05/0.10/0.20/0.40 bands). On the
same local lake the tail verdict is also null — over 81,270 runner-rows at
devigged prob ≤ 0.05, mean Brier delta **+0.00000** (every tail bin has calibrated
Brier ≥ devigged). Critically, JRA shows no classic favorite-longshot bias in
this sample: the extreme tail (0,0.01] observes a win-rate **below** the devigged
probability, and the beta moves probabilities the wrong way. The correction is
inert on the win pool, aggregate and tail.

**Active baseline**: `DeviggedMarketBaselinePredictor` scores by
`devigged_market_prob` and is the default Model 0 for win/place ROI. The
`CalibratedMarketBaselinePredictor` and the entire walk-forward beta machinery
are retained — but inert on the win pool. Deletion is held because the
exotic-pricing frontier (trifecta/trio) compounds probabilities across the field,
where a residual bias correction may yet matter even when the win pool itself is
already calibrated. The diagnostic re-runs on every validation so the moment the
verdict flips (different pool / more data / exotic payoff) it is visible.

## 3. ROI backtest

`backtest/roi.py:run_roi_backtest` walks gold features in `as_of_time` order,
scores each race with a predictor, picks the top horse, and settles the bet in
one batch via `settle_many`.

- **PIT leak guard** per row: `max_source_available_at <= as_of_time` and
  `as_of_time <= race's decision time`. A corrupted feature file raises
  `LeakageError` before any ROI is reported.
- **Infinitesimal ROI**: gross return / total stake - 1. Assumes a bet size
  small enough not to move the pool.
- **Capacity-adjusted ROI**: gross * (1 - capacity_fraction) / stake - 1. A
  simple pool-impact haircut for non-infinitesimal bet sizes.
- **Remove-top-N robustness**: drops the N largest payoffs before recomputing
  ROI, so a single lottery ticket can't mask a thin sample.

JRA win takeout is ~23%. A top-pick ROI meaningfully better than -0.23 is the
bar to clear; anything less is no edge.

## 4. What an honest validation report contains

`tools/validate_market_baseline.py` is the template:

- **Settlement oracle**: audit EVERY win/place payout row, report mismatch rate
  (must be 0.0000%). Done in one scan via `settle_many`.
- **Market takeout sanity**: proportional-stake ROI should sit in the JRA
  takeout band. A profit here is a leakage alarm.
- **Calibration**: 10 probability bins, observed win-rate vs mean calibrated
  probability, per-bin counts. Thin bins are flagged; no flattering a sparse
  bucket.
- **Calibration quality (OOS)**: per-race winner log-loss + per-runner Brier,
  calibrated vs devigged. The honest verdict on whether the walk-forward beta
  earns its keep on the aggregate; if it does not (current local result), Model 0
  drops to plain de-vigged as the active baseline.
- **Tail calibration**: probability-bin slices at the longshot end (where
  favorite-longshot bias actually lives). Aggregate log-loss is favorite-dominated
  and cannot see tail behaviour; the tail slice is the only check that tests what
  the beta was designed to fix. Current local result: no tail benefit either.
- **ROI by year / odds bucket**: top-pick ROI sliced so a single hot slice
  can't hide behind an aggregate. Slices below the minimum sample size print
  the count and the required sample volume.
- **Remove-top-N robustness**: full backtest plus trimmed.

If the sample is too thin, the script prints that plainly with the volume
needed and skips the metric. No flattering numbers off leaky or sparse samples.
