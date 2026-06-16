from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.ingestion.market_baseline import (
    MARKET_BASELINE_FEATURE_SET,
    MarketObservation,
    build_market_probs,
    calibrate_probs,
    calibration_by_prob_bin,
    calibration_quality,
    fit_beta,
)
from keibamon_core.backtest import CalibratedMarketBaselinePredictor, run_roi_backtest
from keibamon_core.backtest.predictors import DeviggedMarketBaselinePredictor
from keibamon_core.lake import read_dataset, write_dataset
from keibamon_core.paths import LakePaths


def _dt(day: int, hour: int = 0, minute: int = 0) -> datetime:
    return datetime(2026, 6, day, hour, minute, tzinfo=timezone.utc)


@pytest.fixture()
def market_lake(tmp_path: Path) -> LakePaths:
    lake = LakePaths(root=tmp_path / "data")
    races = []
    entries = []
    results = []
    odds = []
    for day in (1, 2, 3):
        race_id = f"jra-202606{day:02d}-05-11"
        post = _dt(day, 6)
        races.append(
            {
                "race_id": race_id,
                "race_date": _dt(day),
                "racecourse": "Tokyo",
                "country": "JP",
                "surface": "turf",
                "distance_m": 1600,
                "scheduled_post_time": post,
                "available_at": _dt(day, 4),
                "year": 2026,
                "venue": "05",
            }
        )
        winner = 3 if day < 3 else 1
        # Distinct finish positions per race: winner=1, others in horse_number
        # order behind them. (Earlier fixture used `1 if winner else horse_number`
        # which gave horse 1 finish_position=1 even when winner was 3 -- two
        # "winners" per race, corrupting the beta fit.)
        positions = {
            hn: i + 1
            for i, hn in enumerate(sorted([1, 2, 3], key=lambda x: (x != winner, x)))
        }
        for horse_number, price in [(1, 2.0), (2, 4.0), (3, 8.0)]:
            horse_id = f"h{horse_number}"
            entries.append(
                {
                    "race_id": race_id,
                    "horse_id": horse_id,
                    "horse_number": horse_number,
                    "available_at": _dt(day, 4),
                    "year": 2026,
                    "venue": "05",
                }
            )
            results.append(
                {
                    "race_id": race_id,
                    "horse_id": horse_id,
                    "finish_position": positions[horse_number],
                    "available_at": _dt(day, 7),
                    "year": 2026,
                    "venue": "05",
                }
            )
            odds.append(
                {
                    "race_id": race_id,
                    "bet_type": "win",
                    "combo": f"{horse_number:02d}",
                    "odds": price,
                    "odds_low": None,
                    "odds_high": None,
                    "popularity": horse_number,
                    "data_kubun": "3",
                    "announce_at": post - timedelta(minutes=10),
                    "available_at": post - timedelta(minutes=10),
                    "year": 2026,
                    "venue": "05",
                }
            )
        if day == 3:
            odds.append(
                {
                    "race_id": race_id,
                    "bet_type": "win",
                    "combo": "01",
                    "odds": 1.2,
                    "odds_low": None,
                    "odds_high": None,
                    "popularity": 1,
                    "data_kubun": "post",
                    "announce_at": post + timedelta(minutes=5),
                    "available_at": post + timedelta(minutes=5),
                    "year": 2026,
                    "venue": "05",
                }
            )
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))
    write_dataset(odds, lake.silver_dataset("jravan_win_place_odds"))
    return lake


def test_devigged_market_probabilities_sum_to_one_and_are_pit(market_lake: LakePaths) -> None:
    assert build_market_probs(market_lake, min_calibration_races=1) == 9
    rows = read_dataset(market_lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))
    by_race: dict[str, list[dict]] = {}
    for row in rows:
        by_race.setdefault(row["race_id"], []).append(row)
        assert row["max_source_available_at"] <= row["as_of_time"]

    for race_rows in by_race.values():
        assert sum(r["devigged_market_prob"] for r in race_rows) == pytest.approx(1.0)
        assert sum(r["calibrated_market_prob"] for r in race_rows) == pytest.approx(1.0)

    race3_h1 = next(
        r for r in rows if r["race_id"] == "jra-20260603-05-11" and r["horse_number"] == 1
    )
    assert race3_h1["win_odds"] == 2.0  # post-time 1.2 snapshot excluded


