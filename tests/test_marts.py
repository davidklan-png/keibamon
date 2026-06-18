"""Tests for ingestion.marts.refresh_marts: source resolution + races mart shape.

The live lake holds ``jravan_*`` Hive-partitioned silver tables; the legacy
CSV-source path writes single ``<table>.parquet`` files. ``refresh_marts`` must
source-resolve each table (prefer ``jravan_*``, fall back to CSV) so the races
mart materializes from whichever exists, and emit exactly the documented
11-column races-mart shape regardless of the source schema.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("pyarrow")

from keibamon_core.ingestion.marts import (
    MART_RACES,
    _read_silver_any,
    refresh_marts,
)
from keibamon_core.lake import read_parquet, write_dataset, write_parquet
from keibamon_core.paths import LakePaths

_RACES_MART_COLS = {
    "race_id",
    "race_date",
    "racecourse",
    "country",
    "surface",
    "distance_m",
    "scheduled_post_time",
    "field_size",
    "results_available",
    "source_name",
    "content_hash",
    "grade",
    "netkeiba_race_id",
}

_RACE_A = "jra-20260614-09-01"  # jyo 09 = Hanshin (project's non-standard map)
_RACE_B = "jra-20260614-09-02"
_POST_A = datetime(2026, 6, 14, 0, 0, tzinfo=timezone.utc)  # 09:00 JST


def _part(race_id: str) -> tuple[int, str]:
    parts = race_id.split("-")
    return int(parts[1][:4]), parts[2]


def _jravan_race_row(rid: str, *, post: datetime | None = _POST_A) -> dict[str, Any]:
    """Full jravan_silver._race_record shape — includes EXTRA columns (race_name,
    grade_code, going, weather, ...) that the mart MUST drop."""
    return {
        "race_id": rid,
        "race_date": datetime(2026, 6, 14, tzinfo=timezone.utc),
        "racecourse": "Hanshin",
        "country": "JP",
        "surface": "turf",
        "distance_m": 2000,
        "scheduled_post_time": post,
        # --- extra jravan columns the mart must NOT carry ---
        "race_name": "Tenno Sho (Spring)",
        # JV-Data 2003.グレードコード letter (A=G1, B=G2, C=G3, ...). The mart
        # normalizes via adapters.jravan.grade_label.
        "grade_code": "A",
        "last_3f_seconds": 34.1,
        "weather": "fine",
        "going_turf": "good",
        "going_dirt": None,
        "going_wetness": 1,
        "going": "good",
        # --- provenance meta ---
        "source_name": "jravan",
        "source_record_id": f"RA:{rid}",
        "raw_uri": f"bronze/jravan/{rid}.dat",
        "content_hash": f"hash-{rid}",
        "ingested_at": datetime(2026, 6, 14, 20, 0, tzinfo=timezone.utc),
        "published_time": datetime(2026, 6, 14, 20, 0, tzinfo=timezone.utc),
        "available_at": post or datetime(2026, 6, 14, tzinfo=timezone.utc),
        "year": _part(rid)[0],
        "venue": _part(rid)[1],
    }


def _jravan_entry_row(rid: str, horse_no: int) -> dict[str, Any]:
    return {
        "race_id": rid,
        "horse_id": f"{horse_no:010d}",
        "horse_name": f"horse-{horse_no}",
        "horse_number": horse_no,
        "gate": horse_no,
        "jockey_id": f"j{horse_no}",
        "trainer_id": f"t{horse_no}",
        "carried_weight_kg": 57,
        "body_weight_kg": 480,
        "source_name": "jravan",
        "source_record_id": f"SE:{rid}:{horse_no}",
        "raw_uri": f"bronze/jravan/{rid}.dat",
        "content_hash": f"hash-e{rid}-{horse_no}",
        "ingested_at": datetime(2026, 6, 14, 20, 0, tzinfo=timezone.utc),
        "published_time": datetime(2026, 6, 14, 20, 0, tzinfo=timezone.utc),
        "available_at": _POST_A,
        "year": _part(rid)[0],
        "venue": _part(rid)[1],
    }


def _jravan_result_row(rid: str, horse_no: int, pos: int) -> dict[str, Any]:
    return {
        "race_id": rid,
        "horse_id": f"{horse_no:010d}",
        "horse_number": horse_no,
        "finish_position": pos,
        "finish_time_seconds": 95.2,
        "margin": "1/2",
        "win_odds": 3.4,
        "popularity": 1,
        "last_3f_seconds": 34.1,
        "source_name": "jravan",
        "source_record_id": f"SE:{rid}:{horse_no}",
        "raw_uri": f"bronze/jravan/{rid}.dat",
        "content_hash": f"hash-r{rid}-{horse_no}",
        "ingested_at": datetime(2026, 6, 14, 20, 0, tzinfo=timezone.utc),
        "published_time": datetime(2026, 6, 14, 20, 0, tzinfo=timezone.utc),
        "available_at": _POST_A,
        "year": _part(rid)[0],
        "venue": _part(rid)[1],
    }


def _write_jravan_tables(lake: LakePaths, *, include_results_for: set[str]) -> None:
    """Write jravan_races / jravan_race_entries / jravan_race_results Hive datasets.

    Race A: 2 entries + results -> results_available True, field_size 2.
    Race B: 3 entries, no results -> results_available False, field_size 3.
    """
    races = [_jravan_race_row(_RACE_A), _jravan_race_row(_RACE_B, post=None)]
    entries = [_jravan_entry_row(_RACE_A, 1), _jravan_entry_row(_RACE_A, 2),
               _jravan_entry_row(_RACE_B, 1), _jravan_entry_row(_RACE_B, 2),
               _jravan_entry_row(_RACE_B, 3)]
    results = [
        _jravan_result_row(rid, h, p)
        for rid in include_results_for
        for h, p in ((1, 1), (2, 2))
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    if results:
        write_dataset(results, lake.silver_dataset("jravan_race_results"))


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path)


# --- source resolution ------------------------------------------------------


def test_read_silver_any_prefers_jravan_dataset(lake):
    _write_jravan_tables(lake, include_results_for={_RACE_A})
    rows = _read_silver_any(lake, "races")
    assert {r["race_id"] for r in rows} == {_RACE_A, _RACE_B}
    # jravan extra columns surface here (the mart layer drops them, not the reader)
    assert "race_name" in rows[0]


def test_read_silver_any_falls_back_to_csv_single_file(lake):
    """No jravan_* dir -> read the legacy single-file races.parquet."""
    csv_race = {
        "race_id": _RACE_A, "race_date": datetime(2026, 6, 14, tzinfo=timezone.utc),
        "racecourse": "Hanshin", "country": "JP", "surface": "turf",
        "distance_m": 2000, "scheduled_post_time": _POST_A,
        "source_name": "csv", "source_record_id": "x", "raw_uri": "x",
        "content_hash": "csv-hash", "ingested_at": _POST_A,
        "published_time": _POST_A, "available_at": _POST_A,
    }
    write_parquet([csv_race], lake.silver_table("races"))
    rows = _read_silver_any(lake, "races")
    assert len(rows) == 1
    assert rows[0]["source_name"] == "csv"


def test_read_silver_any_empty_when_neither_exists(lake):
    assert _read_silver_any(lake, "races") == []
    assert _read_silver_any(lake, "race_entries") == []


# --- races mart built from jravan_* -----------------------------------------


def test_races_mart_from_jravan_has_exact_column_set(lake):
    _write_jravan_tables(lake, include_results_for={_RACE_A})
    out = refresh_marts(lake)
    rows = read_parquet(lake.mart(MART_RACES))
    assert out[MART_RACES] == 2
    assert rows  # non-empty
    # every row carries EXACTLY the documented 11 columns (jravan extras dropped)
    for r in rows:
        assert set(r.keys()) == _RACES_MART_COLS


def test_races_mart_from_jravan_computes_field_size_and_results_available(lake):
    _write_jravan_tables(lake, include_results_for={_RACE_A})
    refresh_marts(lake)
    by_id = {r["race_id"]: r for r in read_parquet(lake.mart(MART_RACES))}

    a = by_id[_RACE_A]
    assert a["field_size"] == 2
    assert a["results_available"] is True
    assert a["racecourse"] == "Hanshin"
    assert a["country"] == "JP"
    assert a["source_name"] == "jravan"
    assert a["content_hash"] == f"hash-{_RACE_A}"
    # scheduled_post_time round-trips as the same instant
    assert a["scheduled_post_time"].astimezone(timezone.utc) == _POST_A

    b = by_id[_RACE_B]
    assert b["field_size"] == 3
    assert b["results_available"] is False
    assert b["scheduled_post_time"] is None  # NULL post time surfaces as None
    # grade normalized from grade_code 'A' -> 'G1' (spec-derived map).
    assert a["grade"] == "G1"
    assert b["grade"] == "G1"
    # netkeiba_race_id is absent on JV-Link-only rows -> None.
    assert a["netkeiba_race_id"] is None


# --- CSV fallback still builds the mart --------------------------------------


def test_races_mart_falls_back_to_csv_source_when_no_jravan(lake):
    """Legacy single-file silver tables still build the mart (the CSV tests stay green)."""
    csv_race = {
        "race_id": _RACE_A, "race_date": datetime(2026, 6, 14, tzinfo=timezone.utc),
        "racecourse": "Hanshin", "country": "JP", "surface": "turf",
        "distance_m": 2000, "scheduled_post_time": _POST_A,
        "source_name": "csv", "source_record_id": "x", "raw_uri": "x",
        "content_hash": "csv-hash", "ingested_at": _POST_A,
        "published_time": _POST_A, "available_at": _POST_A,
    }
    csv_entry = {
        "race_id": _RACE_A, "horse_id": "0000000001", "horse_number": 1,
        "horse_name": "h1", "jockey_id": "j1", "trainer_id": "t1", "gate": 1,
        "carried_weight_kg": 57, "source_name": "csv", "source_record_id": "x",
        "raw_uri": "x", "content_hash": "c-e", "ingested_at": _POST_A,
        "published_time": _POST_A, "available_at": _POST_A,
    }
    write_parquet([csv_race], lake.silver_table("races"))
    write_parquet([csv_entry], lake.silver_table("race_entries"))
    # no results -> results_available False; no jravan dirs at all
    refresh_marts(lake)
    rows = read_parquet(lake.mart(MART_RACES))
    assert len(rows) == 1
    assert set(rows[0].keys()) == _RACES_MART_COLS
    assert rows[0]["field_size"] == 1
    assert rows[0]["results_available"] is False
    assert rows[0]["source_name"] == "csv"


# --- precedence: jravan wins when both exist --------------------------------


def test_jravan_preferred_over_csv_when_both_present(lake):
    _write_jravan_tables(lake, include_results_for={_RACE_A})
    # CSV table carries a DIFFERENT race that must NOT surface when jravan exists
    csv_only = {
        "race_id": "jra-20260614-09-09", "race_date": datetime(2026, 6, 14, tzinfo=timezone.utc),
        "racecourse": "Hanshin", "country": "JP", "surface": "turf", "distance_m": 1800,
        "scheduled_post_time": None, "source_name": "csv", "source_record_id": "x",
        "raw_uri": "x", "content_hash": "csv-only", "ingested_at": _POST_A,
        "published_time": _POST_A, "available_at": _POST_A,
    }
    write_parquet([csv_only], lake.silver_table("races"))

    refresh_marts(lake)
    ids = {r["race_id"] for r in read_parquet(lake.mart(MART_RACES))}
    assert ids == {_RACE_A, _RACE_B}  # jravan wins; CSV-only race excluded


# --- grade normalization + cross-source coalesce ----------------------------


def test_races_mart_normalizes_grade_from_grade_code(lake):
    """grade_code letters (spec table) -> canonical grade label."""
    races = [
        {**_jravan_race_row("jra-20260614-09-01"), "grade_code": "A"},  # G1
        {**_jravan_race_row("jra-20260614-09-02"), "grade_code": "B"},  # G2
        {**_jravan_race_row("jra-20260614-09-03"), "grade_code": "C"},  # G3
        {**_jravan_race_row("jra-20260614-09-04"), "grade_code": "D"},  # non-graded stakes
        {**_jravan_race_row("jra-20260614-09-05"), "grade_code": "E"},  # special
        {**_jravan_race_row("jra-20260614-09-06"), "grade_code": "L"},  # listed
        {**_jravan_race_row("jra-20260614-09-07"), "grade_code": None},  # unknown
        {**_jravan_race_row("jra-20260614-09-08"), "grade_code": "F"},  # JG1 (jump)
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    refresh_marts(lake)
    by_id = {r["race_id"]: r for r in read_parquet(lake.mart(MART_RACES))}

    assert by_id["jra-20260614-09-01"]["grade"] == "G1"
    assert by_id["jra-20260614-09-02"]["grade"] == "G2"
    assert by_id["jra-20260614-09-03"]["grade"] == "G3"
    assert by_id["jra-20260614-09-04"]["grade"] is None  # non-graded
    assert by_id["jra-20260614-09-05"]["grade"] is None  # special
    assert by_id["jra-20260614-09-06"]["grade"] is None  # listed
    assert by_id["jra-20260614-09-07"]["grade"] is None  # unknown
    assert by_id["jra-20260614-09-08"]["grade"] == "JG1"  # jump grade


def _nk_race_row(rid: str, *, nk_id: str = "202606090301", grade_code: str | None = "C") -> dict[str, Any]:
    """netkeiba_races silver row shape (mirrors what adapters/netkeiba_races.py
    will write). Carries the same shape as jravan_races PLUS netkeiba_race_id;
    written to its own silver table so the JV-Link silver schema stays clean."""
    base = _jravan_race_row(rid)
    base.update({
        "source_name": "netkeiba",
        "content_hash": f"hash-nk-{rid}",
        "netkeiba_race_id": nk_id,
        "grade_code": grade_code,
    })
    return base


def test_races_mart_dedupes_by_race_id_preferring_jravan(lake):
    """When JV-Link + netkeiba both have a row for the same race_id, the mart
    shows ONE row (JV-Link preferred) but coalesces netkeiba-only fields.
    Each source writes to its OWN silver table (jravan_races vs netkeiba_races)
    so the JV-Link schema stays byte-identical."""
    jra_row = _jravan_race_row(_RACE_A)
    jra_row["content_hash"] = "jravan-hash"  # pin for the cross-source assertion
    nk_row = _nk_race_row(_RACE_A, nk_id="202606090301")
    write_dataset([jra_row], lake.silver_dataset("jravan_races"))
    write_dataset([nk_row], lake.silver_dataset("netkeiba_races"))

    refresh_marts(lake)
    rows = read_parquet(lake.mart(MART_RACES))
    assert len(rows) == 1
    only = rows[0]
    # JV-Link preferred -> its content_hash surfaces.
    assert only["content_hash"] == "jravan-hash"
    assert only["source_name"] == "jravan"
    # netkeiba-only field coalesces across tables so self-resolving track can
    # still look up the nk id on a JV-Link-covered race.
    assert only["netkeiba_race_id"] == "202606090301"


def test_races_mart_keeps_netkeiba_row_when_no_jravan(lake):
    """Pre-market scrape: only the netkeiba row exists yet. It surfaces as-is."""
    nk_row = _nk_race_row(_RACE_A, nk_id="202606090301", grade_code="C")
    write_dataset([nk_row], lake.silver_dataset("netkeiba_races"))

    refresh_marts(lake)
    rows = read_parquet(lake.mart(MART_RACES))
    assert len(rows) == 1
    only = rows[0]
    assert only["source_name"] == "netkeiba"
    assert only["netkeiba_race_id"] == "202606090301"
    assert only["grade"] == "G3"
