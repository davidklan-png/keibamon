"""Tests for the Benter fundamental + market blend capstone.

Four user-required tests:
1. ``test_synthetic_predictive_feature_lowers_logloss`` -- the LightGBM Phase 1
   pipeline can learn a synthetic signal OOS (smoke test that the model can
   learn at all, with walk-forward fit).
2. ``test_pit_exclusion_drops_future_data`` -- the leakage guard rejects any
   row whose ``max_source_available_at > as_of_time`` (mirrors
   ``market_baseline._assert_no_leakage``).
3. ``test_blend_recovers_a_zero_when_model_is_noise`` -- with a real
   ``p_market`` and a uniform-random ``p_model``, the b=1-constrained blend
   fits ``a`` within ±0.05 of zero with a CI that contains zero (correctness
   of the blend math under the null).
4. ``test_blend_recovers_a_positive_when_model_adds_info`` -- symmetric
   counterpart: when ``p_model`` carries information beyond ``p_market``, the
   blend fits ``a > 0`` with a CI that excludes zero (catches the
   collinearity false-null failure mode).
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")
pytest.importorskip("lightgbm")

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core.ingestion.handicap_features import (  # noqa: E402
    FUNDAMENTAL_FEATURES,
    _assert_no_leakage,
    _assert_no_market_features,
)
from tools.validate_handicap_model import (  # noqa: E402
    A_GRID_PRIMARY,
    _clustered_bootstrap_a_constrained,
    _fit_blend_constrained_1d,
    _fit_lightgbm,
    _phase1,
    _race_mean_ll,
    _softmax_within_race,
)


# ----------------------------------------------------------------------------
# Test 1: synthetic feature -> lower OOS log-loss
# ----------------------------------------------------------------------------


def _make_synthetic_phase1_df(
    *,
    n_years_train: int = 1,
    n_years_test: int = 1,
    races_per_year: int = 80,
    field_size: int = 8,
    signal_strength: float = 2.5,
    rng_seed: int = 20260617,
) -> pd.DataFrame:
    """Build a DataFrame with one predictive feature ``signal`` per runner.

    The winner is drawn with logit ∝ ``signal_strength * signal`` so the
    feature is genuinely informative. Train years are 2023..2023+n-1; the test
    year is the year after.
    """
    rng = np.random.default_rng(rng_seed)
    rows: list[dict] = []
    years = [2023 + i for i in range(n_years_train)] + [2023 + n_years_train + i for i in range(n_years_test)]
    # Mark the first n_years_train as < test year; last n_years_test == test year.
    test_year = years[-1]
    for y in years:
        for r in range(races_per_year):
            race_id = f"syn-{y}-{r:03d}"
            signals = rng.normal(0.0, 1.0, size=field_size)
            # Softmax over signal_strength * signals -> win probability
            exp_s = np.exp(signal_strength * signals - signal_strength * signals.max())
            p_win = exp_s / exp_s.sum()
            # Renormalize to clean up FP noise before passing to rng.choice
            p_win = p_win / p_win.sum()
            winner_local = rng.choice(field_size, p=p_win)
            for h in range(field_size):
                rows.append(
                    {
                        "race_id": race_id,
                        "horse_id": f"h-{race_id}-{h}",
                        "horse_number": h + 1,
                        "year": y,
                        "race_date": datetime(y, 6, 1, tzinfo=timezone.utc),
                        "venue": "05",
                        "finish_position": int(h == winner_local) and 1 or (h + 2),
                        "field_size": field_size,
                        # Use the single predictive feature as both `signal`
                        # and fill every other FUNDAMENTAL_FEATURES column with
                        # the same value (LightGBM will ignore zero-variance
                        # columns and pick up `signal`).
                        "signal": float(signals[h]),
                        "as_of_time": datetime(y, 6, 1, 5, tzinfo=timezone.utc),
                        "max_source_available_at": datetime(y, 6, 1, 5, tzinfo=timezone.utc),
                    }
                )
    df = pd.DataFrame(rows)
    # The non-signal features in FUNDAMENTAL_FEATURES are filled with noise so
    # LightGBM sees the same column set as production. `signal` is the only
    # predictive one.
    for col in FUNDAMENTAL_FEATURES:
        if col not in df.columns:
            df[col] = rng.normal(0.0, 1.0, size=len(df))
    df["finish_position"] = df["finish_position"].astype("Int64")
    return df


def test_synthetic_predictive_feature_lowers_logloss() -> None:
    """A walk-forward LightGBM fit must beat the no-features 1/field_size
    constant on a synthetic lake with one predictive feature."""
    df = _make_synthetic_phase1_df()
    features = list(FUNDAMENTAL_FEATURES) + ["signal"]

    df_out, results, _ = _phase1(df, features)
    assert len(results) == 1, "expected exactly one Y_test entry"

    r = results[0]
    # Sanity: the model saw enough data
    assert r.test_races >= 50
    # Headline: OOS winner log-loss must be CLEARLY below the 1/field_size
    # constant. With signal_strength=2.5 and field_size=8, log(1/8)≈2.079; a
    # successful fit should land near 1.3 or lower.
    assert r.oos_log_loss < r.no_feature_log_loss - 0.2, (
        f"model failed to beat no-features: oos={r.oos_log_loss:.4f} "
        f"vs no_feat={r.no_feature_log_loss:.4f}"
    )


# ----------------------------------------------------------------------------
# Test 2: PIT guard
# ----------------------------------------------------------------------------


def test_pit_exclusion_drops_future_data() -> None:
    """The leakage guard must reject any row whose ``max_source_available_at``
    is after ``as_of_time``. Mirrors ``market_baseline._assert_no_leakage``."""
    base_ts = datetime(2026, 6, 1, 5, tzinfo=timezone.utc)
    clean = [
        {
            "race_id": "r-clean",
            "horse_id": "h1",
            "max_source_available_at": base_ts,
            "as_of_time": base_ts,
        }
    ]
    _assert_no_leakage(clean)  # must not raise

    leaked = [
        {
            "race_id": "r-clean",
            "horse_id": "h1",
            "max_source_available_at": base_ts,
            "as_of_time": base_ts,
        },
        {
            "race_id": "r-leak",
            "horse_id": "h2",
            "max_source_available_at": datetime(2026, 6, 2, 5, tzinfo=timezone.utc),
            "as_of_time": datetime(2026, 6, 1, 5, tzinfo=timezone.utc),
        },
    ]
    with pytest.raises(ValueError, match="handicap feature leakage"):
        _assert_no_leakage(leaked)


def test_market_blind_guard_rejects_market_columns() -> None:
    """The audit guard must reject any odds/market-derived column on the gold.
    A future refactor that adds e.g. ``win_odds`` should fail loudly here."""
    base_ts = datetime(2026, 6, 1, 5, tzinfo=timezone.utc)
    clean = [
        {
            "race_id": "r",
            "horse_id": "h",
            "as_of_time": base_ts,
            "max_source_available_at": base_ts,
            "field_size": 8,
        }
    ]
    _assert_no_market_features(clean)  # must not raise

    bad = list(clean)
    bad[0] = {**bad[0], "win_odds": 3.2}
    with pytest.raises(ValueError, match="market-blind"):
        _assert_no_market_features(bad)


# ----------------------------------------------------------------------------
# Tests 3 & 4: blend math correctness
# ----------------------------------------------------------------------------


def _make_blend_calibration_df(
    *,
    market_signal_strength: float,
    model_signal_strength: float,
    n_races: int = 1200,
    field_size: int = 8,
    rng_seed: int = 20260617,
) -> pd.DataFrame:
    """Synthetic calibration set with both a true ``p_market`` and a ``p_model``
    derived from a (possibly different) latent signal.

    The market logit is generated from a latent quality signal; the model
    logit is generated from an INDEPENDENT latent signal with a different
    strength. When ``model_signal_strength == 0`` the model is pure noise; when
    it's > 0 it carries information the market doesn't have.
    """
    rng = np.random.default_rng(rng_seed)
    rows: list[dict] = []
    for r in range(n_races):
        race_id = f"syn-{r:04d}"
        race_date = datetime(2025, 6, 1, tzinfo=timezone.utc) + pd.Timedelta(days=r // 10)
        # Two independent latent quality signals
        quality_mkt = rng.normal(0.0, 1.0, size=field_size)
        quality_mod = rng.normal(0.0, 1.0, size=field_size)
        # Market logit ∝ market strength; model logit ∝ model strength
        l_market = market_signal_strength * quality_mkt
        l_model = model_signal_strength * quality_mod
        # The TRUE win prob depends on BOTH latents (so a nonzero
        # model_signal_strength adds information the market can't see).
        true_score = market_signal_strength * quality_mkt + model_signal_strength * quality_mod
        # All runners in this synthetic race share race_idx=0 within the call
        # (we re-key per-row to a globally unique race_idx below).
        p_true = _softmax_within_race(true_score, np.zeros(field_size, dtype=int), 1)
        # Renormalize to clean up FP noise before passing to rng.choice
        p_true = p_true / p_true.sum()
        winner = int(rng.choice(field_size, p=p_true))
        for h in range(field_size):
            rows.append(
                {
                    "race_id": race_id,
                    "race_date": race_date,
                    "l_model": float(l_model[h]),
                    "l_market": float(l_market[h]),
                    "winner_mask": int(h == winner),
                    "race_idx": r,
                    "field_size": field_size,
                }
            )
    df = pd.DataFrame(rows)
    # Recompute race_idx as contiguous ints in case of any reordering
    _, df["race_idx"] = np.unique(df["race_id"].to_numpy(), return_inverse=True)
    return df


def test_blend_recovers_a_zero_when_model_is_noise() -> None:
    """When ``p_model`` is pure noise (zero signal), the b=1-constrained blend
    must fit ``a ≈ 0`` -- specifically the mean a across the clustered
    bootstrap must lie within ±0.05 of 0 and the CI must contain 0.

    Critical correctness check: prevents the validator from falsely claiming
    an edge when the model is junk.
    """
    # market has signal, model has zero signal -> model is noise.
    cal = _make_blend_calibration_df(market_signal_strength=3.0, model_signal_strength=0.0)
    a_star = _fit_blend_constrained_1d(cal, A_GRID_PRIMARY)
    assert abs(a_star) <= 0.05, (
        f"point fit a should be ~0 when model is noise; got a={a_star:.4f}"
    )

    ci_lo, ci_hi = _clustered_bootstrap_a_constrained(
        cal, A_GRID_PRIMARY, n_iter=100
    )
    assert ci_lo <= 0.0 <= ci_hi, (
        f"CI must contain 0 when model is noise; got [{ci_lo:.4f}, {ci_hi:.4f}]"
    )


def test_blend_recovers_a_positive_when_model_adds_info() -> None:
    """When ``p_model`` carries information that ``p_market`` doesn't have, the
    blend must fit ``a > 0`` with a CI that excludes zero.

    Symmetric counterpart to the null test; catches the collinearity
    false-null failure mode (where the blend would mistakenly set a=0 even
    when the model has independent signal).
    """
    # market has its signal; model has an INDEPENDENT signal of equal strength
    # that the market can't see (orthogonal latents). a > 0 must result.
    cal = _make_blend_calibration_df(market_signal_strength=3.0, model_signal_strength=3.0)
    a_star = _fit_blend_constrained_1d(cal, A_GRID_PRIMARY)
    assert a_star > 0.05, (
        f"point fit a should be > 0 when model adds info; got a={a_star:.4f}"
    )

    ci_lo, ci_hi = _clustered_bootstrap_a_constrained(
        cal, A_GRID_PRIMARY, n_iter=100
    )
    assert ci_lo > 0.0, (
        f"CI must exclude 0 from below when model adds info; "
        f"got [{ci_lo:.4f}, {ci_hi:.4f}]"
    )


# ----------------------------------------------------------------------------
# Bonus: softmax / race_neg_ll sanity (cheap, locks the math)
# ----------------------------------------------------------------------------


def test_softmax_within_race_sums_to_one_and_is_stable() -> None:
    """Numerically-stable softmax: per-race sums to 1 even under extreme scores."""
    # Two races, 3 runners each. Race 0 has a 1000-logit winner (extreme).
    race_idx = np.array([0, 0, 0, 1, 1, 1])
    scores = np.array([1000.0, 0.0, -1000.0, 1.0, 0.5, 0.0])
    sm = _softmax_within_race(scores, race_idx, 2)
    assert np.allclose(sm[:3].sum(), 1.0)
    assert np.allclose(sm[3:].sum(), 1.0)
    # The 1000-logit runner should get ~1
    assert sm[0] > 0.99
    # winner log-loss is finite
    winner_mask = np.array([1, 0, 0, 1, 0, 0])
    ll = _race_mean_ll(scores, race_idx, winner_mask, 2)
    assert np.isfinite(ll)