def test_beta_calibration_improves_out_of_sample_log_loss() -> None:
    history = [
        [
            MarketObservation(0.75, False),
            MarketObservation(0.20, False),
            MarketObservation(0.05, True),
        ],
        [
            MarketObservation(0.70, False),
            MarketObservation(0.20, False),
            MarketObservation(0.10, True),
        ],
    ]
    beta = fit_beta(history, min_races=1)
    assert beta < 1.0

    validation = {1: 0.70, 2: 0.20, 3: 0.10}
    calibrated = calibrate_probs(validation, beta)
    assert -_log(calibrated[3]) < -_log(validation[3])


def test_roi_backtest_settles_market_baseline_at_official_payouts(market_lake: LakePaths) -> None:
    build_market_probs(market_lake, min_calibration_races=1)
    payouts = []
    for day in (1, 2, 3):
        race_id = f"jra-202606{day:02d}-05-11"
        winner = 3 if day < 3 else 1
        payouts.append(
            {
                "race_id": race_id,
                "pool": "win",
                "combo": f"{winner:02d}",
                "payout_yen": 800 if winner == 3 else 200,
                "available_at": _dt(day, 7),
                "year": 2026,
                "venue": "05",
            }
        )
    write_dataset(payouts, market_lake.silver_dataset("jravan_payouts"))

    report = run_roi_backtest(market_lake, CalibratedMarketBaselinePredictor())
    assert report.bets == 3
    assert report.stake_yen == 300
    assert report.returned_yen in (0, 200, 800, 1000, 1600, 1800)
    assert set(report.remove_top_payoffs_roi) == {1, 5, 10}


def test_gold_market_baseline_carries_required_model0_columns(
    market_lake: LakePaths,
) -> None:
    """Model 0 usability: the gold row exposes every column an honest evaluator
    needs without re-deriving it from raw odds (raw/devigged/beta/calibrated)
    and the two PIT columns (as_of_time, max_source_available_at)."""
    build_market_probs(market_lake, min_calibration_races=1)
    rows = read_dataset(market_lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))
    required = {
        "race_id",
        "horse_id",
        "horse_number",
        "as_of_time",
        "max_source_available_at",
        "win_odds",
        "raw_implied_prob",
        "devigged_market_prob",
        "market_beta",
        "calibrated_market_prob",
        "finish_position",
    }
    assert required.issubset(set(rows[0].keys()))
    for row in rows:
        assert row["max_source_available_at"] <= row["as_of_time"]


def test_beta_is_walk_forward_and_does_not_leak_future_results(
    market_lake: LakePaths,
) -> None:
    """``market_beta`` for race N is fit only from races whose
    ``result_available_at`` is at or before race N's ``as_of_time``. The first
    race has no history -> beta = 1.0 (raw devigged probs); later races inherit
    a beta from the prior settled races."""
    build_market_probs(market_lake, min_calibration_races=1)
    rows = read_dataset(market_lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))
    by_race: dict[str, list[dict]] = {}
    for r in rows:
        by_race.setdefault(r["race_id"], []).append(r)

    # Race 1 (day=1): no prior settled races -> beta must be 1.0.
    race1 = by_race["jra-20260601-05-11"][0]
    assert race1["market_beta"] == 1.0

    # Race 2 (day=2) runs after race 1's results became available at day1 07:00,
    # well before race 2's post at day2 06:00 -> beta is fit from race 1 and is
    # NOT 1.0 (the fixture has a strong longshot winner, so beta < 1.0).
    race2 = by_race["jra-20260602-05-11"][0]
    assert race2["market_beta"] < 1.0


