from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow", reason="pyarrow is required for backtest tests")

from keibamon_core.backtest import (
    MART_BACKTEST_PREDICTIONS,
    MART_BACKTEST_RUNS,
    CareerWinRatePredictor,
    MarketBaselinePredictor,
    UniformPredictor,
    rank_horses,
    run_backtest,
)
from keibamon_core.features.point_in_time import LeakageError
from keibamon_core.ingestion import GOLD_FEATURE_SET, import_csv_source
from keibamon_core.lake import read_parquet, write_parquet
from keibamon_core.paths import LakePaths

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "csv"

RACE_1 = "r-2026-0503-hanshin-11"  # finished race
RACE_2 = "r-2026-0607-tokyo-10"  # upcoming race, no results


@pytest.fixture()
def lake(tmp_path: Path) -> LakePaths:
    lake = LakePaths(root=tmp_path / "data")
    import_csv_source(FIXTURE_CSV, lake)
    return lake


def test_rank_horses_is_deterministic_with_ties() -> None:
    assert rank_horses({"h-9": 0.5, "h-1": 0.5, "h-5": 0.9}) == ["h-5", "h-1", "h-9"]


def test_career_win_rate_predictor_orders_by_history() -> None:
    rows = [
        {"horse_id": "h-a", "career_win_rate": 0.10},
        {"horse_id": "h-b", "career_win_rate": 0.25},
        {"horse_id": "h-c", "career_win_rate": None},
    ]
    scores = CareerWinRatePredictor().score_race({}, rows)
    assert rank_horses(scores) == ["h-b", "h-a", "h-c"]


def test_backtest_end_to_end_on_fixture_lake(lake: LakePaths) -> None:
    report = run_backtest(lake, CareerWinRatePredictor())

    # Only the finished race is scored; the upcoming race is skipped.
    assert report.races_evaluated == 1
    assert report.races_skipped == 1
    # Both runners have zero history, so the deterministic tiebreak picks
    # h-001, which actually won.
    assert report.win_hit_rate == 1.0
    assert report.mean_reciprocal_rank == 1.0
    assert report.feature_set_hash not in ("", "missing")

    predictions = read_parquet(lake.mart(MART_BACKTEST_PREDICTIONS))
    assert len(predictions) == 2
    assert all(p["race_id"] == RACE_1 for p in predictions)
    top = next(p for p in predictions if p["predicted_rank"] == 1)
    assert top["horse_id"] == "h-001"
    assert top["won"] is True

    runs = read_parquet(lake.mart(MART_BACKTEST_RUNS))
    assert [r["run_id"] for r in runs] == [report.run_id]


def test_backtest_reruns_upsert_and_predictors_coexist(lake: LakePaths) -> None:
    first = run_backtest(lake, CareerWinRatePredictor())
    second = run_backtest(lake, CareerWinRatePredictor())
    assert first.run_id == second.run_id  # same predictor + same features

    other = run_backtest(lake, UniformPredictor())
    assert other.run_id != first.run_id

    runs = read_parquet(lake.mart(MART_BACKTEST_RUNS))
    assert len(runs) == 2  # rerun overwrote itself, second predictor appended

    predictions = read_parquet(lake.mart(MART_BACKTEST_PREDICTIONS))
    assert len(predictions) == 4  # 2 horses x 2 runs, no duplicates


def test_market_baseline_uses_pre_post_odds(lake: LakePaths) -> None:
    report = run_backtest(lake, MarketBaselinePredictor())

    # h-001 was favorite at the last pre-post snapshot (2.9 vs 4.4) and won.
    assert report.races_evaluated == 1
    assert report.win_hit_rate == 1.0

    predictions = read_parquet(lake.mart(MART_BACKTEST_PREDICTIONS))
    market = [p for p in predictions if p["predictor_name"] == "market_odds_baseline"]
    top = next(p for p in market if p["predicted_rank"] == 1)
    assert top["horse_id"] == "h-001"
    assert round(top["score"], 4) == round(1 / 2.9, 4)


def test_backtest_refuses_tampered_future_features(lake: LakePaths) -> None:
    gold_path = lake.gold_features(GOLD_FEATURE_SET)
    rows = read_parquet(gold_path)
    for row in rows:
        if row["race_id"] == RACE_1 and row["horse_id"] == "h-002":
            row["max_source_available_at"] = datetime(2099, 1, 1, tzinfo=timezone.utc)
    write_parquet(rows, gold_path)

    with pytest.raises(LeakageError):
        run_backtest(lake, CareerWinRatePredictor())


def test_backtest_date_window_filters_races(lake: LakePaths) -> None:
    report = run_backtest(
        lake,
        CareerWinRatePredictor(),
        start=datetime(2026, 6, 1, tzinfo=timezone.utc),
    )
    # The only finished race is in May, outside the window.
    assert report.races_evaluated == 0
    assert report.win_hit_rate is None
