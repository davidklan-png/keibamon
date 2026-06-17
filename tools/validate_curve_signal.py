"""Validate the odds-curve signal against the market-at-time-t baseline.

The question this validator answers (different from the old strawman "does
picking the firming horse make money"):

    Does open->t odds movement add predictive information beyond the price
    already showing at decision time t?

If no, the curve is fully priced-in by t -- a fourth honest null, and the
verdict pivots to exotics. The bar is the same one mining, going and training
were held to: race-day-clustered bootstrap CIs on log-loss delta vs
market@t, disagreement-bucket ROI at official payouts, and remove-top-N
robustness. No best-cell picking -- all 9 cells are reported (3 decision
times x 3 going cells), with the overall cell as the headline.

Market@t (critical subtlety)
----------------------------
The baseline is ``odds_curve.devigged_prob_at_t`` from the curve gold -- the
within-snapshot de-vig at the latest odds row with ``available_at <= as_of_time``.
The validator NEVER touches ``market_baseline`` gold, which carries final-odds
de-vig (would be leakage). ``market_log_prob = LN(devigged_prob_at_t)``.

Settlement
----------
Disagreement-bucket ROI settles at official final payouts via ``settle_many``
-- never reconstructed from the pre-post ``win_odds_at_t`` (the gold snapshot,
not the payout, which carries JRA 10-yen rounding / min-stake rules). Per-bet
returns are computed once for the whole test set, then each cell's
disagreement bucket selects from the pre-settled rows.
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion.curve_features import CURVE_FEATURE_SET
from keibamon_core.ingestion.settlement import Bet, settle_many
from keibamon_core.paths import LakePaths

# Cluster bootstrap configuration. Races on the same day share going/weather,
# so naive i.i.d. bootstrap CIs are too tight; clustering by ``race_date``
# accounts for the correlation.
BOOTSTRAP_ITERS = 500
RNG_SEED = 20260617

# Honest-sample thresholds. Below these we print the count and skip the metric
# rather than report a flattering number off a tiny sample.
MIN_RACES_FOR_ROI = 200
MIN_RACES_PER_DECISION = 100
MIN_RACES_FOR_CI = 50

# JRA win takeout ~23%; ROI > -0.23 is the bar to clear net of takeout.
JRA_TAKEOUT = -0.23

# Per-cell odds-bucket ROI slices (per project memory).
ODDS_BUCKETS = [(0.0, 2.0, "<2.0"), (2.0, 5.0, "2-5"), (5.0, 10.0, "5-10"),
                (10.0, 30.0, "10-30"), (30.0, math.inf, "30+")]

# Curve features (beyond market_log_prob) the enhanced model gets.
CURVE_FEATURE_COLS = [
    "drift_open_to_t",       # open -> t log-drift (the "is the market shortening" signal)
    "recent_velocity",       # d(log_odds)/dt over last 2 snapshots, per minute
    "recent_acceleration",   # change in velocity over last 3 snapshots
    "odds_rank_change",      # open_odds_rank - odds_rank_at_t
    "odds_volatility",       # STDDEV(log_odds) across snapshots used
    "market_entropy_at_t",   # within-snapshot entropy at t (context)
]


@dataclass(frozen=True)
class CellResult:
    """One cell of the 3x3 (going_cell x decision_time) matrix."""
    going_cell: str            # "All" | "Stable" | "Transition"
    decision_minutes: int | None  # None = collapsed across decision times
    races: int
    runners: int
    baseline_log_loss: float
    enhanced_log_loss: float
    delta_log_loss: float
    delta_ll_ci_low: float
    delta_ll_ci_high: float
    baseline_brier: float
    enhanced_brier: float
    delta_brier: float
    bucket_stakes: int
    bucket_roi: float
    bucket_roi_ci_low: float
    bucket_roi_ci_high: float
    bucket_hit_rate: float
    remove_top_roi: dict[int, float] = field(default_factory=dict)
    odds_bucket_roi: dict[str, tuple[int, float]] = field(default_factory=dict)
    thin: bool = False         # too few races for a stable read
    thin_reason: str = ""


@dataclass
class ValidationResult:
    overall: CellResult | None = None
    cells: list[CellResult] = field(default_factory=list)
    n_races: int = 0
    n_runners: int = 0
    decision_points: list[int] = field(default_factory=list)


def main() -> None:
    lake = LakePaths()
    if not lake.gold_dataset(CURVE_FEATURE_SET).exists():
        print(
            f"No {CURVE_FEATURE_SET} gold dataset. "
            "Run `python -m keibamon_core.ingestion.curve_features` first."
        )
        return

    rows = _load_rows(lake)
    if not rows:
        print("No rows with odds + finish + results in the curve gold.")
        return

    races = {r["race_id"] for r in rows}
    decisions = sorted({int(r["decision_minutes_to_post"]) for r in rows})
    print(
        f"Odds-curve gold (joined to results + going): "
        f"{len(races):,} races, {len(rows):,} runner-decision rows, "
        f"decision points = {decisions}"
    )

    if len(races) < MIN_RACES_FOR_ROI:
        print(
            "Insufficient sample for an honest read: "
            f"{len(races)} races < {MIN_RACES_FOR_ROI} required. "
            "Coverage is gated on the JRA-VAN live entitlement (ADR-0002). "
            "No metrics reported."
        )
        _per_decision_thin_report(rows)
        return

    result = validate(rows, lake)

    _print_report(result)


def validate(rows: list[dict], lake: LakePaths) -> ValidationResult:
    """Fit the model once on all train rows, evaluate per cell."""
    from sklearn.linear_model import LogisticRegression

    # PIT belt-and-braces: the gold build already asserts this, but a row that
    # somehow leaked a post-decision snapshot would silently corrupt the fit.
    # ``_load_rows`` already filters; this is defense for direct callers.
    rows, pit_dropped = _filter_pit_rows(rows)
    if pit_dropped:
        print(
            f"WARNING: validate() dropped {pit_dropped} PIT-violating row(s) "
            "(max_source_available_at > as_of_time)."
        )

    df = pd.DataFrame(rows)

    df["winner"] = (df["finish_position"] == 1).astype(int)

    # Market@t log-prob -- the baseline. Computed from devigged_prob_at_t
    # (within-snapshot de-vig at latest row <= as_of_time), NEVER from
    # market_baseline gold (final-odds de-vig, would leak).
    df["market_prob"] = df["devigged_prob_at_t"].astype(float)
    df["market_log_prob"] = np.log(df["market_prob"].clip(lower=1e-9))

    # Fill NULL curve features with neutral values (the model needs a complete
    # matrix; NULLs mean "not enough snapshots" -- the market price already
    # encodes that information).
    for col in CURVE_FEATURE_COLS:
        df[col] = df[col].fillna(0.0)

    # Era-aware OOS split: 70/30 by (race_date, race_id) within era, year >=
    # 2023 modern. Same protocol as the training validator.
    df["era"] = np.where(df["year"] >= 2023, "modern", "historical")
    test_races: set[str] = set()
    for _, era_df in df[["race_id", "race_date", "era"]].drop_duplicates().groupby("era"):
        ordered = era_df.sort_values(["race_date", "race_id"])
        cut = max(1, int(math.floor(len(ordered) * 0.7)))
        test_races.update(ordered.iloc[cut:]["race_id"])
    df["is_test"] = df["race_id"].isin(test_races)
    train = df[~df["is_test"]].copy()
    test = df[df["is_test"]].copy()

    # One model fit on all train rows (across decision times). Grouping for
    # within-market renorm is (race_id, decision_minutes_to_post) -- each
    # (race, decision) is a separate market.
    test["_market_key"] = (
        test["race_id"].astype(str) + ":" + test["decision_minutes_to_post"].astype(str)
    )
    train["_market_key"] = (
        train["race_id"].astype(str) + ":" + train["decision_minutes_to_post"].astype(str)
    )

    baseline_cols = ["market_log_prob"]
    enhanced_cols = baseline_cols + CURVE_FEATURE_COLS

    test["baseline_prob"] = _fit_probs(train, test, baseline_cols, LogisticRegression)
    test["enhanced_prob"] = _fit_probs(train, test, enhanced_cols, LogisticRegression)
    test["disagreement"] = test["enhanced_prob"] / test["market_prob"].clip(lower=1e-9)

    # Settle ALL test bets once at official payouts. Per-bet returns are
    # independent of which cell's disagreement bucket selects them, so this
    # single pass feeds every cell's ROI/bootstrap.
    test["_returned_yen"] = _settle_test_returns(lake, test)

    # Overall headline cell: all test rows.
    overall = _evaluate_cell(
        test, going_cell="All", decision_minutes=None, mask=np.ones(len(test), dtype=bool)
    )

    # 3x3 matrix: (All / Stable / Transition) x each decision time.
    cells: list[CellResult] = []
    decision_points = sorted(test["decision_minutes_to_post"].unique().tolist())
    for going_cell, going_mask_fn in (
        ("All", lambda t: np.ones(len(t), dtype=bool)),
        ("Stable", lambda t: (~t["going_transition"].astype(bool)).to_numpy()),
        ("Transition", lambda t: t["going_transition"].astype(bool).to_numpy()),
    ):
        for dm in decision_points:
            dm_mask = (test["decision_minutes_to_post"] == dm).to_numpy()
            mask = going_mask_fn(test) & dm_mask
            cells.append(
                _evaluate_cell(
                    test, going_cell=going_cell, decision_minutes=int(dm), mask=mask
                )
            )

    return ValidationResult(
        overall=overall,
        cells=cells,
        n_races=int(df["race_id"].nunique()),
        n_runners=len(df),
        decision_points=[int(d) for d in decision_points],
    )


def _evaluate_cell(
    test: pd.DataFrame,
    *,
    going_cell: str,
    decision_minutes: int | None,
    mask: np.ndarray,
) -> CellResult:
    """Compute all metrics for one (going_cell, decision_time) cell."""
    sub = test.loc[mask].copy()
    n_races = int(sub["race_id"].nunique())
    n_runners = len(sub)
    label = _cell_label(going_cell, decision_minutes)

    thin_reason = ""
    if n_races == 0:
        thin_reason = "no rows in cell"
    elif decision_minutes is None and n_races < MIN_RACES_FOR_ROI:
        thin_reason = f"need >= {MIN_RACES_FOR_ROI} races for overall ROI"
    elif decision_minutes is not None and n_races < MIN_RACES_PER_DECISION:
        thin_reason = f"need >= {MIN_RACES_PER_DECISION} races for per-decision ROI"
    elif going_cell == "Transition" and n_races < MIN_RACES_FOR_ROI:
        # Transition is intrinsically thin; print counts but don't fabricate.
        thin_reason = f"need >= {MIN_RACES_FOR_ROI} transition races for ROI"

    if n_races == 0 or n_races < MIN_RACES_FOR_CI:
        return CellResult(
            going_cell=going_cell,
            decision_minutes=decision_minutes,
            races=n_races,
            runners=n_runners,
            baseline_log_loss=float("nan"),
            enhanced_log_loss=float("nan"),
            delta_log_loss=float("nan"),
            delta_ll_ci_low=float("nan"),
            delta_ll_ci_high=float("nan"),
            baseline_brier=float("nan"),
            enhanced_brier=float("nan"),
            delta_brier=float("nan"),
            bucket_stakes=0,
            bucket_roi=float("nan"),
            bucket_roi_ci_low=float("nan"),
            bucket_roi_ci_high=float("nan"),
            bucket_hit_rate=float("nan"),
            thin=True,
            thin_reason=thin_reason or f"need >= {MIN_RACES_FOR_CI} races for CI",
        )

    baseline_ll = _race_log_loss(sub, "baseline_prob")
    enhanced_ll = _race_log_loss(sub, "enhanced_prob")
    delta_ll = enhanced_ll - baseline_ll
    delta_ci = _clustered_bootstrap_delta_ll(sub, n_iter=BOOTSTRAP_ITERS)

    baseline_brier = _brier(sub, "baseline_prob")
    enhanced_brier = _brier(sub, "enhanced_prob")

    # Disagreement bucket = top quartile of enhanced/market within this cell.
    threshold = sub["disagreement"].quantile(0.75)
    bucket = sub[sub["disagreement"] >= threshold].copy()
    bucket_n = len(bucket)
    if bucket_n > 0 and bucket["_returned_yen"].notna().any():
        returns = bucket["_returned_yen"].fillna(0.0).to_numpy() / 100.0
        stakes = bucket_n
        roi = float((returns.sum() - stakes) / stakes)
        roi_ci = _clustered_bootstrap_roi(bucket, n_iter=BOOTSTRAP_ITERS)
        hit_rate = float((bucket["_returned_yen"] > 0).mean())
        remove_top = _remove_top_payoffs_roi(bucket, (1, 3, 5, 10))
        odds_bucket_roi = _odds_bucket_roi(bucket)
    else:
        roi = 0.0
        roi_ci = (0.0, 0.0)
        hit_rate = 0.0
        remove_top = {}
        odds_bucket_roi = {}

    return CellResult(
        going_cell=going_cell,
        decision_minutes=decision_minutes,
        races=n_races,
        runners=n_runners,
        baseline_log_loss=baseline_ll,
        enhanced_log_loss=enhanced_ll,
        delta_log_loss=delta_ll,
        delta_ll_ci_low=delta_ci[0],
        delta_ll_ci_high=delta_ci[1],
        baseline_brier=baseline_brier,
        enhanced_brier=enhanced_brier,
        delta_brier=enhanced_brier - baseline_brier,
        bucket_stakes=bucket_n,
        bucket_roi=roi,
        bucket_roi_ci_low=roi_ci[0],
        bucket_roi_ci_high=roi_ci[1],
        bucket_hit_rate=hit_rate,
        remove_top_roi=remove_top,
        odds_bucket_roi=odds_bucket_roi,
        thin=bool(thin_reason),
        thin_reason=thin_reason,
    )


def _cell_label(going_cell: str, decision_minutes: int | None) -> str:
    dm = "ALL" if decision_minutes is None else f"{decision_minutes}m"
    return f"{going_cell:<10} t-{dm}"


def _print_report(result: ValidationResult) -> None:
    overall = result.overall
    print("=" * 78)
    print("ODDS-CURVE VALIDATION (open->t movement vs market@t)")
    print("=" * 78)
    print(
        f"Sample: {result.n_races:,} races / {result.n_runners:,} runner-decision rows "
        f"(decision points = {result.decision_points})."
    )
    print(
        "Question: does open->t odds movement add information beyond the price\n"
        "          already showing at decision time t? If CI clears 0, NO --\n"
        "          the market has priced the curve in by t."
    )

    if overall is None:
        print("No overall cell -- validation did not produce a result.")
        return

    print("\n" + "-" * 78)
    print("HEADLINE -- overall log-loss delta (enhanced - market@t), ALL test rows")
    print("-" * 78)
    _print_cell_ll(overall)

    # Verdict off the headline.
    if overall.delta_ll_ci_high < 0:
        verdict = (
            "CURVE ADDS INFORMATION (CI excludes 0). Movement beats market@t --\n"
            "the price has NOT fully absorbed the open->t drift at decision time."
        )
    elif overall.delta_ll_ci_low > 0:
        verdict = (
            "CURVE HURTS (CI > 0). Movement is noise relative to market@t --\n"
            "no edge, the market has priced the drift in by t."
        )
    else:
        verdict = (
            "INCONCLUSIVE (CI straddles 0). Movement shows no reliable information\n"
            "beyond the price at t. Fourth honest null -- pivot to exotics."
        )
    print(f"  Log-loss verdict: {verdict}")

    print("\n" + "-" * 78)
    print("ROI verdict (top-quartile disagreement bucket, settled at official payouts)")
    print("-" * 78)
    if overall.bucket_stakes < MIN_RACES_FOR_CI:
        print(
            f"  bucket stakes = {overall.bucket_stakes:,} -- too thin "
            f"(need >= {MIN_RACES_FOR_CI}); no ROI verdict."
        )
    else:
        profitable = (
            "BEATS TAKEOUT (CI > -0.23)" if overall.bucket_roi_ci_low > JRA_TAKEOUT
            else "DOES NOT BEAT TAKEOUT" if overall.bucket_roi_ci_high < JRA_TAKEOUT
            else "inconclusive vs takeout"
        )
        print(
            f"  bucket: {overall.bucket_stakes:,} bets, "
            f"ROI={overall.bucket_roi:+.3f} "
            f"[CI: {overall.bucket_roi_ci_low:+.3f}, {overall.bucket_roi_ci_high:+.3f}], "
            f"hit_rate={overall.bucket_hit_rate:.3f} -> {profitable}"
        )

    # The 9-cell matrix.
    print("\n" + "-" * 78)
    print("CELL MATRIX -- 3 going cells x 3 decision times (no best-cell picking)")
    print("-" * 78)
    # Group by going cell.
    by_going: dict[str, list[CellResult]] = {}
    for c in result.cells:
        by_going.setdefault(c.going_cell, []).append(c)
    for going_cell in ("All", "Stable", "Transition"):
        cells = by_going.get(going_cell, [])
        if not cells:
            continue
        print(f"\n  [{going_cell}]")
        for c in cells:
            _print_cell_compact(c)

    # Robustness + odds slices for the overall cell only (the verdict cell).
    print("\n" + "-" * 78)
    print("OVERALL ROBUSTNESS")
    print("-" * 78)
    if overall.remove_top_roi:
        print("  Remove top-N payoffs (overall disagreement bucket):")
        for n in (1, 3, 5, 10):
            r = overall.remove_top_roi.get(n)
            if r is None:
                print(f"    top {n:>2}: insufficient bets after trim")
            else:
                print(f"    top {n:>2}: ROI={r:+.3f}")
    if overall.odds_bucket_roi:
        print("  ROI by odds bucket (overall disagreement bucket):")
        for lo, hi, label in ODDS_BUCKETS:
            entry = overall.odds_bucket_roi.get(label)
            if entry is None:
                continue
            n, roi = entry
            if n < MIN_RACES_FOR_CI:
                print(f"    {label:>6}: {n:>4} bets (thin)")
            else:
                print(f"    {label:>6}: {n:>4} bets, ROI={roi:+.3f}")

    print("\n" + "=" * 78)
    print("Notes:")
    print("  - Baseline = LN(devigged_prob_at_t) (within-snapshot de-vig at latest")
    print("    odds row <= as_of_time). NEVER market_baseline gold (final-odds de-vig).")
    print("  - ROI settles via settle_many at official jravan_payouts, not win_odds_at_t.")
    print("  - CIs are race-day-clustered bootstraps (same-day going/weather correlation).")
    print("  - All 9 cells reported; the overall cell is the verdict, not the best cell.")
    print("=" * 78)


def _print_cell_ll(c: CellResult) -> None:
    if c.thin and math.isnan(c.delta_log_loss):
        print(
            f"  {_cell_label(c.going_cell, c.decision_minutes)}: "
            f"{c.races:,} races -- {c.thin_reason}"
        )
        return
    sig = (
        "SIGNIFICANT" if c.delta_ll_ci_high < 0
        else "not significant" if c.delta_ll_ci_low > 0
        else "inconclusive"
    )
    print(
        f"  {_cell_label(c.going_cell, c.decision_minutes)}: "
        f"{c.races:,} races / {c.runners:,} runners"
    )
    print(
        f"    baseline log-loss={c.baseline_log_loss:.5f}, "
        f"enhanced={c.enhanced_log_loss:.5f}, "
        f"delta={c.delta_log_loss:+.5f} "
        f"[CI: {c.delta_ll_ci_low:+.5f}, {c.delta_ll_ci_high:+.5f}] "
        f"-> {sig}"
    )
    print(
        f"    brier: baseline={c.baseline_brier:.5f}, "
        f"enhanced={c.enhanced_brier:.5f}, delta={c.delta_brier:+.5f}"
    )


def _print_cell_compact(c: CellResult) -> None:
    if c.thin and math.isnan(c.delta_log_loss):
        print(
            f"    t-{('ALL' if c.decision_minutes is None else str(c.decision_minutes)+'m'):<5}: "
            f"{c.races:>5,} races -- {c.thin_reason}"
        )
        return
    sig = (
        "NEG" if c.delta_ll_ci_high < 0
        else "POS" if c.delta_ll_ci_low > 0
        else "?"
    )
    print(
        f"    t-{('ALL' if c.decision_minutes is None else str(c.decision_minutes)+'m'):<5}: "
        f"races={c.races:>5,}, delta_ll={c.delta_log_loss:+.5f} "
        f"[{c.delta_ll_ci_low:+.5f}, {c.delta_ll_ci_high:+.5f}] {sig}, "
        f"bucket ROI={c.bucket_roi:+.3f} "
        f"[{c.bucket_roi_ci_low:+.3f}, {c.bucket_roi_ci_high:+.3f}] "
        f"(n={c.bucket_stakes:,})"
    )


def _per_decision_thin_report(rows: list[dict]) -> None:
    by_decision: dict[int, set[str]] = {}
    for r in rows:
        by_decision.setdefault(int(r["decision_minutes_to_post"]), set()).add(r["race_id"])
    if not by_decision:
        return
    print("Per-decision coverage (races with at least one odds snapshot):")
    for dm in sorted(by_decision):
        n = len(by_decision[dm])
        flag = "" if n >= MIN_RACES_PER_DECISION else "  (need >= 100)"
        print(f"  {dm:>3}-min-to-post: {n:>4,} races{flag}")


# ---------------------------------------------------------------------------
# Model fit + evaluation helpers (adapted from validate_training_features.py)
# ---------------------------------------------------------------------------


def _fit_probs(
    train: pd.DataFrame,
    test: pd.DataFrame,
    cols: list[str],
    logistic_regression,
) -> np.ndarray:
    """Fit LogisticRegression on train, predict on test, renormalize within
    (race_id, decision_minutes_to_post) so probabilities sum to 1 per market.

    Each (race, decision_time) is a distinct market: a race has 3 decision-time
    markets, and within each the runner probs must sum to 1.
    """
    model = logistic_regression(max_iter=1000, class_weight="balanced")
    model.fit(train[cols].to_numpy(), train["winner"].to_numpy())
    raw = model.predict_proba(test[cols].to_numpy())[:, 1]
    clipped = np.clip(raw, 1e-6, 1.0)
    tmp = test.copy()
    tmp["_p"] = clipped
    denom = tmp.groupby("_market_key")["_p"].transform("sum").to_numpy()
    return clipped / np.clip(denom, 1e-6, None)


def _race_log_loss(df: pd.DataFrame, prob_col: str) -> float:
    """Multinomial race-level log-loss: mean of -log(prob) over winners only."""
    winners = df[df["winner"] == 1]
    if winners.empty:
        return float("nan")
    return float(-np.log(np.clip(winners[prob_col].to_numpy(), 1e-12, 1.0)).mean())


def _brier(df: pd.DataFrame, prob_col: str) -> float:
    """Mean per-runner Brier score. Closer to 0 is better."""
    return float(((df[prob_col] - df["winner"]) ** 2).mean())


def _clustered_bootstrap_delta_ll(
    test: pd.DataFrame, n_iter: int = 500
) -> tuple[float, float]:
    """Cluster bootstrap by race_date: resample dates, recompute log-loss delta.

    Accounts for same-day going/weather correlation that a naive bootstrap
    misses. Returns (2.5 pct, 97.5 pct) of the (enhanced - baseline) delta.
    """
    rng = np.random.default_rng(RNG_SEED)
    winners = test[test["winner"] == 1].copy()
    if winners.empty:
        return (0.0, 0.0)
    winners["_neg_bl"] = -np.log(winners["baseline_prob"].clip(1e-12, 1.0))
    winners["_neg_el"] = -np.log(winners["enhanced_prob"].clip(1e-12, 1.0))
    per_date = winners.groupby("race_date").agg(
        bl_sum=("_neg_bl", "sum"), el_sum=("_neg_el", "sum"), n=("race_id", "count")
    )
    n_dates = len(per_date)
    if n_dates == 0:
        return (0.0, 0.0)
    bl_sums = per_date["bl_sum"].to_numpy()
    el_sums = per_date["el_sum"].to_numpy()
    ns = per_date["n"].to_numpy()

    deltas = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        total_n = ns[idx].sum()
        if total_n == 0:
            deltas[i] = 0.0
            continue
        deltas[i] = (el_sums[idx].sum() - bl_sums[idx].sum()) / total_n
    return float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))


def _clustered_bootstrap_roi(
    bucket: pd.DataFrame, n_iter: int = 500
) -> tuple[float, float]:
    """Cluster bootstrap by race_date for the disagreement-bucket ROI.

    Per-bet returns are precomputed (settled once at official payouts); the
    bootstrap only resamples which race_dates contribute. Returns
    (2.5 pct, 97.5 pct) of the ROI distribution.
    """
    rng = np.random.default_rng(RNG_SEED + 1)
    if bucket.empty:
        return (0.0, 0.0)
    returns_per_bet = bucket["_returned_yen"].fillna(0.0).to_numpy() / 100.0
    dates = bucket["race_date"].to_numpy()
    stake = 1.0
    df = pd.DataFrame({"date": dates, "ret": returns_per_bet, "stake": stake})
    per_date = df.groupby("date").agg(stakes=("stake", "sum"), ret=("ret", "sum"))
    n_dates = len(per_date)
    if n_dates == 0:
        return (0.0, 0.0)
    stakes_arr = per_date["stakes"].to_numpy()
    ret_arr = per_date["ret"].to_numpy()

    rois = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        s = stakes_arr[idx].sum()
        if s == 0:
            rois[i] = 0.0
            continue
        rois[i] = (ret_arr[idx].sum() - s) / s
    return float(np.percentile(rois, 2.5)), float(np.percentile(rois, 97.5))


def _remove_top_payoffs_roi(bucket: pd.DataFrame, ns: tuple[int, ...]) -> dict[int, float]:
    """ROI after dropping the N largest payoffs from the bucket."""
    if bucket.empty:
        return {}
    ranked = bucket.sort_values("_returned_yen", ascending=False)
    total = len(ranked)
    out: dict[int, float] = {}
    for n in ns:
        if n >= total:
            out[n] = float("nan")
            continue
        trimmed = ranked.iloc[n:]
        stakes = len(trimmed)
        if stakes == 0:
            out[n] = float("nan")
            continue
        ret = trimmed["_returned_yen"].fillna(0.0).sum() / 100.0
        out[n] = float((ret - stakes) / stakes)
    return out


def _odds_bucket_roi(bucket: pd.DataFrame) -> dict[str, tuple[int, float]]:
    """ROI per odds bucket (per project memory: <2.0, 2-5, 5-10, 10-30, 30+)."""
    out: dict[str, tuple[int, float]] = {}
    if bucket.empty:
        return out
    for lo, hi, label in ODDS_BUCKETS:
        slice_df = bucket[(bucket["win_odds_at_t"] >= lo) & (bucket["win_odds_at_t"] < hi)]
        n = len(slice_df)
        if n == 0:
            continue
        ret = slice_df["_returned_yen"].fillna(0.0).sum() / 100.0
        out[label] = (n, float((ret - n) / n))
    return out


# ---------------------------------------------------------------------------
# Going-transition tagging (per-card earliest-post wetness baseline)
# ---------------------------------------------------------------------------


def _tag_going_transitions(race_rows: list[dict]) -> dict[str, bool]:
    """Tag each race with whether its going differs from the card's earliest-post race.

    Mirrors ``tools/jravan/settle_curve_log.py:108-129``. Card key =
    (year, venue, date(scheduled_post_time)). The earliest-post race per card
    (MIN scheduled_post_time) defines the baseline going_wetness; any later
    race on the same card with a different wetness is going_transition=True.

    Returns ``{race_id: bool}``. Races with NULL wetness or NULL scheduled_post_time
    are tagged False (can't determine a transition from missing data).
    """
    by_card: dict[tuple, list[dict]] = {}
    for r in race_rows:
        post = r.get("scheduled_post_time")
        if post is None:
            continue
        card_key = (
            r.get("year"),
            r.get("venue"),
            _card_date(post),
        )
        by_card.setdefault(card_key, []).append(r)

    out: dict[str, bool] = {}
    for card_key, races in by_card.items():
        races_sorted = sorted(races, key=lambda x: x.get("scheduled_post_time"))
        baseline = next(
            (r["going_wetness"] for r in races_sorted if r.get("going_wetness") is not None),
            None,
        )
        for r in races_sorted:
            w = r.get("going_wetness")
            out[r["race_id"]] = bool(
                baseline is not None and w is not None and w != baseline
            )
    return out


def _card_date(scheduled_post_time) -> str:
    """Card key date component from scheduled_post_time (JST calendar date).

    tolerant of both datetime and string forms.
    """
    s = scheduled_post_time
    if hasattr(s, "strftime"):
        return s.strftime("%Y%m%d")
    s = str(s)
    # YYYY-MM-DDTHH:MM:SS or YYYYMMDDHHMMSS or YYYY-MM-DD -- take first 8 digits
    digits = "".join(ch for ch in s if ch.isdigit())
    return digits[:8] if len(digits) >= 8 else s


# ---------------------------------------------------------------------------
# Settlement + load
# ---------------------------------------------------------------------------


def _filter_pit_rows(rows: list[dict]) -> tuple[list[dict], int]:
    """Drop rows whose ``max_source_available_at > as_of_time``.

    Defense-in-depth on top of the gold build's own assertion: a survivor
    indicates a corrupt partition. Returns ``(clean_rows, dropped_count)`` so
    callers can warn loudly without poisoning the fit.
    """
    clean: list[dict] = []
    dropped = 0
    for r in rows:
        msaa = r.get("max_source_available_at")
        asof = r.get("as_of_time")
        if msaa is not None and asof is not None and msaa > asof:
            dropped += 1
            continue
        clean.append(r)
    return clean, dropped


def _settle_test_returns(lake: LakePaths, test: pd.DataFrame) -> pd.Series:
    """Settle every test (race, horse) win bet once at official payouts.

    Returns a Series aligned with ``test`` of returned-yen per 100-yen stake.
    Several decision-time rows collapse onto the same (race, horse) bet; we
    deduplicate by (race_id, horse_number) so settle_many scans each race once.
    """
    if test.empty:
        return pd.Series([], dtype=int)
    pairs = (
        test[["race_id", "horse_number"]]
        .drop_duplicates()
        .to_numpy()
        .tolist()
    )
    bets = [
        Bet(str(rid), "win", f"{int(hn):02d}", stake_yen=100)
        for rid, hn in pairs
        if pd.notna(hn)
    ]
    settlements = settle_many(lake, bets)
    returned_by_pair: dict[tuple[str, int], int] = {}
    for (rid, hn), s in zip(pairs, settlements, strict=True):
        if pd.notna(hn):
            returned_by_pair[(str(rid), int(hn))] = int(s.returned_yen)
    # Vectorized lookup via a MultiIndex Series (no row-wise apply on 40K+ rows).
    if not returned_by_pair:
        return pd.Series([0] * len(test), index=test.index, dtype=int)
    lookup = pd.Series(returned_by_pair)
    lookup.index.names = ["_rid", "_hn"]
    keys = pd.DataFrame({
        "_rid": test["race_id"].astype(str),
        "_hn": test["horse_number"].astype(int),
    })
    merged = keys.set_index(["_rid", "_hn"]).index
    # map via the MultiIndex Series (falls back to NaN for missing, then 0).
    return pd.Series(lookup.reindex(merged).to_numpy(), index=test.index).fillna(0).astype(int)


def _load_rows(lake: LakePaths) -> list[dict]:
    """Load curve gold joined to results + races, with going_transition tagged.

    PIT-belt-and-braces: rows with ``max_source_available_at > as_of_time`` are
    dropped before they reach the model. The gold build already asserts this,
    so any survivor indicates a corrupted partition.
    """
    curve = lake.gold_dataset(CURVE_FEATURE_SET)
    results = lake.silver_dataset("jravan_race_results")
    races_tbl = lake.silver_dataset("jravan_races")
    if not curve.exists() or not results.exists() or not races_tbl.exists():
        return []

    sql = f"""
    SELECT
        cu.race_id,
        cu.horse_id,
        cu.horse_number,
        cu.decision_minutes_to_post,
        cu.as_of_time,
        cu.max_source_available_at,
        cu.scheduled_post_time,
        cu.open_win_odds,
        cu.win_odds_at_t,
        cu.devigged_prob_at_t,
        cu.drift_open_to_t,
        cu.recent_velocity,
        cu.recent_acceleration,
        cu.odds_volatility,
        cu.market_entropy_at_t,
        cu.open_odds_rank,
        cu.odds_rank_at_t,
        cu.odds_rank_change,
        cu.year,
        cu.venue,
        rr.finish_position,
        ra.going_wetness,
        CAST(ra.race_date AS VARCHAR) AS race_date
    FROM {lake_query.src(curve)} cu
    JOIN {lake_query.src(results)} rr
      ON rr.race_id = cu.race_id
     AND rr.horse_id = cu.horse_id
     AND (rr.horse_number IS NULL OR rr.horse_number = cu.horse_number)
    JOIN {lake_query.src(races_tbl)} ra
      ON ra.race_id = cu.race_id
    WHERE cu.win_odds_at_t IS NOT NULL
      AND cu.devigged_prob_at_t IS NOT NULL
      AND rr.finish_position IS NOT NULL
    """
    rows = lake_query.query(sql).to_pylist()
    if not rows:
        return []

    # PIT belt-and-braces: drop any row whose source violated as_of_time. The
    # gold build asserts this at write time, so a survivor means a corrupt
    # partition -- we warn and exclude rather than poison the fit.
    clean_rows, pit_dropped = _filter_pit_rows(rows)
    if pit_dropped:
        print(
            f"WARNING: dropped {pit_dropped} row(s) with max_source_available_at > as_of_time "
            "(gold partition is corrupt -- rebuild odds_curve)."
        )

    # Tag going_transition per race (per-card earliest-post wetness baseline).
    race_rows = [
        {
            "race_id": r["race_id"],
            "year": r["year"],
            "venue": r["venue"],
            "scheduled_post_time": r["scheduled_post_time"],
            "going_wetness": r.get("going_wetness"),
        }
        for r in clean_rows
    ]
    # Deduplicate race_rows -- one per race_id is enough.
    seen: set[str] = set()
    unique_race_rows: list[dict] = []
    for r in race_rows:
        if r["race_id"] in seen:
            continue
        seen.add(r["race_id"])
        unique_race_rows.append(r)
    transitions = _tag_going_transitions(unique_race_rows)
    for r in clean_rows:
        r["going_transition"] = bool(transitions.get(r["race_id"], False))

    return clean_rows


if __name__ == "__main__":
    main()
