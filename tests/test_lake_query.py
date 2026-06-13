"""Tests for the DuckDB read path (lake_query). Uses tiny tmp Parquet files so
it is self-contained and does not depend on a built lake."""
from __future__ import annotations

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core import lake_query as q
from keibamon_core.lake import write_parquet


@pytest.fixture()
def lake(tmp_path):
    runners = [
        {"race_id": "r1", "horse_id": "h1", "w": 55.0},
        {"race_id": "r1", "horse_id": "h2", "w": 53.0},
        {"race_id": "r2", "horse_id": "h3", "w": 57.0},
        {"race_id": "r3", "horse_id": "h4", "w": 54.0},
        {"race_id": "r2", "horse_id": "h5", "w": 50.0},
    ]
    races = [
        {"race_id": "r1", "race_date": "2020-01-01"},
        {"race_id": "r2", "race_date": "2020-01-02"},
        {"race_id": "r3", "race_date": "2020-01-03"},
    ]
    rp = tmp_path / "runners.parquet"
    rap = tmp_path / "races.parquet"
    write_parquet(runners, rp)
    write_parquet(races, rap)
    return rp, rap


def test_query_returns_arrow_aggregate(lake):
    runners, _ = lake
    tbl = q.query("SELECT count(*) AS n, max(w) AS mw FROM {t}", t=runners)
    row = tbl.to_pylist()[0]
    assert row["n"] == 5 and row["mw"] == 57.0


def test_iter_groups_streams_one_race_at_a_time(lake):
    runners, races = lake
    sql = """
        SELECT runner.race_id, runner.horse_id, runner.w
        FROM {runners} runner JOIN {races} ra ON runner.race_id = ra.race_id
        ORDER BY ra.race_date, runner.race_id
    """
    groups = list(q.iter_groups(sql, key="race_id", runners=runners, races=races))
    # one tuple per race, in chronological order, rows grouped correctly
    assert [g[0] for g in groups] == ["r1", "r2", "r3"]
    assert {len(rows) for _, rows in groups} == {2, 2, 1}
    r1_rows = groups[0][1]
    assert {r["horse_id"] for r in r1_rows} == {"h1", "h2"}
    # tiny batch size still yields the same correct grouping (streaming path)
    g2 = list(q.iter_groups(sql, key="race_id", batch_rows=1, runners=runners, races=races))
    assert [k for k, _ in g2] == ["r1", "r2", "r3"]
    assert sum(len(v) for _, v in g2) == 5


def test_query_passes_through_braces_without_tables(tmp_path):
    """A SQL string with literal braces (e.g. src()'s hive_types={...}) and NO
    {table} placeholders must pass through untouched -- not run str.format."""
    from keibamon_core.lake import write_dataset

    base = tmp_path / "tbl"
    write_dataset([{"race_id": "r1", "year": 1986, "venue": "06", "v": 1}], base)
    sql = f"SELECT count(*) AS n FROM {q.src(base)}"   # src() injects hive_types={...}
    assert q.query(sql).to_pylist()[0]["n"] == 1       # no KeyError on '{year}'


def test_src_handles_file_and_glob(tmp_path):
    assert "union_by_name" in q.src(tmp_path / "part-*.parquet")
    assert "union_by_name" not in q.src(tmp_path / "one.parquet")


def test_partitioned_dataset_roundtrip_and_pruning(tmp_path):
    """write_dataset -> Hive layout; read_dataset/DuckDB expose typed year/venue;
    a year/venue filter touches only the matching partition."""
    from keibamon_core.lake import read_dataset, write_dataset

    rows = [
        {"race_id": "r1", "year": 1986, "venue": "06", "v": 1},
        {"race_id": "r2", "year": 1986, "venue": "05", "v": 2},
        {"race_id": "r3", "year": 1987, "venue": "06", "v": 3},
        {"race_id": "r4", "year": 1987, "venue": "A4", "v": 4},  # alphanumeric foreign code
    ]
    base = tmp_path / "tbl"
    write_dataset(rows, base)
    # Hive directory layout
    parts = {p.relative_to(base).as_posix().rsplit("/", 1)[0]
             for p in base.glob("**/*.parquet")}
    assert "year=1986/venue=06" in parts and "year=1987/venue=A4" in parts

    # read_dataset: partition columns typed (venue keeps "06", "A4" stays string)
    back = read_dataset(base)
    venues = {r["race_id"]: r["venue"] for r in back}
    assert venues == {"r1": "06", "r2": "05", "r3": "06", "r4": "A4"}
    assert all(isinstance(r["venue"], str) and isinstance(r["year"], int) for r in back)

    # DuckDB read via src(dir): pruned query returns only matching partition
    got = q.query("SELECT race_id, year, venue FROM {t} WHERE year=1986 AND venue='06'", t=base)
    assert got.to_pylist() == [{"race_id": "r1", "year": 1986, "venue": "06"}]

    # idempotent rewrite: same partitions, no duplication
    write_dataset(rows, base)
    assert len(read_dataset(base)) == 4
