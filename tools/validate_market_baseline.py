"""Validate settlement and calibrated market baseline sanity checks.

Reports (each prints plainly if data is too thin, with the sample size needed
for a meaningful reading):

- **Settlement oracle**: scan every win/place payout row, settle the matching
  bet, and report the mismatch rate against the official payout. Done in ONE
  DuckDB scan via ``settle_many`` instead of one connection per bet.
- **Market takeout sanity**: under proportional staking (stake = 100 * prob per
  horse, total 100/race) the average return per race for an honestly calibrated
  market is approximately ``1 - takeout`` (JRA win takeout ≈ 23%). A profit
  here is a leakage alarm.
- **Calibration**: 10 probability bins, observed win-rate vs mean calibrated
  probability. Reports bin counts so thin bins are visible.
- **ROI by year / odds bucket / pool**: top-pick ROI sliced so a single hot
  bucket can't hide behind an aggregate. Each slice shows bets, ROI, hit rate.
- **Remove-top-N robustness**: how much of the edge survives dropping the N
  largest payoffs (small-sample fragility).

The validation harness can auto-build the market_baseline gold if it is missing
(see ``--build``); otherwise it points at the build command.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.backtest.predictors import (
    CalibratedMarketBaselinePredictor,
    DeviggedMarketBaselinePredictor,
)
from keibamon_core.backtest.roi import run_roi_backtest
from keibamon_core.ingestion.market_baseline import (
    MARKET_BASELINE_FEATURE_SET,
    build_market_probs,
    calibration_by_prob_bin,
    calibration_quality,
)
from keibamon_core.ingestion.settlement import Bet, settle_many
from keibamon_core.paths import LakePaths

# JRA win pool takeout is roughly 22-25%; a calibrated market's proportional-stake
# ROI should sit near this number. A reading > -0.10 (i.e. better than -10%)
# would be suspicious enough to re-check for leakage.
JRA_TAKEOUT_BOUNDS = (-0.30, -0.10)

# Minimum samples for a calibration / ROI slice to be reported with confidence.
# Below these we print the count and skip the metric.
MIN_CALIBRATION_BIN = 50
MIN_ROI_SLICE = 100


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--build",
        action="store_true",
        help="Rebuild market_baseline gold if missing before validating.",
    )
    parser.add_argument(
        "--settlement-sample",
        type=int,
        default=0,
        help="Cap settlement oracle at N win/place bets (0 = full audit).",
    )
    args = parser.parse_args()

    lake = LakePaths()
    if not lake.silver_dataset("jravan_payouts").exists():
        print("No jravan_payouts table found; build JRA-VAN payouts first.")
        return

    _settlement_oracle(lake, sample_cap=args.settlement_sample)

    gold = lake.gold_dataset(MARKET_BASELINE_FEATURE_SET)
    if not gold.exists():
        if args.build:
            print(f"Building {MARKET_BASELINE_FEATURE_SET} gold...")
            n = build_market_probs(lake)
            print(f"  -> {n:,} rows")
        else:
            print(
                f"No {MARKET_BASELINE_FEATURE_SET} gold dataset. Run "
                "`python -m keibamon_core.ingestion.market_baseline` first "
                "(or pass --build)."
            )
            return

    _market_takeout_sanity(lake)
    _calibration_report(lake)
    _calibration_quality_report(lake)
    _tail_calibration_report(lake)
    _roi_by_slice_report(lake)
    _top_payoff_robustness(lake)


def _settlement_oracle(lake: LakePaths, *, sample_cap: int) -> None:
    table = lake.silver_dataset("jravan_payouts")
    total = lake_query.query(
        f"SELECT COUNT(*) AS n FROM {lake_query.src(table)} WHERE pool IN ('win','place')"
    ).to_pylist()[0]["n"]
    limit_sql = "" if sample_cap <= 0 else f" LIMIT {int(sample_cap)}"
    rows = lake_query.query(
        f"""
        SELECT race_id, pool, combo, payout_yen
        FROM {lake_query.src(table)}
        WHERE pool IN ('win','place')
        ORDER BY race_id, pool, combo
        {limit_sql}
        """
    ).to_pylist()
    if not rows:
        print("Settlement oracle: 0 win/place payout rows sampled.")
        return

    bets = [Bet(r["race_id"], r["pool"], r["combo"], stake_yen=100) for r in rows]
    settlements = settle_many(lake, bets)
    mismatches = sum(
        1 for r, s in zip(rows, settlements, strict=True) if s.returned_yen != r["payout_yen"]
    )
    rate = mismatches / len(rows)
    print(
        "Settlement oracle: "
        f"audited {len(rows):,}/{total:,} win/place payout rows in one scan, "
        f"mismatches={mismatches:,} ({rate:.4%}). "
        "Any non-zero rate is a settlement bug."
    )


def _market_takeout_sanity(lake: LakePaths) -> None:
    rows = lake_query.query(
        f"""
        WITH joined AS (
            SELECT
                mb.race_id,
                mb.calibrated_market_prob,
                pay.payout_yen
            FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))} mb
            LEFT JOIN {lake_query.src(lake.silver_dataset("jravan_payouts"))} pay
              ON pay.race_id = mb.race_id
             AND pay.pool = 'win'
             AND CAST(pay.combo AS INTEGER) = mb.horse_number
        )
        SELECT
            COUNT(DISTINCT race_id) AS races,
            SUM(calibrated_market_prob * COALESCE(payout_yen, 0)) AS returned_per_100_race
        FROM joined
        """
    ).to_pylist()
    row = rows[0] if rows else {"races": 0, "returned_per_100_race": 0}
    races = row["races"] or 0
    if not races:
        print("Market takeout sanity: no overlapping market/payout races.")
        return
    roi = (row["returned_per_100_race"] / (100.0 * races)) - 1.0
    flag = "" if JRA_TAKEOUT_BOUNDS[0] <= roi <= JRA_TAKEOUT_BOUNDS[1] else "  *** OUTSIDE JRA TAKEOUT BAND -- check for leakage"
    print(
        "Market takeout sanity: "
        f"{races:,} races, proportional-stake ROI={roi:.3f} "
        f"(expected ≈ {JRA_TAKEOUT_BOUNDS[0]:.3f}..{JRA_TAKEOUT_BOUNDS[1]:.3f} net of JRA takeout)."
        f"{flag}"
    )


def _calibration_report(lake: LakePaths) -> None:
    """10 probability bins, observed win-rate vs mean calibrated probability.
    Reports per-bin counts so thin bins are visible (no flattering a sparse
    bucket)."""
    rows = lake_query.query(
        f"""
        SELECT
            calibrated_market_prob,
            CASE WHEN finish_position = 1 THEN 1 ELSE 0 END AS won
        FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))}
        WHERE calibrated_market_prob IS NOT NULL
          AND finish_position IS NOT NULL
        """
    ).to_pylist()
    if not rows:
        print("Calibration: no calibrated rows with results.")
        return

    bins = [(i / 10, (i + 1) / 10) for i in range(10)]
    print(
        f"Calibration: {len(rows):,} runner-rows. "
        f"prob-bin  runners  mean(p)  observed  delta"
    )
    for lo, hi in bins:
        bucket = [r for r in rows if lo < r["calibrated_market_prob"] <= hi]
        if not bucket:
            continue
        n = len(bucket)
        mean_p = mean(r["calibrated_market_prob"] for r in bucket)
        obs = mean(r["won"] for r in bucket)
        delta = obs - mean_p
        flag = "" if n >= MIN_CALIBRATION_BIN else "  (thin)"
        print(f"  ({lo:.1f},{hi:.1f}]  {n:>7,}  {mean_p:.3f}   {obs:.3f}   {delta:+.3f}{flag}")


def _calibration_quality_report(lake: LakePaths) -> None:
    """Out-of-sample probability quality: calibrated vs raw de-vigged market.

    Per-race winner log-loss (multinomial) and mean per-runner Brier, computed
    over the PIT gold columns. calibrated_market_prob uses a walk-forward beta
    fit only from prior settled races, so a lower calibrated loss is genuine OOS
    evidence the favorite-longshot correction earns its keep. If calibration does
    not help, Model 0 should drop to plain de-vigged probabilities.
    """
    rows = lake_query.query(
        f"""
        SELECT calibrated_market_prob, devigged_market_prob, finish_position
        FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))}
        WHERE calibrated_market_prob IS NOT NULL
          AND devigged_market_prob IS NOT NULL
          AND finish_position IS NOT NULL
        """
    ).to_pylist()
    q = calibration_quality(rows)
    if q is None:
        print("Calibration quality: no rows with a known winner.")
        return
    ll_delta = q.log_loss_delta
    helps = "calibration HELPS (beta earns its keep)" if ll_delta < 0 else (
        "calibration does NOT help -- consider plain de-vigged"
    )
    print(
        f"Calibration quality: {q.races:,} races / {q.runners:,} runners (OOS). "
        f"lower log-loss / Brier is better."
    )
    print(
        f"  devigged   log-loss={q.devigged_log_loss:.5f}  brier={q.devigged_brier:.5f}"
    )
    print(
        f"  calibrated log-loss={q.calibrated_log_loss:.5f}  brier={q.calibrated_brier:.5f}"
    )
    print(
        f"  delta (cal - devig): log-loss={ll_delta:+.5f}  brier={q.brier_delta:+.5f}  -> {helps}"
    )


# Fine low-end bins so the longshot tail (where favorite-longshot bias actually
# lives) is visible. Aggregate log-loss is favorite-dominated and cannot see it.
_TAIL_PROB_BINS = [
    (0.0, 0.01), (0.01, 0.02), (0.02, 0.03), (0.03, 0.05),
    (0.05, 0.10), (0.10, 0.20), (0.20, 0.40), (0.40, 1.0),
]
# Slices below this devigged prob are "the tail" the beta was designed to fix.
_TAIL_PROB_CUTOFF = 0.05


def _tail_calibration_report(lake: LakePaths) -> None:
    """Calibration sliced finely at the longshot tail.

    This is the gating check for retiring the favorite-longshot beta. Aggregate
    log-loss is dominated by favorites, so "no aggregate benefit" does not
    establish "no tail benefit" -- the bias classically lives at prob < ~0.05,
    where runners rarely win and thus contribute almost nothing to log-loss. We
    bin by devigged prob and ask, in the tail, whether calibrated is materially
    closer to the observed win-rate (and lower Brier) than devigged. Thin bins
    are flagged; no verdict is forced off a sparse slice.
    """
    rows = lake_query.query(
        f"""
        SELECT devigged_market_prob, calibrated_market_prob, finish_position
        FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))}
        WHERE devigged_market_prob IS NOT NULL
          AND calibrated_market_prob IS NOT NULL
          AND finish_position IS NOT NULL
        """
    ).to_pylist()
    bins = calibration_by_prob_bin(rows, _TAIL_PROB_BINS)
    print(
        "Tail calibration (bucketed by devigged prob; favorite-longshot bias lives at the low end): "
        "prob-bin  runners  mean(devig)  mean(cal)  observed  Brier(devig)  Brier(cal)"
    )
    tail_n = tail_cal_wins = 0
    tail_dev_brier = tail_cal_brier = 0.0
    for b in bins:
        if b.n == 0:
            continue
        thin = "  (thin)" if b.n < MIN_CALIBRATION_BIN else ""
        print(
            f"  ({b.lo:.3f},{b.hi:.3f}]  {b.n:>8,}  {b.mean_devigged:.4f}      "
            f"{b.mean_calibrated:.4f}    {b.observed:.4f}   {b.devigged_brier:.5f}      {b.calibrated_brier:.5f}{thin}"
        )
        if b.hi <= _TAIL_PROB_CUTOFF:
            tail_n += b.n
            tail_cal_wins += int(b.cal_helps_brier)
            tail_dev_brier += b.devigged_brier * b.n
            tail_cal_brier += b.calibrated_brier * b.n
    if tail_n == 0:
        print("  no tail rows (prob <= 0.05).")
        return
    delta = (tail_cal_brier - tail_dev_brier) / tail_n
    verdict = (
        f"calibration HELPS in the tail ({tail_cal_wins} of the tail bins have lower calibrated Brier; "
        f"mean Brier delta {delta:+.5f}) -- keep the beta"
        if delta < 0
        else f"no tail benefit (mean Brier delta {delta:+.5f}) -- beta is inert here too"
    )
    print(f"  tail (prob<={_TAIL_PROB_CUTOFF}): {tail_n:,} runners. {verdict}")


def _roi_by_slice_report(lake: LakePaths) -> None:
    """Top-pick win ROI sliced by year, odds bucket. Settled at OFFICIAL final
    payouts via ``settle_many`` -- never reconstructed from the pre-post odds
    snapshot (the gold's ``win_odds`` is the latest snapshot at/before post time,
    not the official payout, which carries JRA's 10-yen rounding and min-stake
    rules). Each slice prints bets/ROI/hit-rate; slices with too few bets print a
    thin warning with the required sample size rather than a flattering number."""
    rows = lake_query.query(
        f"""
        SELECT
            year,
            win_odds,
            calibrated_market_prob,
            finish_position,
            race_id,
            horse_number
        FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))}
        WHERE win_odds IS NOT NULL
          AND finish_position IS NOT NULL
        ORDER BY year, race_id, horse_number
        """
    ).to_pylist()
    if not rows:
        print("ROI-by-slice: no rows with odds + finish.")
        return

    # Pick the top-calibrated horse per race (Model 0 top selection).
    by_race: dict[str, list[dict]] = {}
    for r in rows:
        by_race.setdefault(r["race_id"], []).append(r)
    picks = [
        max(runners, key=lambda r: r["calibrated_market_prob"])
        for runners in by_race.values()
    ]

    # Settle the whole pick list in one scan at official final payouts.
    bets = [
        Bet(p["race_id"], "win", f"{int(p['horse_number']):02d}", stake_yen=100)
        for p in picks
    ]
    settlements = settle_many(lake, bets)
    for pick, s in zip(picks, settlements, strict=True):
        pick["_returned_yen"] = s.returned_yen
        pick["_won"] = s.payout_yen > 0

    print(f"ROI-by-slice: {len(picks):,} top-pick bets across {len(by_race):,} races (settled at official payouts).")
    _print_slice("by year", picks, key=lambda r: str(r["year"]))
    _print_slice(
        "by odds bucket",
        picks,
        key=lambda r: _odds_bucket(r["win_odds"]),
    )


def _print_slice(label: str, picks: list[dict], *, key) -> None:
    groups: dict[str, list[dict]] = {}
    for p in picks:
        groups.setdefault(key(p), []).append(p)
    print(f"  {label}:  group  bets   ROI    hit_rate")
    for k in sorted(groups):
        bucket = groups[k]
        n = len(bucket)
        if n < MIN_ROI_SLICE:
            print(
                f"    {k:>8}  {n:>5,}  (thin -- need ≥{MIN_ROI_SLICE:,} bets for a stable read)"
            )
            continue
        wins = sum(1 for p in bucket if p["_won"])
        returns = sum(p["_returned_yen"] for p in bucket)
        stakes = n * 100
        roi = returns / stakes - 1.0 if stakes else 0.0
        print(f"    {k:>8}  {n:>5,}  {roi:+.3f}  {wins / n:.3f}")


def _odds_bucket(odds: float) -> str:
    if odds < 2.0:
        return "<2.0"
    if odds < 5.0:
        return "2-5"
    if odds < 10.0:
        return "5-10"
    if odds < 30.0:
        return "10-30"
    return "30+"


def _top_payoff_robustness(lake: LakePaths) -> None:
    """Remove-top-N payoff robustness: how much of the top-pick ROI survives
    dropping the N largest payoffs. Reports the full backtest, then trimmed.

    The active Model 0 is the plain de-vigged market (the calibrated variant is
    measured inert on the win pool, aggregate and tail). Capacity-adjusted ROI
    applies a 0.2% pool-share haircut (matches the curve validator) so it is
    informative rather than a copy of the infinitesimal ROI.
    """
    print("Top-payoff robustness (DeviggedMarketBaselinePredictor = active Model 0, win pool):")
    report = run_roi_backtest(
        lake,
        DeviggedMarketBaselinePredictor(),
        pool="win",
        capacity_fraction=0.002,
    )
    if report.bets == 0:
        print("  no bets settled.")
        return
    print(
        f"  full: bets={report.bets:,}, stake={report.stake_yen:,.0f}, "
        f"returned={report.returned_yen:,.0f}, "
        f"infinitesimal_roi={report.infinitesimal_roi:+.3f}, "
        f"capacity_adjusted_roi={report.capacity_adjusted_roi:+.3f} (0.2% pool share), "
        f"hit_rate={report.hit_rate:.3f}"
    )
    print("  remove top payoffs:")
    for n, roi in sorted(report.remove_top_payoffs_roi.items()):
        if roi is None:
            print(f"    top {n}: insufficient bets after trim")
        else:
            print(f"    top {n}: ROI={roi:+.3f}")


if __name__ == "__main__":
    main()
