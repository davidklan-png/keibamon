"""Validate training-time features (HC slope + WC woodchip) against the market.

The bar: do final-furlong gallop times add out-of-sample signal beyond the
de-vigged win market? Report log-loss delta and disagreement-bucket ROI with
**race-day-clustered bootstrap CIs** — the key methodological addition. Races on
the same day share going/weather, so naive bootstrap CIs are too tight; clustering
by ``race_date`` accounts for this.

Runs the test per course (slope / woodchip / combined) and reports honestly if
the signal fails (training times are public — likely already priced).
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion.training_features import TRAINING_FEATURE_SET
from keibamon_core.paths import LakePaths

BOOTSTRAP_ITERS = 500
RNG_SEED = 20260615


@dataclass(frozen=True)
class CourseResult:
    label: str
    races: int
    runners: int
    baseline_log_loss: float
    enhanced_log_loss: float
    delta_log_loss: float
    delta_ll_ci_low: float
    delta_ll_ci_high: float
    bucket_stakes: int
    bucket_roi: float
    bucket_roi_ci_low: float
    bucket_roi_ci_high: float
    bucket_hit_rate: float


@dataclass
class ValidationResult:
    courses: list[CourseResult] = field(default_factory=list)
    verdict: str = ""


def main() -> None:
    lake = LakePaths()
    if not lake.gold_dataset(TRAINING_FEATURE_SET).exists():
        print(f"No {TRAINING_FEATURE_SET} gold dataset. Run build_training_features(lake) first.")
        return

    rows = _load_rows(lake)
    if len({r["race_id"] for r in rows}) < 50:
        print(
            f"Insufficient sample: {len({r['race_id'] for r in rows})} races / "
            f"{len(rows)} runners with training data. Need enough for era-aware splits."
        )
        return

    result = validate(rows)
    print("=" * 72)
    print("TRAINING-TIME FEATURE VALIDATION (HC slope + WC woodchip vs market)")
    print("=" * 72)
    for cr in result.courses:
        print(f"\n--- {cr.label} ---")
        print(f"  Races: {cr.races:,} | Runners: {cr.runners:,}")
        print(f"  Baseline log-loss (market only):  {cr.baseline_log_loss:.5f}")
        print(f"  Enhanced log-loss (+ training):    {cr.enhanced_log_loss:.5f}")
        print(
            f"  Delta: {cr.delta_log_loss:+.5f}  "
            f"[95% CI: {cr.delta_ll_ci_low:+.5f}, {cr.delta_ll_ci_high:+.5f}]"
        )
        sig = "SIGNIFICANT" if cr.delta_ll_ci_high < 0 else ("not significant" if cr.delta_ll_ci_low > 0 else "inconclusive")
        print(f"  Log-loss verdict: {sig}")
        print(
            f"  Top disagreement bucket: stakes={cr.bucket_stakes:,}, "
            f"ROI={cr.bucket_roi:+.3f}  "
            f"[95% CI: {cr.bucket_roi_ci_low:+.3f}, {cr.bucket_roi_ci_high:+.3f}]"
        )
        profitable = "PROFITABLE" if cr.bucket_roi_ci_low > -0.23 else ("not beating takeout" if cr.bucket_roi_ci_high < -0.23 else "inconclusive")
        print(f"  ROI verdict (bar: beat -23% takeout): {profitable}")
        print(f"  Hit rate: {cr.bucket_hit_rate:.3f}")
    print(f"\n{'=' * 72}")
    print(f"VERDICT: {result.verdict}")
    print("=" * 72)


def validate(rows: list[dict]) -> ValidationResult:
    from sklearn.linear_model import LogisticRegression

    df = pd.DataFrame(rows)
    df["winner"] = (df["finish_position"] == 1).astype(int)

    # De-vigged market prob from win odds (normalize within race)
    df["raw_implied"] = 1.0 / df["win_odds"].clip(lower=0.1)
    race_sum = df.groupby("race_id")["raw_implied"].transform("sum")
    df["market_prob"] = df["raw_implied"] / race_sum
    df["market_log_prob"] = np.log(df["market_prob"].clip(lower=1e-9))

    # Within-race z-scores for timing features (field-relative, like going_fit_z)
    for col in ("training_last_1f_recent", "training_last_1f_best_30d"):
        grp = df.groupby("race_id")[col]
        mean, std = grp.transform("mean"), grp.transform("std")
        df[f"{col}_z"] = ((df[col] - mean) / std.replace(0, np.nan)).fillna(0.0)
    # Acceleration is already a delta (improvement vs prior work)
    df["training_last_1f_accel"] = df["training_last_1f_accel"].fillna(0.0)
    df["training_days_since_work"] = df["training_days_since_work"].fillna(0.0)

    # Era-aware OOS split: 70/30 by (race_date, race_id) within era
    df["era"] = np.where(df["year"] >= 2023, "modern", "historical")
    test_races: set[str] = set()
    for _, era_df in df[["race_id", "race_date", "era"]].drop_duplicates().groupby("era"):
        ordered = era_df.sort_values(["race_date", "race_id"])
        cut = max(1, int(math.floor(len(ordered) * 0.7)))
        test_races.update(ordered.iloc[cut:]["race_id"])
    df["is_test"] = df["race_id"].isin(test_races)
    train = df[~df["is_test"]].copy()
    test = df[df["is_test"]].copy()

    baseline_cols = ["market_log_prob"]
    enhanced_cols = baseline_cols + [
        "training_last_1f_recent_z",
        "training_last_1f_accel",
        "training_last_1f_best_30d_z",
        "training_days_since_work",
    ]

    test["baseline_prob"] = _fit_probs(train, test, baseline_cols, LogisticRegression)
    test["enhanced_prob"] = _fit_probs(train, test, enhanced_cols, LogisticRegression)

    # Disagreement: enhanced edge over market
    test["disagreement"] = test["enhanced_prob"] / test["market_prob"].clip(lower=1e-9)
    threshold = test["disagreement"].quantile(0.75)

    result = ValidationResult()
    for label, mask_fn in (
        ("Combined (slope + woodchip)", lambda t: np.ones(len(t), dtype=bool)),
        ("Slope only (HC, 30yr)", lambda t: t["training_course_type"].eq("slope").to_numpy()),
        ("Woodchip only (WC, since 2021-08)", lambda t: t["training_course_type"].eq("woodchip").to_numpy()),
    ):
        mask = mask_fn(test)
        if mask.sum() < 50:
            continue
        cr = _evaluate_subset(test, mask, threshold)
        result.courses.append(replace(cr, label=label))

    # Honest verdict
    combined = next((c for c in result.courses if "Combined" in c.label), None)
    if combined:
        if combined.delta_ll_ci_high < 0 and combined.bucket_roi_ci_low > -0.23:
            result.verdict = (
                "Training times beat the market out of sample (log-loss CI excludes 0, "
                "ROI CI beats takeout). Edge confirmed."
            )
        elif combined.delta_ll_ci_low > 0:
            result.verdict = (
                "Training times HURT out of sample (log-loss CI > 0). No edge — "
                "the market already prices public training data efficiently."
            )
        else:
            result.verdict = (
                "Inconclusive: log-loss delta CI straddles zero. Training times show "
                "no reliable edge beyond the de-vigged market. (Expected: training "
                "times are public information.)"
            )
    return result


def _evaluate_subset(test: pd.DataFrame, mask: np.ndarray, threshold: float) -> CourseResult:
    sub = test.loc[mask].copy()
    baseline_ll = _race_log_loss(sub, "baseline_prob")
    enhanced_ll = _race_log_loss(sub, "enhanced_prob")
    delta_ll = enhanced_ll - baseline_ll

    bucket = sub[sub["disagreement"] >= threshold].copy()
    stakes = len(bucket)
    if stakes > 0:
        # TODO(low priority, dead null result): reconstructing returns from
        # winner * win_odds uses the pre-post odds snapshot, not the official
        # payout -- settle_many(lake, bets) against jravan_payouts is the
        # honest path (see validate_market_baseline._roi_by_slice_report).
        # Training features already measured inert, so not urgent.
        returns = (bucket["winner"].astype(float) * bucket["win_odds"].fillna(0.0)).sum()
        roi = (returns - stakes) / stakes
        hit_rate = float(bucket["winner"].mean())
    else:
        roi = 0.0
        hit_rate = 0.0

    # Race-day-clustered bootstrap CIs
    delta_ci = _clustered_bootstrap_delta_ll(sub, n_iter=BOOTSTRAP_ITERS)
    roi_ci = _clustered_bootstrap_roi(bucket, sub, threshold, n_iter=BOOTSTRAP_ITERS)

    return CourseResult(
        label="",  # set by caller
        races=int(sub["race_id"].nunique()),
        runners=len(sub),
        baseline_log_loss=baseline_ll,
        enhanced_log_loss=enhanced_ll,
        delta_log_loss=delta_ll,
        delta_ll_ci_low=delta_ci[0],
        delta_ll_ci_high=delta_ci[1],
        bucket_stakes=stakes,
        bucket_roi=roi,
        bucket_roi_ci_low=roi_ci[0],
        bucket_roi_ci_high=roi_ci[1],
        bucket_hit_rate=hit_rate,
    )


def _clustered_bootstrap_delta_ll(
    test: pd.DataFrame, n_iter: int = 500
) -> tuple[float, float]:
    """Cluster bootstrap by race_date: resample dates, recompute log-loss delta.

    Accounts for same-day going/weather correlation that naive bootstrap misses.
    Returns (2.5 percentile, 97.5 percentile) of the delta distribution.
    """
    rng = np.random.default_rng(RNG_SEED)
    # Precompute per-date: sum of -log(baseline_prob) and -log(enhanced_prob) for winners,
    # plus count of winners (one per race that has a winner).
    winners = test[test["winner"] == 1].copy()
    if winners.empty:
        return (0.0, 0.0)
    winners["neg_bl"] = -np.log(winners["baseline_prob"].clip(1e-12, 1.0))
    winners["neg_el"] = -np.log(winners["enhanced_prob"].clip(1e-12, 1.0))
    per_date = winners.groupby("race_date").agg(
        bl_sum=("neg_bl", "sum"), el_sum=("neg_el", "sum"), n=("race_id", "count")
    )
    dates = per_date.index.to_numpy()
    bl_sums = per_date["bl_sum"].to_numpy()
    el_sums = per_date["el_sum"].to_numpy()
    ns = per_date["n"].to_numpy()
    n_dates = len(dates)

    deltas = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        total_n = ns[idx].sum()
        if total_n == 0:
            deltas[i] = 0.0
            continue
        bl = bl_sums[idx].sum() / total_n
        el = el_sums[idx].sum() / total_n
        deltas[i] = el - bl

    return float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))


def _clustered_bootstrap_roi(
    bucket: pd.DataFrame, test: pd.DataFrame, threshold: float, n_iter: int = 500
) -> tuple[float, float]:
    """Cluster bootstrap by race_date for the disagreement-bucket ROI."""
    rng = np.random.default_rng(RNG_SEED + 1)
    if bucket.empty:
        return (0.0, 0.0)
    bucket_returns = (bucket["winner"].astype(float) * bucket["win_odds"].fillna(0.0)).to_numpy()
    bucket_dates = bucket["race_date"].to_numpy()

    # Per-date aggregation
    per_date_data = pd.DataFrame({"date": bucket_dates, "ret": bucket_returns, "stake": 1.0})
    per_date = per_date_data.groupby("date").agg(stakes=("stake", "sum"), ret=("ret", "sum"))
    dates = per_date.index.to_numpy()
    stakes_arr = per_date["stakes"].to_numpy()
    ret_arr = per_date["ret"].to_numpy()
    n_dates = len(dates)

    rois = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        s = stakes_arr[idx].sum()
        if s == 0:
            rois[i] = 0.0
            continue
        rois[i] = (ret_arr[idx].sum() - s) / s

    return float(np.percentile(rois, 2.5)), float(np.percentile(rois, 97.5))


def _fit_probs(train, test, cols, logistic_regression):
    model = logistic_regression(max_iter=1000, class_weight="balanced")
    model.fit(train[cols].to_numpy(), train["winner"].to_numpy())
    raw = model.predict_proba(test[cols].to_numpy())[:, 1]
    clipped = np.clip(raw, 1e-6, 1.0)
    denom = test.assign(_p=clipped).groupby("race_id")["_p"].transform("sum").to_numpy()
    return clipped / np.clip(denom, 1e-6, None)


def _race_log_loss(df: pd.DataFrame, prob_col: str) -> float:
    winners = df[df["winner"] == 1]
    return float(-np.log(np.clip(winners[prob_col].to_numpy(), 1e-12, 1.0)).mean())


def _load_rows(lake: LakePaths) -> list[dict]:
    training = lake.gold_dataset(TRAINING_FEATURE_SET)
    results = lake.silver_dataset("jravan_race_results")
    races = lake.silver_dataset("jravan_races")
    if not training.exists() or not results.exists() or not races.exists():
        return []

    sql = f"""
    SELECT
        tf.race_id,
        tf.horse_id,
        tf.horse_number,
        tf.training_last_1f_recent,
        tf.training_last_1f_accel,
        tf.training_last_1f_best_30d,
        tf.training_days_since_work,
        tf.training_works_count_30d,
        tf.training_course_type,
        rr.win_odds,
        rr.finish_position,
        tf.year,
        CAST(ra.race_date AS VARCHAR) AS race_date
    FROM {lake_query.src(training)} tf
    JOIN {lake_query.src(results)} rr
      ON rr.race_id = tf.race_id
     AND rr.horse_id = tf.horse_id
     AND (rr.horse_number IS NULL OR rr.horse_number = tf.horse_number)
    JOIN {lake_query.src(races)} ra
      ON ra.race_id = tf.race_id
    WHERE rr.finish_position IS NOT NULL
      AND rr.win_odds IS NOT NULL
      AND tf.training_last_1f_recent IS NOT NULL
    """
    table = lake_query.query(sql)
    return table.to_pylist()


if __name__ == "__main__":
    main()
