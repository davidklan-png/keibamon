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
    fit_beta,
)
from keibamon_core.backtest import CalibratedMarketBaselinePredictor, run_roi_backtest
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
                    "finish_position": 1 if horse_number == winner else horse_number,
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


def _log(value: float) -> float:
    import math

    return math.log(value)
