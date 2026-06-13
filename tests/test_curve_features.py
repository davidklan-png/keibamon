from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.features.point_in_time import assert_point_in_time
from keibamon_core.ingestion.jravan_silver import build_jravan_odds_timeseries
from keibamon_core.ingestion.curve_features import CURVE_FEATURE_SET, build_curve_features
from keibamon_core.lake import read_dataset, write_dataset, write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.schemas import FeatureRow
from tools.validate_curve_signal import settle_win_bets


def _dt(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 6, 1, hour, minute, tzinfo=timezone.utc)


@pytest.fixture()
def curve_lake(tmp_path: Path) -> LakePaths:
    lake = LakePaths(root=tmp_path / "data")
    race_id = "jra-20260601-05-11"
    races = [
        {
            "race_id": race_id,
            "race_date": _dt(0),
            "racecourse": "Tokyo",
            "country": "JP",
            "surface": "turf",
            "distance_m": 1600,
            "scheduled_post_time": _dt(6),
            "available_at": _dt(4),
            "year": 2026,
            "venue": "05",
        }
    ]
    entries = [
        {
            "race_id": race_id,
            "horse_id": f"h{n}",
            "horse_number": n,
            "gate": n,
            "available_at": _dt(4),
            "year": 2026,
            "venue": "05",
        }
        for n in (1, 2, 3)
    ]
    snapshots = []
    for at, odds in [
        (_dt(5, 0), {1: 10.0, 2: 2.0, 3: 5.0}),
        (_dt(5, 30), {1: 8.0, 2: 2.5, 3: 6.0}),
        (_dt(5, 45), {1: 6.0, 2: 3.0, 3: 7.0}),
        (_dt(5, 55), {1: 1.5, 2: 8.0, 3: 30.0}),  # after 10-min decision; leakage bait
    ]:
        for horse_number, win_odds in odds.items():
            snapshots.append(
                {
                    "race_id": race_id,
                    "pool": "win",
                    "sel": f"{horse_number:02d}",
                    "announce_at": at,
                    "win_odds": win_odds,
                    "place_odds_low": None,
                    "place_odds_high": None,
                    "popularity": None,
                    "available_at": at,
                    "source_name": "fixture",
                    "year": 2026,
                    "venue": "05",
                }
            )
    payouts = [
        {
            "race_id": race_id,
            "pool": "win",
            "combo": "01",
            "payout_yen": 600,
            "popularity": 2,
            "available_at": _dt(7),
            "year": 2026,
            "venue": "05",
        }
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(snapshots, lake.silver_dataset("jravan_odds_timeseries"))
    write_dataset(payouts, lake.silver_dataset("jravan_payouts"))
    return lake


def _rows(lake: LakePaths) -> dict[int, dict]:
    rows = read_dataset(lake.gold_dataset(CURVE_FEATURE_SET))
    return {r["horse_number"]: r for r in rows}


def test_curve_features_are_pit_and_exclude_late_snapshot(curve_lake: LakePaths) -> None:
    assert build_curve_features(curve_lake, decision_minutes=(10,)) == 3
    rows = _rows(curve_lake)
    h1 = rows[1]

    assert h1["as_of_time"] == _dt(5, 50)
    assert h1["open_win_odds"] == 10.0
    assert h1["win_odds_at_t"] == 6.0
    assert h1["odds_snapshots_used"] == 3
    assert h1["max_source_available_at"] <= h1["as_of_time"]
    assert_point_in_time(
        FeatureRow(
            race_id=h1["race_id"],
            horse_id=h1["horse_id"],
            as_of_time=h1["as_of_time"],
            features={},
            source_available_ats=(h1["max_source_available_at"],),
        )
    )


def test_drift_sign_rank_change_and_devig_centering(curve_lake: LakePaths) -> None:
    build_curve_features(curve_lake, decision_minutes=(10,))
    rows = _rows(curve_lake)

    assert rows[1]["drift_open_to_t"] < 0  # 10.0 -> 6.0 shortened
    assert rows[1]["odds_rank_change"] > 0
    assert rows[1]["recent_velocity"] < 0
    assert sum(r["devigged_prob_at_t"] for r in rows.values()) == pytest.approx(1.0)


def test_settlement_uses_final_payout_not_early_odds(curve_lake: LakePaths) -> None:
    build_curve_features(curve_lake, decision_minutes=(10,))
    bet = _rows(curve_lake)[1]
    payouts = read_dataset(curve_lake.silver_dataset("jravan_payouts"))

    report = settle_win_bets([bet], payouts)
    assert report.bets == 1
    assert report.hit_rate == 1.0
    assert report.infinitesimal_roi == pytest.approx(5.0)  # 600 yen per 100 yen stake
    assert report.infinitesimal_roi != pytest.approx(9.0)  # not the 10.0 early price


def test_build_odds_timeseries_from_netkeiba_snapshots(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    write_parquet(
        [
            {
                "race_id": "jra-20260601-05-11",
                "horse_number": 1,
                "win_odds": 4.2,
                "place_odds_low": 1.4,
                "place_odds_high": 1.8,
                "popularity": 2,
                "status": "middle",
                "captured_at": _dt(5, 1),
                "available_at": _dt(5, 0),
                "source_name": "netkeiba",
                "raw_uri": "raw://fixture",
                "content_hash": "abc",
                "ingested_at": _dt(5, 1),
            }
        ],
        lake.silver_table("odds_snapshots"),
    )

    assert build_jravan_odds_timeseries(lake) == {"jravan_odds_timeseries": 2}
    rows = read_dataset(lake.silver_dataset("jravan_odds_timeseries"))
    assert {r["pool"] for r in rows} == {"win", "place"}
    assert {r["available_at"] for r in rows} == {_dt(5, 0)}
    assert all(r["year"] == 2026 and r["venue"] == "05" for r in rows)