def test_calibration_quality_scores_oos_winner_log_loss_and_brier() -> None:
    """calibration_quality is the OOS verdict on whether the walk-forward beta
    earns its keep: per-race winner log-loss + per-runner Brier, calibrated vs
    devigged. When the favorite-longshot correction lifts the winner's
    probability (the longshot-wins case), calibrated must beat devigged on both.
    A sample with no known winner returns None (log-loss undefined)."""
    rows = [
        # winner was a devigged longshot (0.10); beta<1 raises it to 0.20
        {"calibrated_market_prob": 0.20, "devigged_market_prob": 0.10, "finish_position": 1},
        {"calibrated_market_prob": 0.40, "devigged_market_prob": 0.45, "finish_position": 2},
        {"calibrated_market_prob": 0.40, "devigged_market_prob": 0.45, "finish_position": 3},
    ]
    q = calibration_quality(rows)
    assert q is not None
    assert q.races == 1
    assert q.runners == 3
    assert q.calibrated_log_loss < q.devigged_log_loss
    assert q.calibrated_brier < q.devigged_brier
    assert q.log_loss_delta < 0

    # No winner -> log-loss undefined -> None (do not fabricate a metric).
    assert calibration_quality([
        {"calibrated_market_prob": 0.5, "devigged_market_prob": 0.5, "finish_position": 2},
    ]) is None


def test_calibration_by_prob_bin_isolates_the_longshot_tail() -> None:
    """The aggregate metric is favorite-dominated; the tail slice must be able
    to show a calibration benefit that aggregate log-loss hides. In a hand-built
    low-prob bin where calibrated lifts the winner toward observed, that bin's
    calibrated Brier must beat devigged (``cal_helps_brier``), and empty bins
    return n=0 with NaN stats rather than crashing."""
    rows = [
        # bin (0.01,0.02]: winner's prob lifted 0.015 -> 0.018 by calibration
        {"devigged_market_prob": 0.015, "calibrated_market_prob": 0.018, "finish_position": 1},
        {"devigged_market_prob": 0.015, "calibrated_market_prob": 0.018, "finish_position": 2},
        # bin (0.4,0.6]: a favorite, calibration irrelevant here
        {"devigged_market_prob": 0.5, "calibrated_market_prob": 0.5, "finish_position": 1},
    ]
    bins = [(0.01, 0.02), (0.4, 0.6), (0.9, 1.0)]  # last bin empty
    out = calibration_by_prob_bin(rows, bins)
    by_span = {(b.lo, b.hi): b for b in out}

    tail = by_span[(0.01, 0.02)]
    assert tail.n == 2
    assert tail.mean_devigged == pytest.approx(0.015)
    assert tail.mean_calibrated == pytest.approx(0.018)
    assert tail.observed == pytest.approx(0.5)
    assert tail.calibrated_brier < tail.devigged_brier
    assert tail.cal_helps_brier is True

    fav = by_span[(0.4, 0.6)]
    assert fav.n == 1 and fav.observed == pytest.approx(1.0)

    empty = by_span[(0.9, 1.0)]
    assert empty.n == 0


def test_devigged_market_baseline_predictor_scores_by_devigged_prob() -> None:
    """The active Model 0 ranks by ``devigged_market_prob`` (the calibrated beta
    is inert on the win pool). Top pick is the de-vigged favorite, not the
    raw-implied or calibrated favorite."""
    predictor = DeviggedMarketBaselinePredictor()
    rows = [
        {"horse_id": "h1", "devigged_market_prob": 0.5, "calibrated_market_prob": 0.55},
        {"horse_id": "h2", "devigged_market_prob": 0.3, "calibrated_market_prob": 0.30},
        {"horse_id": "h3", "devigged_market_prob": 0.2, "calibrated_market_prob": 0.15},
    ]
    scores = predictor.score_race({}, rows)
    assert scores == {"h1": 0.5, "h2": 0.3, "h3": 0.2}
    assert max(scores, key=scores.get) == "h1"
    assert predictor.name == "devigged_market_baseline"


def _log(value: float) -> float:
    import math

    return math.log(value)
