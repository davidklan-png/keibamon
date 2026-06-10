from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("pyarrow", reason="pyarrow is required for ingestion tests")

from keibamon_core.ingestion import GOLD_FEATURE_SET, import_csv_source
from keibamon_core.lake import read_manifest, read_parquet
from keibamon_core.paths import LakePaths

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "csv"

RACE_1 = "r-2026-0503-hanshin-11"  # finished race
RACE_2 = "r-2026-0607-tokyo-10"  # upcoming race, no results


@pytest.fixture()
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path / "data")


def test_csv_import_end_to_end(lake: LakePaths) -> None:
    report = import_csv_source(FIXTURE_CSV, lake)

    assert report.silver_counts == {
        "races": 2,
        "race_entries": 5,
        "race_results": 2,
        "odds_snapshots": 5,
    }
    assert report.gold_feature_rows == 5
    assert report.mart_counts == {"races": 2, "race_entries": 5}

    # Bronze snapshot is immutable, manifested, and idempotent.
    bronze_dir = Path(report.bronze_dir)
    manifest = read_manifest(bronze_dir)
    assert manifest is not None
    assert manifest["snapshot_id"] == report.snapshot_id
    assert set(manifest["files"]) == {"races.csv", "entries.csv", "results.csv", "odds.csv"}
    rerun = import_csv_source(FIXTURE_CSV, lake)
    assert rerun.snapshot_id == report.snapshot_id
    assert rerun.silver_counts["odds_snapshots"] == 0  # time series dedupe

    # Silver tables carry full source metadata.
    races = read_parquet(lake.silver_table("races"))
    assert {r["race_id"] for r in races} == {RACE_1, RACE_2}
    for race in races:
        assert race["source_name"] == "csv"
        assert race["content_hash"]
        assert race["available_at"] is not None

    # Marts are query-ready.
    mart_races = read_parquet(lake.mart("races"))
    by_id = {r["race_id"]: r for r in mart_races}
    assert by_id[RACE_1]["results_available"] is True
    assert by_id[RACE_2]["results_available"] is False
    assert by_id[RACE_2]["field_size"] == 3


def test_marts_are_duckdb_readable(lake: LakePaths) -> None:
    duckdb = pytest.importorskip("duckdb")
    import_csv_source(FIXTURE_CSV, lake)

    count = duckdb.sql(
        f"select count(*) from read_parquet('{lake.mart('races')}')"
    ).fetchone()[0]
    assert count == 2


def test_gold_features_never_use_future_available_at(lake: LakePaths) -> None:
    import_csv_source(FIXTURE_CSV, lake)
    rows = read_parquet(lake.gold_features(GOLD_FEATURE_SET))
    assert len(rows) == 5

    # Global invariant: nothing that feeds a row was available after as_of_time.
    for row in rows:
        assert row["max_source_available_at"] <= row["as_of_time"], row

    by_key = {(r["race_id"], r["horse_id"]): r for r in rows}

    # h-001's race-1 result is poisoned with available_at in 2099, so it must
    # NOT be counted toward h-001's career stats for race 2.
    assert by_key[(RACE_2, "h-001")]["career_starts"] == 0

    # h-002's race-1 result became available the same evening, well before
    # race 2, so it IS counted.
    h2 = by_key[(RACE_2, "h-002")]
    assert h2["career_starts"] == 1
    assert h2["career_top3"] == 1
    assert h2["career_win_rate"] == 0.0

    # A race's own result (published after post time) never feeds its own row.
    assert by_key[(RACE_1, "h-002")]["career_starts"] == 0

    # Odds features use only snapshots available before post time: the
    # 15:30 price is the last usable one; the 16:00 post-race snapshot
    # (win_odds 2.5) must be excluded.
    fav = by_key[(RACE_1, "h-001")]
    assert fav["win_odds"] == 2.9
    assert fav["win_odds_open"] == 3.5
    assert fav["win_odds_popularity"] == 1
    assert round(fav["win_odds_drift_pct"], 2) == -17.14

    # No odds captured for race 2 -> empty market features, not errors.
    assert by_key[(RACE_2, "h-001")]["win_odds"] is None


def test_import_missing_directory_raises(lake: LakePaths, tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        import_csv_source(tmp_path / "nope", lake)
