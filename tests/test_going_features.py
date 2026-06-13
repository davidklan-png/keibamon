from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.features.point_in_time import assert_point_in_time
from keibamon_core.ingestion.going_features import GOING_FEATURE_SET, build_going_features
from keibamon_core.lake import read_dataset, write_dataset
from keibamon_core.paths import LakePaths
from keibamon_core.schemas import FeatureRow


def _dt(day: int, hour: int = 0) -> datetime:
    return datetime(2026, 1, day, hour, tzinfo=timezone.utc)


@pytest.fixture()
def going_lake(tmp_path: Path) -> LakePaths:
    lake = LakePaths(root=tmp_path / "data")
    races = [
        _race("r-firm-1", 1, 1, "firm", _dt(1, 3)),
        _race("r-wet-1", 2, 3, "soft", _dt(2, 3)),
        _race("r-wet-slow", 3, 4, "heavy", _dt(3, 3)),
        _race("r-target", 4, 4, "heavy", _dt(4, 3)),
    ]
    entries = []
    results = []
    odds = []
    pedigree = [
        {"horse_id": "mudder", "sire_id": "s-wet", "year": 2026, "venue": "05"},
        {"horse_id": "firmlover", "sire_id": "s-firm", "year": 2026, "venue": "05"},
        {"horse_id": "sibling", "sire_id": "s-wet", "year": 2026, "venue": "05"},
        {"horse_id": "cold", "sire_id": "s-wet", "year": 2026, "venue": "05"},
    ]

    def add_runner(race_id: str, horse_id: str, no: int, pos: int, seconds: float) -> None:
        day = {"r-firm-1": 1, "r-wet-1": 2, "r-wet-slow": 3, "r-target": 4}[race_id]
        entries.append(
            {
                "race_id": race_id,
                "horse_id": horse_id,
                "horse_number": no,
                "gate": no,
                "jockey_id": f"j{no}",
                "trainer_id": f"t{no}",
                "carried_weight_kg": 55.0,
                "available_at": _dt(day, 1),
                "year": 2026,
                "venue": "05",
            }
        )
        results.append(
            {
                "race_id": race_id,
                "horse_id": horse_id,
                "finish_position": pos,
                "finish_time_seconds": seconds,
                "margin": None,
                "last_3f_seconds": None,
                "available_at": _dt(day, 5),
                "year": 2026,
                "venue": "05",
            }
        )

    # Firm race: the eventual mudder is slow relative to the field.
    add_runner("r-firm-1", "mudder", 1, 3, 84.0)
    add_runner("r-firm-1", "firmlover", 2, 1, 82.0)
    add_runner("r-firm-1", "sibling", 3, 2, 83.0)

    # Wet race with globally slower times: field-relative percentile still makes
    # the mudder's wet performance positive versus the firm run.
    add_runner("r-wet-1", "mudder", 1, 1, 100.0)
    add_runner("r-wet-1", "firmlover", 2, 3, 103.0)
    add_runner("r-wet-1", "sibling", 3, 2, 102.0)

    # Sibling creates a positive same-sire prior before the target race.
    add_runner("r-wet-slow", "sibling", 3, 1, 110.0)
    add_runner("r-wet-slow", "firmlover", 2, 3, 116.0)
    add_runner("r-wet-slow", "mudder", 1, 2, 113.0)

    # Target rows exist in silver results after the race, but the builder must
    # not feed them into their own historical aggregates.
    add_runner("r-target", "mudder", 1, 2, 112.0)
    add_runner("r-target", "firmlover", 2, 1, 111.0)
    add_runner("r-target", "cold", 3, 3, 116.0)

    for no, price in [(1, 6.0), (2, 1.8), (3, 20.0)]:
        odds.append(
            {
                "race_id": "r-target",
                "bet_type": "win",
                "combo": f"{no:02d}",
                "odds": price,
                "odds_low": None,
                "odds_high": None,
                "popularity": no,
                "data_kubun": "2",
                "announce_at": _dt(4, 2),
                "available_at": _dt(4, 2),
                "year": 2026,
                "venue": "05",
            }
        )

    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))
    write_dataset(odds, lake.silver_dataset("jravan_win_place_odds"))
    write_dataset(pedigree, lake.silver_dataset("jravan_horse_pedigree"))
    return lake


def _race(
    race_id: str,
    day: int,
    going_wetness: int,
    going: str,
    post: datetime,
) -> dict:
    return {
        "race_id": race_id,
        "race_date": _dt(day),
        "racecourse": "Tokyo",
        "country": "JP",
        "surface": "dirt",
        "distance_m": 1600,
        "scheduled_post_time": post,
        "race_name": race_id,
        "grade_code": None,
        "last_3f_seconds": None,
        "weather": "rain" if going_wetness >= 3 else "fine",
        "going_turf": None,
        "going_dirt": going_wetness,
        "going_wetness": going_wetness,
        "going": going,
        "available_at": _dt(day, 1),
        "year": 2026,
        "venue": "05",
    }


def _target_rows(lake: LakePaths) -> dict[str, dict]:
    rows = read_dataset(lake.gold_dataset(GOING_FEATURE_SET))
    return {
        r["horse_id"]: r
        for r in rows
        if r["race_id"] == "r-target"
    }


def test_build_going_features_writes_point_in_time_gold(going_lake: LakePaths) -> None:
    assert build_going_features(going_lake) == 12
    rows = read_dataset(going_lake.gold_dataset(GOING_FEATURE_SET))
    assert len(rows) == 12
    assert {r["year"] for r in rows} == {2026}
    assert {r["venue"] for r in rows} == {"05"}

    for row in rows:
        assert_point_in_time(
            FeatureRow(
                race_id=row["race_id"],
                horse_id=row["horse_id"],
                as_of_time=row["as_of_time"],
                features={},
                source_available_ats=(row["max_source_available_at"],),
            )
        )


def test_going_neutral_delta_is_track_speed_invariant(going_lake: LakePaths) -> None:
    build_going_features(going_lake)
    target = _target_rows(going_lake)

    assert target["mudder"]["raw_going_delta"] > 0
    assert target["mudder"]["going_perf_delta"] > 0
    assert target["firmlover"]["going_perf_delta"] < 0


def test_shrinkage_uses_sire_prior_for_low_n(going_lake: LakePaths) -> None:
    build_going_features(going_lake)
    target = _target_rows(going_lake)

    cold = target["cold"]
    assert cold["missing_going_history"] is True
    assert cold["prior_going_runs"] == 0
    assert cold["sire_going_affinity"] > 0
    assert cold["going_perf_delta"] > 0
    assert cold["going_perf_delta"] < cold["sire_going_affinity"]


def test_within_race_z_scores_and_market_disagreement(going_lake: LakePaths) -> None:
    build_going_features(going_lake)
    target = _target_rows(going_lake)

    assert sum(r["going_fit_z"] for r in target.values()) == pytest.approx(0.0, abs=1e-12)
    assert target["mudder"]["going_fit_rank"] == 1
    assert target["firmlover"]["market_implied_rank"] == pytest.approx(1.0)
    assert target["mudder"]["going_market_disagreement"] > target["firmlover"][
        "going_market_disagreement"
    ]
