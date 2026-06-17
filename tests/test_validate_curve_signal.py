"""Tests for the upgraded curve validator.

Four hard-required cases:
1. Enhanced model (market_log_prob + curve features) beats baseline (market@t
   only) on a synthetic dataset where drift predicts the winner.
2. PIT-violating rows are excluded before the model is fit.
3. Race-day-clustered bootstrap CI is wider than the naive i.i.d. bootstrap
   CI when same-race_date observations are strongly correlated.
4. Per-card going-transition tagging matches the spec: a race whose
   going_wetness differs from its card's earliest-post race is True.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("sklearn")

import tools.validate_curve_signal as v


# ---------------------------------------------------------------------------
# Test 1: enhanced log-loss < baseline log-loss when drift predicts winner
# ---------------------------------------------------------------------------


def test_log_loss_favors_curve_when_drift_predicts_winner() -> None:
    """When ``drift_open_to_t`` perfectly separates winners from losers but
    the market prob is identical for every horse, the enhanced model must
    beat the baseline (market@t only) out of sample."""
    from sklearn.linear_model import LogisticRegression

    rng = np.random.default_rng(7)
    n_races = 80
    rows = []
    for race_idx in range(n_races):
        race_id = f"synth-race-{race_idx:03d}"
        # Alternate which horse wins so the model can't memorize "horse 1".
        winner = 1 if race_idx % 2 == 0 else 2
        # Add small noise so the problem isn't trivially separable (forces
        # LogisticRegression to actually learn, not just memorize sign).
        drift_winner = -0.6 + rng.normal(0, 0.05)
        drift_loser = 0.6 + rng.normal(0, 0.05)
        for horse in (1, 2):
            is_winner = horse == winner
            rows.append({
                "race_id": race_id,
                "horse_id": f"h{horse}",
                "horse_number": horse,
                "decision_minutes_to_post": 10,
                "year": 2024,
                "race_date": "20240601",
                "finish_position": 1 if is_winner else 2,
                # Identical market prob -> baseline cannot distinguish.
                "devigged_prob_at_t": 0.5,
                "drift_open_to_t": drift_winner if is_winner else drift_loser,
                "recent_velocity": 0.0,
                "recent_acceleration": 0.0,
                "odds_rank_change": 0,
                "odds_volatility": 0.0,
                "market_entropy_at_t": 0.0,
                "win_odds_at_t": 2.0,
                "open_win_odds": 2.0,
            })

    df = pd.DataFrame(rows)
    df["winner"] = (df["finish_position"] == 1).astype(int)
    df["market_prob"] = df["devigged_prob_at_t"].astype(float)
    df["market_log_prob"] = np.log(df["market_prob"].clip(lower=1e-9))
    for col in v.CURVE_FEATURE_COLS:
        df[col] = df[col].fillna(0.0)
    df["_market_key"] = (
        df["race_id"].astype(str) + ":" + df["decision_minutes_to_post"].astype(str)
    )

    # Simple 70/30 race-level split (era-aware split isn't needed here -- all
    # races are in the modern era by construction).
    race_ids = sorted(df["race_id"].unique())
    cut = int(0.7 * len(race_ids))
    train_races = set(race_ids[:cut])
    df["is_test"] = ~df["race_id"].isin(train_races)
    train = df[~df["is_test"]].copy()
    test = df[df["is_test"]].copy()

    baseline_cols = ["market_log_prob"]
    enhanced_cols = baseline_cols + v.CURVE_FEATURE_COLS

    test["baseline_prob"] = v._fit_probs(train, test, baseline_cols, LogisticRegression)
    test["enhanced_prob"] = v._fit_probs(train, test, enhanced_cols, LogisticRegression)

    baseline_ll = v._race_log_loss(test, "baseline_prob")
    enhanced_ll = v._race_log_loss(test, "enhanced_prob")

    # Enhanced must beat baseline -- drift carries real signal here.
    assert enhanced_ll < baseline_ll
    # And enhanced must be clearly better than chance (0.693 = -log(0.5)).
    assert enhanced_ll < 0.693


# ---------------------------------------------------------------------------
# Test 2: PIT-violating row is excluded before the model is fit
# ---------------------------------------------------------------------------


def test_pit_exclusion_holds() -> None:
    """A row whose ``max_source_available_at > as_of_time`` must never reach
    the model fit. ``_filter_pit_rows`` is the pure helper used by both
    ``_load_rows`` and ``validate``."""
    as_of = datetime(2025, 6, 1, 5, 50, tzinfo=timezone.utc)
    clean = [
        {
            "race_id": "r-good",
            "horse_id": "h1",
            "horse_number": 1,
            "as_of_time": as_of,
            "max_source_available_at": as_of,  # exactly equal -> OK
        },
        {
            "race_id": "r-good-2",
            "horse_id": "h1",
            "horse_number": 1,
            "as_of_time": as_of,
            "max_source_available_at": datetime(2025, 6, 1, 5, 0, tzinfo=timezone.utc),
        },
    ]
    violator = {
        "race_id": "r-leak",
        "horse_id": "h2",
        "horse_number": 2,
        "as_of_time": as_of,
        # Snapshot taken AFTER as_of_time -- would leak post-decision info.
        "max_source_available_at": datetime(2025, 6, 1, 5, 55, tzinfo=timezone.utc),
    }
    rows = clean + [violator]

    filtered, dropped = v._filter_pit_rows(rows)

    assert dropped == 1
    assert {r["race_id"] for r in filtered} == {"r-good", "r-good-2"}
    assert "r-leak" not in {r["race_id"] for r in filtered}


# ---------------------------------------------------------------------------
# Test 3: clustered bootstrap CI > naive i.i.d. bootstrap CI under clustering
# ---------------------------------------------------------------------------


def _naive_bootstrap_delta_ll_ci(
    test: pd.DataFrame, n_iter: int = 500, seed: int = 12345
) -> tuple[float, float]:
    """Naive i.i.d. bootstrap over winner rows (ignores race_date clustering).

    Written here in the test so the comparison is explicit; the validator's
    own helper is the clustered variant under test.
    """
    rng = np.random.default_rng(seed)
    winners = test[test["winner"] == 1].copy()
    n = len(winners)
    if n == 0:
        return (0.0, 0.0)
    bl = (-np.log(winners["baseline_prob"].clip(1e-12, 1.0))).to_numpy()
    el = (-np.log(winners["enhanced_prob"].clip(1e-12, 1.0))).to_numpy()
    deltas = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n, size=n)
        deltas[i] = el[idx].mean() - bl[idx].mean()
    return float(np.percentile(deltas, 2.5)), float(np.percentile(deltas, 97.5))


def test_clustering_changes_ci() -> None:
    """On a dataset where same-``race_date`` observations share a common
    delta, the race-day-clustered bootstrap CI must be wider than the naive
    i.i.d. bootstrap CI. The iid bootstrap treats correlated rows as
    independent and so badly under-estimates the variance of the mean."""
    rng = np.random.default_rng(99)
    n_dates = 30
    races_per_date = 5
    runners_per_race = 8

    # Per-date shared delta (high between-date variance). Within a date,
    # every winner has the SAME delta, so iid bootstrap "sees" a lot of
    # "independent" samples that are actually just copies of one date.
    a_dates = rng.normal(0.0, 0.15, size=n_dates)

    rows = []
    for d_idx, a in enumerate(a_dates):
        race_date = f"2025-02-{d_idx + 1:02d}"
        for r_idx in range(races_per_date):
            race_id = f"race-d{d_idx}-r{r_idx}"
            winner = (r_idx % runners_per_race) + 1
            for horse in range(1, runners_per_race + 1):
                baseline = 1.0 / runners_per_race
                if horse == winner:
                    # delta = a -> enhanced = baseline * exp(-a)
                    enhanced = baseline * math.exp(-a)
                else:
                    enhanced = baseline  # irrelevant for log-loss (winners only)
                rows.append({
                    "race_id": race_id,
                    "race_date": race_date,
                    "horse_number": horse,
                    "winner": 1 if horse == winner else 0,
                    "baseline_prob": baseline,
                    "enhanced_prob": enhanced,
                })

    test = pd.DataFrame(rows)

    clustered_ci = v._clustered_bootstrap_delta_ll(test, n_iter=500)
    iid_ci = _naive_bootstrap_delta_ll_ci(test, n_iter=500)

    clustered_width = clustered_ci[1] - clustered_ci[0]
    iid_width = iid_ci[1] - iid_ci[0]

    # Clustered must be substantially wider. With n_dates=30 and 40 winners
    # per date, the variance ratio is ~40x, so the SE ratio is ~6.3x; we just
    # assert the qualitative ordering with a healthy margin.
    assert clustered_width > iid_width * 2, (
        f"clustered width {clustered_width:.4f} not > 2x iid width {iid_width:.4f}"
    )


# ---------------------------------------------------------------------------
# Test 4: per-card going-transition tagging
# ---------------------------------------------------------------------------


def test_going_transition_per_card() -> None:
    """The per-card earliest-post wetness baseline tags correctly:
    - Same (year, venue, date) = one card, even if same datestamp.
    - Earliest-post race per card defines the baseline going_wetness.
    - Later race on the card with different wetness -> transition=True.
    - Same wetness across the card -> transition=False on all races.
    """
    post_1 = datetime(2025, 6, 1, 1, 0, tzinfo=timezone.utc)   # 10:00 JST
    post_2 = datetime(2025, 6, 1, 2, 0, tzinfo=timezone.utc)   # 11:00 JST
    post_3 = datetime(2025, 6, 1, 3, 0, tzinfo=timezone.utc)   # 12:00 JST

    # Two distinct cards: same year/date but different venue (= different card).
    # Card 1 (venue "05"): going changes from firm (1) to yielding (3) mid-card.
    # Card 2 (venue "09"): stays firm (1) throughout.
    races = [
        # Card 1
        {"race_id": "r-c1-1", "year": 2025, "venue": "05", "scheduled_post_time": post_1, "going_wetness": 1},
        {"race_id": "r-c1-2", "year": 2025, "venue": "05", "scheduled_post_time": post_2, "going_wetness": 3},
        {"race_id": "r-c1-3", "year": 2025, "venue": "05", "scheduled_post_time": post_3, "going_wetness": 3},
        # Card 2 (different venue)
        {"race_id": "r-c2-1", "year": 2025, "venue": "09", "scheduled_post_time": post_1, "going_wetness": 1},
        {"race_id": "r-c2-2", "year": 2025, "venue": "09", "scheduled_post_time": post_2, "going_wetness": 1},
    ]

    transitions = v._tag_going_transitions(races)

    # Card 1: earliest-post race (r-c1-1) defines baseline wetness=1.
    assert transitions["r-c1-1"] is False   # baseline race itself
    assert transitions["r-c1-2"] is True    # wetness 3 != baseline 1
    assert transitions["r-c1-3"] is True    # wetness 3 != baseline 1

    # Card 2: all races have wetness=1 = baseline.
    assert transitions["r-c2-1"] is False
    assert transitions["r-c2-2"] is False
