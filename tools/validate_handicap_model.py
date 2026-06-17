"""Benter-style fundamental model + market blend -- capstone hypothesis #6.

Five prior JRA win-pool hypotheses (mining, going-handling, training, the odds
curve, exotic cross-pool projection) failed to beat the de-vigged market net of
takeout. This validator asks the one untried question: does a multivariate
fundamental handicapping model, **market-blind** by construction, contribute
beyond the market once blended in?

Three phases, all walk-forward OOS:

1. **Phase 1 -- fundamental model**: LightGBM primary (per-runner binary
   winner, then per-race softmax over logits) + a McFadden conditional-logit
   cross-check for interpretability. The fundamental model uses ZERO
   odds/market-derived features -- audited.
2. **Phase 2 -- the Benter blend**: ``logit(p_final) = a*logit(p_model) + b*logit(p_market)``
   with walk-forward grid search. The fitted **``a``** is the headline. A
   b=1-constrained 1D fit is primary (avoids the collinearity ridge that 2D
   fits on highly-correlated logit(p_model) vs logit(p_market) suffer from); a
   2D fit is secondary.
3. **Phase 3 -- validation**: log-loss delta vs market with race-day-clustered
   bootstrap CI; ROI net of takeout via ``settle_many`` at official payouts,
   with capacity scenarios (convention, not measurement) and remove-top-N
   robustness.

Honest pre-registration
-----------------------
Based on 5 prior nulls the expected outcome is ``a`` small but nonzero, log-loss
delta small negative with CI that may or may not exclude zero, ROI likely
negative net of takeout. Either result is definitive: ``a ≈ 0`` closes the
research programme on public-information efficiency; ``a > 0`` + ROI clearing
takeout is the discovery.
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
from keibamon_core.ingestion.handicap_features import (
    FUNDAMENTAL_FEATURES,
    HANDICAP_FEATURE_SET,
)
from keibamon_core.ingestion.market_baseline import MARKET_BASELINE_FEATURE_SET
from keibamon_core.ingestion.settlement import Bet, settle_many
from keibamon_core.paths import LakePaths

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

BOOTSTRAP_ITERS = 500
RNG_SEED = 20260617

TEST_YEARS = (2024, 2025, 2026)
WARM_UP_YEAR = 2023  # market_baseline gold coverage starts here

# LightGBM primary model parameters (per spec).
LGBM_PARAMS = dict(
    objective="binary",
    is_unbalance=True,
    n_estimators=200,
    learning_rate=0.05,
    num_leaves=63,
    min_child_samples=50,
    random_state=RNG_SEED,
    verbose=-1,
)

# Blend grid.
BLEND_LOGIT_CLIP = 10.0  # clip all logits to [-10, 10] before grid search
A_GRID_PRIMARY = np.arange(0.0, 2.0 + 1e-9, 0.025)  # b=1-constrained
A_GRID_2D = np.arange(0.0, 2.0 + 1e-9, 0.05)
B_GRID_2D = np.arange(0.0, 2.0 + 1e-9, 0.05)

# Phase 3 capacity scenarios (convention, not measurement -- no pool-size data).
CAPACITY_SCENARIOS = (0.000, 0.002, 0.005, 0.010)
REMOVE_TOP_N = (0, 1, 3, 5, 10)
WIN_TAKEOUT = -0.225  # proportional-ROI bar for the JRA win pool

PROB_EPS = 1e-6  # logit clip on probabilities before softmax

# Odds buckets for ROI slicing.
ODDS_BUCKETS = [
    (0.00, 0.05),
    (0.05, 0.10),
    (0.10, 0.25),
    (0.25, 0.50),
    (0.50, 1.01),
]


# ----------------------------------------------------------------------------
# Data load
# ----------------------------------------------------------------------------


def _load_rows(lake: LakePaths) -> pd.DataFrame:
    """Join handicap gold to market_baseline gold on (race_id, horse_number).

    Returns one row per (race_id, horse_number) where both the fundamental
    feature row and the de-vigged market prob are available. Used for Phase 2
    and Phase 3 (the blend and ROI test). Phase 1's training set can be larger
    (handicap-only rows where the market isn't available); we surface the
    handicap-only rows separately via ``_load_handicap_only_rows``.
    """
    h = lake.gold_dataset(HANDICAP_FEATURE_SET)
    mb = lake.gold_dataset(MARKET_BASELINE_FEATURE_SET)
    rr = lake.silver_dataset("jravan_race_results")
    ra = lake.silver_dataset("jravan_races")
    if not h.exists() or not mb.exists():
        return pd.DataFrame()

    sql = f"""
    SELECT
        hf.race_id AS race_id,
        hf.horse_number AS horse_number,
        hf.horse_id AS horse_id,
        hf.year AS year,
        hf.venue AS venue,
        CAST(hf.race_date AS DATE) AS race_date,
        hf.as_of_time AS as_of_time,
        rr.finish_position AS finish_position,
        hf.field_size AS field_size,
        {", ".join(f"hf.{c} AS {c}" for c in FUNDAMENTAL_FEATURES)},
        mb.devigged_market_prob AS devigged_market_prob,
        mb.calibrated_market_prob AS calibrated_market_prob,
        mb.win_odds AS win_odds
    FROM {lake_query.src(h)} hf
    JOIN {lake_query.src(mb)} mb
      ON mb.race_id = hf.race_id
     AND mb.horse_number = hf.horse_number
    LEFT JOIN {lake_query.src(rr)} rr
      ON rr.race_id = hf.race_id
     AND COALESCE(rr.horse_number, -1) = COALESCE(hf.horse_number, -1)
     AND rr.horse_id = hf.horse_id
    WHERE hf.year >= {WARM_UP_YEAR}
    """
    tbl = lake_query.query(sql)
    df = tbl.to_pandas()
    if df.empty:
        return df
    df = df.sort_values(["race_date", "race_id", "horse_number"]).reset_index(drop=True)
    return df


# ----------------------------------------------------------------------------
# Phase 1 -- fundamental model (LightGBM + conditional logit)
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Phase1Result:
    """Per-Y_test LightGBM outcome + cross-year aggregates computed downstream."""

    year: int
    train_rows: int
    test_rows: int
    train_races: int
    test_races: int
    oos_log_loss: float
    no_feature_log_loss: float  # log(1/field_size) average over winners
    train_log_loss: float
    top_features: list[tuple[str, float]]  # (feature, importance)
    cond_logit_beta: dict[str, float]  # only for top-N features


def _softmax_within_race(scores: np.ndarray, race_idx: np.ndarray, n_races: int) -> np.ndarray:
    """Numerically-stable per-race softmax.

    ``race_idx`` is an int array mapping each row to its race slot in
    ``range(n_races)``. Returns per-row softmax probabilities.
    """
    # subtract per-race max for numerical stability
    max_per_race = np.full(n_races, -np.inf)
    np.maximum.at(max_per_race, race_idx, scores)
    shifted = scores - max_per_race[race_idx]
    exp_s = np.exp(shifted)
    sum_exp = np.zeros(n_races)
    np.add.at(sum_exp, race_idx, exp_s)
    return exp_s / np.clip(sum_exp[race_idx], 1e-30, None)


def _race_neg_ll(
    scores: np.ndarray, race_idx: np.ndarray, winner_mask: np.ndarray, n_races: int
) -> float:
    """Sum over races of -log(softmax(scores)[winner])."""
    sm = _softmax_within_race(scores, race_idx, n_races)
    return float(-np.log(np.clip(sm[winner_mask == 1], 1e-30, 1.0)).sum())


def _race_mean_ll(scores: np.ndarray, race_idx: np.ndarray, winner_mask: np.ndarray, n_races: int) -> float:
    total = _race_neg_ll(scores, race_idx, winner_mask, n_races)
    n_winners = int(winner_mask.sum())
    return total / n_winners if n_winners else float("nan")


def _fit_lightgbm(
    train_df: pd.DataFrame, test_df: pd.DataFrame, features: list[str]
) -> tuple[np.ndarray, np.ndarray, list[tuple[str, float]]]:
    """Train LightGBM binary winner classifier, return OOS p_binary on test
    and the top feature-importance pairs (sorted desc)."""
    from lightgbm import LGBMClassifier

    X_train = train_df[features].to_numpy(dtype=np.float64)
    y_train = (train_df["finish_position"] == 1).astype(int).to_numpy()
    X_test = test_df[features].to_numpy(dtype=np.float64)

    model = LGBMClassifier(**LGBM_PARAMS)
    # Impute NaNs to a sentinel column-wise median; LightGBM handles NaN
    # natively but the cross-check (conditional logit) needs the same matrix.
    col_med = np.nanmedian(X_train, axis=0)
    col_med = np.where(np.isfinite(col_med), col_med, 0.0)
    X_train_imp = np.where(np.isnan(X_train), col_med, X_train)
    X_test_imp = np.where(np.isnan(X_test), col_med[None, :], X_test)
    model.fit(X_train_imp, y_train)
    p_test = model.predict_proba(X_test_imp)[:, 1]
    p_train = model.predict_proba(X_train_imp)[:, 1]

    importances = sorted(
        zip(features, (model.feature_importances_.tolist())),
        key=lambda kv: kv[1],
        reverse=True,
    )
    return p_test, p_train, importances


def _cond_logit_fit(
    train_df: pd.DataFrame, features: list[str], lambda_l2: float = 0.01
) -> dict[str, float]:
    """McFadden conditional logit via L-BFGS-B with analytical gradient.

    Returns per-feature β. Bounds [-5, 5]. L2 reg ``lambda_l2``.
    """
    from scipy.optimize import minimize

    df = train_df.dropna(subset=["finish_position"]).copy()
    if df.empty:
        return {}

    # Impute NaNs column-wise (median). Same imputation as LightGBM path so the
    # β is comparable to the LightGBM top-N.
    X = df[features].to_numpy(dtype=np.float64)
    col_med = np.nanmedian(X, axis=0)
    col_med = np.where(np.isfinite(col_med), col_med, 0.0)
    X = np.where(np.isnan(X), col_med, X)

    # Per-race mapping
    race_ids, race_idx_int = np.unique(df["race_id"].to_numpy(), return_inverse=True)
    n_races = len(race_ids)
    winner_mask = (df["finish_position"].to_numpy() == 1).astype(int)
    if winner_mask.sum() == 0:
        return {}

    n_features = X.shape[1]
    x_winner_sum = (X * winner_mask[:, None]).sum(axis=0)  # sum X over winners

    def neg_ll_and_grad(beta: np.ndarray) -> tuple[float, np.ndarray]:
        scores = X @ beta
        sm = _softmax_within_race(scores, race_idx_int, n_races)
        # -sum_r log(sm[winner]) + L2
        ll = -np.log(np.clip(sm[winner_mask == 1], 1e-30, 1.0)).sum()
        reg = lambda_l2 * float(beta @ beta)
        # gradient: d/dbeta -sum log sm[winner] = sum_r (sum_j sm_j X_j) - X_winner_sum
        weighted = (X * sm[:, None]).sum(axis=0)
        grad = weighted - x_winner_sum + 2.0 * lambda_l2 * beta
        return ll + reg, grad

    beta0 = np.zeros(n_features)
    res = minimize(
        neg_ll_and_grad,
        beta0,
        jac=True,
        method="L-BFGS-B",
        bounds=[(-5.0, 5.0)] * n_features,
    )
    return dict(zip(features, res.x.tolist()))


def _phase1(
    df: pd.DataFrame, features: list[str]
) -> tuple[pd.DataFrame, list[Phase1Result], dict[str, float]]:
    """Walk-forward LightGBM fit per test year, attach ``p_model`` to df.

    Also fits a single conditional-logit β on the most-recent train year
    (reported for interpretability).
    """
    out_df = df.copy()
    out_df["p_model"] = np.nan
    results: list[Phase1Result] = []
    # Conditional logit β -- fit once on the union of all pre-test warm-up years
    # (the 2023 warm-up). Used as interpretability cross-check only.
    cond_beta: dict[str, float] = {}

    for Y in TEST_YEARS:
        train_mask = (df["year"] >= WARM_UP_YEAR) & (df["year"] < Y) & df["finish_position"].notna()
        test_mask = (df["year"] == Y) & df["finish_position"].notna()
        train_df = df.loc[train_mask].copy()
        test_df = df.loc[test_mask].copy()
        if train_df.empty or test_df.empty:
            continue

        p_test, p_train, importances = _fit_lightgbm(train_df, test_df, features)
        out_df.loc[test_mask, "p_model"] = p_test

        # OOS winner log-loss via per-race softmax
        test_races_arr, test_race_idx = np.unique(test_df["race_id"].to_numpy(), return_inverse=True)
        oos_ll = _race_mean_ll(
            _logit(np.clip(p_test, PROB_EPS, 1 - PROB_EPS)),
            test_race_idx,
            (test_df["finish_position"].to_numpy() == 1).astype(int),
            len(test_races_arr),
        )
        # Train log-loss for overfit check
        train_races_arr, train_race_idx = np.unique(train_df["race_id"].to_numpy(), return_inverse=True)
        train_ll = _race_mean_ll(
            _logit(np.clip(p_train, PROB_EPS, 1 - PROB_EPS)),
            train_race_idx,
            (train_df["finish_position"].to_numpy() == 1).astype(int),
            len(train_races_arr),
        )
        # No-features constant: -log(1/field_size) averaged over winners
        # (= log(field_size) on average). Convention: log-loss is positive.
        winners_field = test_df.loc[test_df["finish_position"] == 1, "field_size"]
        no_feat_ll = float(np.mean(np.log(winners_field))) if len(winners_field) else float("nan")

        # Conditional logit β: refit on the train_df for the first test year only
        # (cheap interpretability view; downstream years reuse β across years
        # since features are stable in meaning).
        if not cond_beta:
            cond_beta = _cond_logit_fit(train_df, features)

        results.append(
            Phase1Result(
                year=Y,
                train_rows=len(train_df),
                test_rows=len(test_df),
                train_races=len(train_races_arr),
                test_races=len(test_races_arr),
                oos_log_loss=oos_ll,
                no_feature_log_loss=no_feat_ll,
                train_log_loss=train_ll,
                top_features=importances[:30],
                cond_logit_beta={k: cond_beta.get(k, float("nan")) for k, _ in importances[:30]},
            )
        )
    return out_df, results, cond_beta


# ----------------------------------------------------------------------------
# Phase 2 -- the Benter blend
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class BlendFit:
    year: int
    a_constrained: float  # b=1, primary
    a_2d: float
    b_2d: float
    logit_corr: float  # Pearson r(logit(p_model), logit(p_market))
    n_calibration_races: int


@dataclass
class BlendAggregates:
    per_year: list[BlendFit] = field(default_factory=list)
    # Clustered bootstrap CIs over the constrained-a fit.
    a_constrained_mean: float = float("nan")
    a_constrained_ci_low: float = float("nan")
    a_constrained_ci_high: float = float("nan")
    a_2d_mean: float = float("nan")
    b_2d_mean: float = float("nan")
    # Test-year blend log-loss
    blend_log_loss: float = float("nan")


def _logit(p: np.ndarray) -> np.ndarray:
    return np.log(np.clip(p, PROB_EPS, 1 - PROB_EPS) / np.clip(1 - p, PROB_EPS, 1 - PROB_EPS))


def _fit_blend_constrained_1d(
    cal: pd.DataFrame, a_grid: np.ndarray
) -> float:
    """Argmin over ``a`` of race-level neg log-likelihood with b=1.

    ``cal`` must carry ``l_model``, ``l_market``, ``race_idx``, ``winner_mask``.
    """
    l_model = cal["l_model"].to_numpy()
    l_market = cal["l_market"].to_numpy()
    race_idx = cal["race_idx"].to_numpy()
    winner_mask = cal["winner_mask"].to_numpy()
    n_races = int(race_idx.max()) + 1
    best_a, best_ll = 0.0, math.inf
    for a in a_grid:
        ll = _race_neg_ll(a * l_model + 1.0 * l_market, race_idx, winner_mask, n_races)
        if ll < best_ll:
            best_ll, best_a = ll, a
    return float(best_a)


def _fit_blend_2d(
    cal: pd.DataFrame, a_grid: np.ndarray, b_grid: np.ndarray
) -> tuple[float, float]:
    """Argmin over (a, b) of race-level neg log-likelihood."""
    l_model = cal["l_model"].to_numpy()
    l_market = cal["l_market"].to_numpy()
    race_idx = cal["race_idx"].to_numpy()
    winner_mask = cal["winner_mask"].to_numpy()
    n_races = int(race_idx.max()) + 1
    best_a = best_b = 0.0
    best_ll = math.inf
    for a in a_grid:
        am = a * l_model
        for b in b_grid:
            ll = _race_neg_ll(am + b * l_market, race_idx, winner_mask, n_races)
            if ll < best_ll:
                best_ll, best_a, best_b = ll, a, b
    return float(best_a), float(best_b)


def _clustered_bootstrap_a_constrained(
    cal: pd.DataFrame, a_grid: np.ndarray, n_iter: int = BOOTSTRAP_ITERS
) -> tuple[float, float]:
    """Cluster bootstrap by race_date over the constrained-a fit.

    Resampling dates with replacement creates duplicate race_ids; we rebuild
    a contiguous race index per (date_copy_position, race_id) so each copy
    contributes independently to the softmax denominators.

    Returns (2.5, 97.5) percentile of the a distribution.
    """
    rng = np.random.default_rng(RNG_SEED)
    dates = pd.unique(cal["race_date"])
    n_dates = len(dates)
    if n_dates == 0:
        return (0.0, 0.0)
    date_to_idx = {d: i for i, d in enumerate(dates)}
    date_codes = cal["race_date"].map(date_to_idx).to_numpy()

    l_model = cal["l_model"].to_numpy()
    l_market = cal["l_market"].to_numpy()
    race_idx_orig = cal["race_idx"].to_numpy()
    winner_mask = cal["winner_mask"].to_numpy()

    # Pre-stage per-date blocks: rows + locally-remapped race_idx (so resampled
    # copies can be offset-summed without collision).
    rows_by_date: list[np.ndarray] = []
    inv_by_date: list[np.ndarray] = []
    n_races_by_date: list[int] = []
    for d in range(n_dates):
        rows = np.where(date_codes == d)[0].astype(np.int64)
        rows_by_date.append(rows)
        if rows.size:
            uniq, inv = np.unique(race_idx_orig[rows], return_inverse=True)
            inv_by_date.append(inv.astype(np.int64))
            n_races_by_date.append(int(len(uniq)))
        else:
            inv_by_date.append(np.zeros(0, dtype=np.int64))
            n_races_by_date.append(0)

    a_samples = np.empty(n_iter)
    for it in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        row_blocks: list[np.ndarray] = []
        race_blocks: list[np.ndarray] = []
        offset = 0
        for j in idx:
            rows = rows_by_date[j]
            if rows.size == 0:
                continue
            row_blocks.append(rows)
            race_blocks.append(inv_by_date[j] + offset)
            offset += n_races_by_date[j]
        if not row_blocks:
            a_samples[it] = 0.0
            continue
        row_idx = np.concatenate(row_blocks)
        race_idx_resample = np.concatenate(race_blocks)
        lm = l_model[row_idx]
        lk = l_market[row_idx]
        wm = winner_mask[row_idx]
        best_a, best_ll = 0.0, math.inf
        for a in a_grid:
            ll = _race_neg_ll(a * lm + lk, race_idx_resample, wm, offset)
            if ll < best_ll:
                best_ll, best_a = ll, a
        a_samples[it] = best_a
    return float(np.percentile(a_samples, 2.5)), float(np.percentile(a_samples, 97.5))


def _phase2(df: pd.DataFrame) -> tuple[pd.DataFrame, BlendAggregates]:
    """Walk-forward blend fit per test year; attach ``p_blend`` to df."""
    out_df = df.copy()
    out_df["l_model"] = np.nan
    out_df["l_market"] = np.nan
    out_df["p_blend"] = np.nan

    valid_model = df["p_model"].notna() & df["devigged_market_prob"].between(PROB_EPS, 1 - PROB_EPS, inclusive="neither")
    out_df.loc[valid_model, "l_model"] = _logit(df.loc[valid_model, "p_model"].to_numpy()).clip(-BLEND_LOGIT_CLIP, BLEND_LOGIT_CLIP)
    out_df.loc[valid_model, "l_market"] = _logit(df.loc[valid_model, "devigged_market_prob"].to_numpy()).clip(-BLEND_LOGIT_CLIP, BLEND_LOGIT_CLIP)

    per_year: list[BlendFit] = []
    blend_ll_total = 0.0
    blend_races_total = 0

    for Y in TEST_YEARS:
        cal_mask = (
            (out_df["year"] >= WARM_UP_YEAR)
            & (out_df["year"] < Y)
            & out_df["l_model"].notna()
            & out_df["finish_position"].notna()
        )
        test_mask = (out_df["year"] == Y) & out_df["l_model"].notna() & out_df["finish_position"].notna()
        cal = out_df.loc[cal_mask].copy()
        test = out_df.loc[test_mask].copy()
        if cal.empty or test.empty:
            continue

        # Precompute race_idx + winner_mask for calibration
        _, cal["race_idx"] = np.unique(cal["race_id"].to_numpy(), return_inverse=True)
        cal["winner_mask"] = (cal["finish_position"] == 1).astype(int)
        # Same for test
        _, test_race_idx = np.unique(test["race_id"].to_numpy(), return_inverse=True)
        test_winner_mask = (test["finish_position"] == 1).astype(int).to_numpy()
        n_test_races = len(np.unique(test["race_id"].to_numpy()))

        a_star = _fit_blend_constrained_1d(cal, A_GRID_PRIMARY)
        a2, b2 = _fit_blend_2d(cal, A_GRID_2D, B_GRID_2D)
        corr = float(np.corrcoef(cal["l_model"].to_numpy(), cal["l_market"].to_numpy())[0, 1])

        # Apply the constrained (a_star, b=1) fit to the test year.
        scores = a_star * test["l_model"].to_numpy() + 1.0 * test["l_market"].to_numpy()
        sm = _softmax_within_race(scores, test_race_idx, n_test_races)
        out_df.loc[test_mask, "p_blend"] = sm

        # Clustered bootstrap CI for a_star
        # (only if sample is large enough -- otherwise degenerate CIs).
        a_ci_lo, a_ci_hi = _clustered_bootstrap_a_constrained(cal, A_GRID_PRIMARY)

        per_year.append(
            BlendFit(
                year=Y,
                a_constrained=a_star,
                a_2d=a2,
                b_2d=b2,
                logit_corr=corr,
                n_calibration_races=int(cal["race_id"].nunique()),
            )
        )
        # Aggregate blend log-loss across test years
        blend_ll = _race_neg_ll(scores, test_race_idx, test_winner_mask, n_test_races)
        blend_ll_total += blend_ll
        blend_races_total += int(test_winner_mask.sum())

    # Mark the bootstrap CIs on the first aggregate entry (single CI for the
    # mean across years is reported via _aggregate_a_ci below).
    agg = BlendAggregates(per_year=per_year)
    if per_year:
        a_arr = np.array([p.a_constrained for p in per_year])
        a2_arr = np.array([p.a_2d for p in per_year])
        b2_arr = np.array([p.b_2d for p in per_year])
        agg.a_constrained_mean = float(a_arr.mean())
        agg.a_2d_mean = float(a2_arr.mean())
        agg.b_2d_mean = float(b2_arr.mean())
        # Clustered CI: bootstrap over the POOLED calibration set (all prior
        # years combined), refit a once per draw. This is the headline CI for a.
        pooled = out_df.loc[
            (out_df["year"] >= WARM_UP_YEAR)
            & (out_df["year"] < max(TEST_YEARS))
            & out_df["l_model"].notna()
            & out_df["finish_position"].notna()
        ].copy()
        if not pooled.empty:
            _, pooled["race_idx"] = np.unique(pooled["race_id"].to_numpy(), return_inverse=True)
            pooled["winner_mask"] = (pooled["finish_position"] == 1).astype(int)
            agg.a_constrained_ci_low, agg.a_constrained_ci_high = _clustered_bootstrap_a_constrained(
                pooled, A_GRID_PRIMARY
            )
        agg.blend_log_loss = blend_ll_total / blend_races_total if blend_races_total else float("nan")
    return out_df, agg


# ----------------------------------------------------------------------------
# Phase 3 -- validation
# ----------------------------------------------------------------------------


@dataclass(frozen=True)
class LogLossDelta:
    point: float
    ci_low: float
    ci_high: float
    n_races: int


def _clustered_bootstrap_logloss_delta(
    test: pd.DataFrame, p_blend_col: str, p_market_col: str, n_iter: int = BOOTSTRAP_ITERS
) -> tuple[float, float]:
    """Cluster bootstrap by race_date of (LL(p_blend) - LL(p_market)) over winners.

    Per-race log-loss is a per-winner quantity (each race has one winner), so
    the bootstrap can pre-aggregate per-date sums and resample dates in O(n_dates).
    """
    rng = np.random.default_rng(RNG_SEED + 2)
    if test.empty:
        return (0.0, 0.0)
    winners = test[test["winner_mask"] == 1].copy()
    if winners.empty:
        return (0.0, 0.0)
    winners["neg_bl_bl"] = -np.log(np.clip(winners[p_blend_col].to_numpy(), 1e-30, 1.0))
    winners["neg_bl_mk"] = -np.log(np.clip(winners[p_market_col].to_numpy(), 1e-30, 1.0))

    dates = pd.unique(test["race_date"])
    sum_bl = winners.groupby("race_date")["neg_bl_bl"].sum()
    sum_mk = winners.groupby("race_date")["neg_bl_mk"].sum()
    cnt = winners.groupby("race_date")["neg_bl_bl"].count()
    sum_bl_arr = sum_bl.reindex(dates).fillna(0.0).to_numpy()
    sum_mk_arr = sum_mk.reindex(dates).fillna(0.0).to_numpy()
    cnt_arr = cnt.reindex(dates).fillna(0).to_numpy().astype(np.int64)
    n_dates = len(dates)

    deltas = np.empty(n_iter)
    for it in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        n = cnt_arr[idx].sum()
        if n == 0:
            deltas[it] = 0.0
            continue
        deltas[it] = (sum_bl_arr[idx].sum() - sum_mk_arr[idx].sum()) / n
    return float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))


@dataclass
class ROIResult:
    point: float
    ci_low: float
    ci_high: float
    stakes: int
    hit_rate: float


def _evaluate_roi(
    test: pd.DataFrame, lake: LakePaths, p_blend_col: str = "p_blend"
) -> dict[tuple[float, int], ROIResult]:
    """Bet every runner where ``p_blend * win_odds >= 1/(1-capacity)``;
    settle at official payouts.

    Returns a dict keyed by ``(capacity_fraction, remove_top_n)`` of ROIResult.
    """
    # Build the candidate bet set across all capacity scenarios at once: a
    # runner qualifies for the SMALLEST capacity threshold (0%) iff its edge
    # is positive. For higher capacities the bar is stricter, so we just
    # filter the same DataFrame at different thresholds.
    test = test.copy()
    test["win_odds_safe"] = test["win_odds"].clip(lower=0.1)
    test["edge"] = test[p_blend_col] * test["win_odds_safe"]

    results: dict[tuple[float, int], ROIResult] = {}
    if test.empty:
        return results

    # Pre-stage per-date ROI aggregation for clustered bootstrap at the
    # infinitesimal capacity (0%).
    base_bettors = test  # filtered per (capacity, remove_top_N) below

    rng = np.random.default_rng(RNG_SEED + 3)
    dates_all = pd.unique(test["race_date"])
    n_dates_all = len(dates_all)
    date_to_idx_all = {d: i for i, d in enumerate(dates_all)}

    for capacity in CAPACITY_SCENARIOS:
        if capacity == 0.0:
            cutoff = 1.0
        else:
            cutoff = 1.0 / (1.0 - capacity)
        bet_mask = test["edge"] >= cutoff
        for top_n in REMOVE_TOP_N:
            # Remove-top-N: drop the top-N most-bet runners in each race
            # (proxy for the "favorites already crowded" robustness check from
            # the exotic validator).
            sub = test[bet_mask].copy()
            if sub.empty:
                results[(capacity, top_n)] = ROIResult(
                    point=0.0, ci_low=0.0, ci_high=0.0, stakes=0, hit_rate=0.0
                )
                continue
            if top_n > 0:
                # Rank within each race by edge (DESC), drop the top-N per race
                sub["_rank_in_race"] = sub.groupby("race_id")["edge"].rank(
                    method="first", ascending=False
                )
                sub = sub[sub["_rank_in_race"] > top_n]
            if sub.empty:
                results[(capacity, top_n)] = ROIResult(
                    point=0.0, ci_low=0.0, ci_high=0.0, stakes=0, hit_rate=0.0
                )
                continue
            stakes = len(sub)
            bets = [
                Bet(race_id=str(r["race_id"]), pool="win", selection=str(int(r["horse_number"])), stake_yen=100)
                for _, r in sub.iterrows()
            ]
            settlements = settle_many(lake, bets)
            returns = sum(s.returned_yen for s in settlements)
            stake_total = stakes * 100
            roi = (returns - stake_total) / stake_total if stake_total else 0.0
            hit_rate = float(sum(1 for s in settlements if s.payout_yen > 0) / stakes) if stakes else 0.0

            # Clustered bootstrap by race_date
            sub_dates = pd.unique(sub["race_date"])
            if len(sub_dates) > 0:
                ret_per_bet = np.array(
                    [s.returned_yen - 100 for s in settlements], dtype=np.float64
                )
                # We need per-date sums; sub is in the same order as settlements
                sub = sub.reset_index(drop=True)
                sub["_ret_minus_stake"] = ret_per_bet
                per_date = sub.groupby("race_date")["_ret_minus_stake"].agg(["sum", "count"])
                d_arr = per_date.index.to_numpy()
                sum_arr = per_date["sum"].to_numpy()
                cnt_arr = per_date["count"].to_numpy().astype(np.int64)
                nd = len(d_arr)
                rois = np.empty(min(BOOTSTRAP_ITERS, 200))
                # Use fewer iterations for ROI cells -- the bootstrap over many
                # cells is expensive; 200 is enough for 95% CIs.
                for it in range(len(rois)):
                    ii = rng.integers(0, nd, size=nd)
                    num = sum_arr[ii].sum()
                    den = cnt_arr[ii].sum() * 100
                    rois[it] = num / den if den else 0.0
                ci_lo, ci_hi = float(np.percentile(rois, 2.5)), float(np.percentile(rois, 97.5))
            else:
                ci_lo = ci_hi = 0.0

            results[(capacity, top_n)] = ROIResult(
                point=roi, ci_low=ci_lo, ci_high=ci_hi, stakes=stakes, hit_rate=hit_rate
            )
    return results


def _roi_by_odds_bucket(test: pd.DataFrame, lake: LakePaths) -> dict[tuple[float, float], ROIResult]:
    """Slice infinitesimal-capacity win ROI by market-implied probability bucket."""
    out: dict[tuple[float, float], ROIResult] = {}
    if test.empty:
        return out
    test = test.copy()
    test["market_p"] = test["devigged_market_prob"]
    for lo, hi in ODDS_BUCKETS:
        sub = test[(test["market_p"] > lo) & (test["market_p"] <= hi)].copy()
        if sub.empty:
            out[(lo, hi)] = ROIResult(0.0, 0.0, 0.0, 0, 0.0)
            continue
        bets = [
            Bet(race_id=str(r["race_id"]), pool="win", selection=str(int(r["horse_number"])), stake_yen=100)
            for _, r in sub.iterrows()
        ]
        settlements = settle_many(lake, bets)
        stake_total = len(sub) * 100
        returns = sum(s.returned_yen for s in settlements)
        roi = (returns - stake_total) / stake_total if stake_total else 0.0
        hit_rate = float(sum(1 for s in settlements if s.payout_yen > 0) / len(sub)) if len(sub) else 0.0
        out[(lo, hi)] = ROIResult(roi, 0.0, 0.0, len(sub), hit_rate)
    return out


# ----------------------------------------------------------------------------
# Orchestration + report
# ----------------------------------------------------------------------------


def _format_ci(point: float, lo: float, hi: float, fmt: str = "+.5f") -> str:
    return f"{point:{fmt}}  [95% CI: {lo:{fmt}}, {hi:{fmt}}]"


def main() -> None:
    lake = LakePaths()
    if not lake.gold_dataset(HANDICAP_FEATURE_SET).exists():
        print(
            f"No {HANDICAP_FEATURE_SET} gold. Run "
            "`python -m keibamon_core.ingestion.handicap_features` first."
        )
        return
    if not lake.gold_dataset(MARKET_BASELINE_FEATURE_SET).exists():
        print(
            f"No {MARKET_BASELINE_FEATURE_SET} gold. Run "
            "`python -m keibamon_core.ingestion.market_baseline` first."
        )
        return

    df = _load_rows(lake)
    if df.empty:
        print("No rows with both handicap and market_baseline coverage.")
        return

    n_races = df["race_id"].nunique()
    n_runners = len(df)
    print("=" * 78)
    print("BENTER FUNDAMENTAL + MARKET BLEND -- CAPSTONE HYPOTHESIS #6")
    print("=" * 78)
    print(
        "Question: does a market-blind multivariate fundamental model contribute\n"
        "          beyond the de-vigged win market once blended in walk-forward?\n"
        "          5 prior JRA win-pool nulls (mining, going, training, curve,\n"
        "          exotics) frame this as the one untried method. Either result\n"
        "          is definitive: a~0 closes the programme; a>0 + ROI clearing\n"
        "          takeout is the discovery."
    )
    print(
        f"\nSample: {n_runners:,} runners across {n_races:,} races "
        f"(years {df['year'].min()}..{df['year'].max()})."
    )
    print(
        f"Test years: {TEST_YEARS} (warm-up training year: {WARM_UP_YEAR})."
    )

    features = list(FUNDAMENTAL_FEATURES)
    print(f"\nFundamental feature count: {len(features)} (market-blind -- audited).")

    print("\n" + "-" * 78)
    print("PHASE 1 -- FUNDAMENTAL MODEL (LightGBM primary + cond-logit cross-check)")
    print("-" * 78)
    df, p1_results, cond_beta = _phase1(df, features)
    for r in p1_results:
        print(f"\n[Y_test={r.year}]")
        print(
            f"  train: {r.train_races:,} races / {r.train_rows:,} runners  |  "
            f"test: {r.test_races:,} races / {r.test_rows:,} runners"
        )
        print(
            f"  OOS winner log-loss (model softmax): {r.oos_log_loss:.5f}  |  "
            f"no-features 1/field_size: {r.no_feature_log_loss:.5f}  |  "
            f"train: {r.train_log_loss:.5f}"
        )
        delta = r.oos_log_loss - r.no_feature_log_loss
        print(f"  OOS - no-features: {delta:+.5f}  |  train-OOS gap: {r.oos_log_loss - r.train_log_loss:+.5f}")
        print("  Top-10 LightGBM feature importances:")
        for fname, imp in r.top_features[:10]:
            beta_val = r.cond_logit_beta.get(fname, float("nan"))
            print(f"    {fname:<40} lgbm_imp={imp:>5}   cond_logit_beta={beta_val:+.4f}")
    # Year-by-year stability
    if p1_results:
        ll_arr = np.array([r.oos_log_loss for r in p1_results])
        print(f"\n  OOS log-loss by year: min={ll_arr.min():.5f}, mean={ll_arr.mean():.5f}, max={ll_arr.max():.5f}")

    print("\n" + "-" * 78)
    print("PHASE 2 -- THE BENTER BLEND  logit(p_final) = a*logit(p_model) + b*logit(p_market)")
    print("-" * 78)
    df, blend = _phase2(df)
    for by in blend.per_year:
        print(
            f"\n[Y_test={by.year}]  calibration races={by.n_calibration_races:,}"
            f"  r(logit p_model, logit p_market)={by.logit_corr:.4f}"
        )
        print(
            f"  PRIMARY  b=1-constrained a: {by.a_constrained:.4f}  "
            f"(2D secondary: a={by.a_2d:.3f}, b={by.b_2d:.3f})"
        )
        if by.logit_corr > 0.9:
            print(
                "  NOTE: r > 0.9 -- 2D blend ill-conditioned; the b=1-constrained\n"
                "        1D fit is the primary a estimate per spec."
            )
    print("\nHEADLINE -- PRIMARY b=1-CONSTRAINED a (clustered bootstrap CI):")
    print(
        "  mean a (across test years): "
        f"{blend.a_constrained_mean:.4f}  "
        f"[95% CI: {blend.a_constrained_ci_low:.4f}, {blend.a_constrained_ci_high:.4f}]"
    )
    print(
        f"  2D secondary: mean a={blend.a_2d_mean:.4f}, mean b={blend.b_2d_mean:.4f} "
        f"(b~1 expected if market well-calibrated)."
    )
    a_excl_zero_lo = blend.a_constrained_ci_low > 0
    a_excl_zero_hi = blend.a_constrained_ci_high < 0
    if a_excl_zero_lo:
        a_verdict = "a CI EXCLUDES 0 from above -- fundamental model contributes"
    elif a_excl_zero_hi:
        a_verdict = "a CI EXCLUDES 0 from below -- fundamental model HURTS"
    else:
        a_verdict = "a CI includes 0 -- fundamental model is inert given the market"
    print(f"  a verdict: {a_verdict}")

    print("\n" + "-" * 78)
    print("PHASE 3 -- VALIDATION (log-loss delta + ROI net of takeout)")
    print("-" * 78)
    # Filter to OOS races where p_blend is defined
    test_df = df.loc[df["p_blend"].notna() & df["finish_position"].notna()].copy()
    if test_df.empty:
        print("No OOS rows with p_blend defined; cannot validate.")
        return
    _, test_df["race_idx"] = np.unique(test_df["race_id"].to_numpy(), return_inverse=True)
    test_df["winner_mask"] = (test_df["finish_position"] == 1).astype(int)

    # Log-loss delta vs market
    market_ll = _race_mean_ll(
        _logit(test_df["devigged_market_prob"].to_numpy()),
        test_df["race_idx"].to_numpy(),
        test_df["winner_mask"].to_numpy(),
        int(test_df["race_idx"].max()) + 1,
    )
    blend_ll = _race_mean_ll(
        _logit(test_df["p_blend"].to_numpy()),
        test_df["race_idx"].to_numpy(),
        test_df["winner_mask"].to_numpy(),
        int(test_df["race_idx"].max()) + 1,
    )
    delta_point = blend_ll - market_ll
    delta_ci_lo, delta_ci_hi = _clustered_bootstrap_logloss_delta(
        test_df, "p_blend", "devigged_market_prob"
    )
    print(
        f"\nLog-loss (winner): blend={blend_ll:.5f}  market={market_ll:.5f}  "
        f"delta={delta_point:+.5f}"
    )
    print(
        f"  Clustered bootstrap 95% CI on delta: "
        f"[{delta_ci_lo:+.5f}, {delta_ci_hi:+.5f}]"
    )
    if delta_ci_hi < 0:
        ll_verdict = "delta CI EXCLUDES 0 from below -- blend adds information"
    elif delta_ci_lo > 0:
        ll_verdict = "delta CI EXCLUDES 0 from above -- blend HURTS"
    else:
        ll_verdict = "delta CI includes 0 -- inconclusive"
    print(f"  Log-loss verdict: {ll_verdict}")

    print(
        "\nROI net of takeout (decision: PIT win_odds from market_baseline gold; "
        "settlement: official payouts via settle_many)."
    )
    print(
        "  Capacity scenarios are CONVENTION, NOT MEASUREMENT -- no pool-size\n"
        "  data; same disclaimer as the exotic validator."
    )
    roi_results = _evaluate_roi(test_df, lake)
    print("\n  ROI by capacity x remove-top-N (capacity 0% is the infinitesimal bar):")
    print("    cap     topN    stakes      ROI        95% CI")
    for capacity in CAPACITY_SCENARIOS:
        for top_n in REMOVE_TOP_N:
            r = roi_results.get((capacity, top_n))
            if r is None or r.stakes == 0:
                continue
            print(
                f"    {capacity*100:4.1f}%   top{top_n:<2d}  {r.stakes:>8,}    "
                f"{r.point:+.4f}    [{r.ci_low:+.4f}, {r.ci_high:+.4f}]   hit={r.hit_rate:.3f}"
            )

    print("\n  ROI by market-implied probability bucket (infinitesimal capacity, all runners):")
    bucket_results = _roi_by_odds_bucket(test_df, lake)
    for (lo, hi), r in bucket_results.items():
        print(
            f"    p_market in ({lo:.2f}, {hi:.2f}]  stakes={r.stakes:>8,}  "
            f"ROI={r.point:+.4f}  hit={r.hit_rate:.3f}"
        )

    print("\n" + "=" * 78)
    print("VERDICT")
    print("=" * 78)
    a_clears = blend.a_constrained_ci_low > 0
    ll_clears = delta_ci_hi < 0
    infinitesimal = roi_results.get((0.0, 0))
    roi_clears = (
        infinitesimal is not None
        and infinitesimal.ci_low > WIN_TAKEOUT
    )
    print(
        f"  a CI excludes 0 from above: {'YES' if a_clears else 'no'}  "
        f"(a={blend.a_constrained_mean:+.4f}, CI [{blend.a_constrained_ci_low:+.4f}, {blend.a_constrained_ci_high:+.4f}])"
    )
    print(
        f"  log-loss delta CI excludes 0 from below: {'YES' if ll_clears else 'no'}  "
        f"(delta={delta_point:+.5f}, CI [{delta_ci_lo:+.5f}, {delta_ci_hi:+.5f}])"
    )
    if infinitesimal:
        print(
            f"  ROI clears -22.5% takeout at infinitesimal capacity: "
            f"{'YES' if roi_clears else 'no'}  "
            f"(ROI={infinitesimal.point:+.4f}, CI [{infinitesimal.ci_low:+.4f}, {infinitesimal.ci_high:+.4f}])"
        )
    if a_clears and ll_clears and roi_clears:
        print(
            "\n  >>> EDGE CONFIRMED: fundamental model contributes beyond the market\n"
            "      AND ROI clears takeout. Public-information programme OPEN."
        )
    elif a_clears and ll_clears:
        print(
            "\n  >>> PARTIAL: fundamental model adds information beyond the market\n"
            "      but ROI does not clear takeout. Edge exists in probability\n"
            "      calibration but is not profitable at win-pool prices."
        )
    else:
        print(
            "\n  >>> NULL: fundamental model does NOT contribute beyond the de-vigged\n"
            "      market net of takeout. With 5 prior nulls, this closes the\n"
            "      public-information research programme on JRA parimutuel efficiency."
        )
    print("=" * 78)


if __name__ == "__main__":
    main()
