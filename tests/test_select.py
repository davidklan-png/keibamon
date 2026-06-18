"""Tests for weekend stage 1: pipeline.select / select_specs.

Fixture-driven against a tiny ``races`` mart written via ``write_parquet``
(the same path ``ingestion.marts.refresh_marts`` produces). No real lake
needed -- the mart is a plain parquet file at ``lake.mart(MART_RACES)``.

The default filter is the PIT-honest upcoming set: ``race_date == target AND
field_size >= 1 AND results_available == False``. These tests pin that
contract plus the venue/races subsetting, the sort order (scheduled_post_time
NULLS LAST, then race_id), the empty-result-no-raise contract, and the device
guard.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.ingestion.marts import MART_RACES
from keibamon_core.lake import write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline
from keibamon_core.weekend.pipeline import WrongDeviceError

_TARGET_DAY = "20260620"


def _race(
    rid: str,
    *,
    date: str = _TARGET_DAY,
    racecourse: str = "hanshin",
    post_hour: int | None = None,
    field_size: int = 12,
    results_available: bool = False,
) -> dict[str, Any]:
    """One races-mart row. ``post_hour`` None -> NULL scheduled_post_time."""
    post_time = (
        datetime(2026, 6, 20, post_hour, 0, tzinfo=timezone.utc)
        if post_hour is not None
        else None
    )
    return {
        "race_id": rid,
        "race_date": datetime.strptime(date, "%Y%m%d").replace(tzinfo=timezone.utc),
        "racecourse": racecourse,
        "country": "JP",
        "surface": "turf",
        "distance_m": 2000,
        "scheduled_post_time": post_time,
        "field_size": field_size,
        "results_available": results_available,
        "source_name": "jravan",
        "content_hash": "x" * 16,
    }


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path)


@pytest.fixture
def role_file(tmp_path: Path) -> Path:
    rf = tmp_path / ".device"
    rf.write_text("role = mac-dev\n")
    return rf


@pytest.fixture
def populated_lake(lake: LakePaths) -> LakePaths:
    """A card with the cases the filters must distinguish.

    On the target day (20260620):
      R1  hanshin post 09:00 field 12 upcoming      -> default-in
      R2  hanshin post 10:00 field 10 upcoming      -> default-in
      R3  fukushima post 11:00 field 14 upcoming    -> default-in (other venue)
      R5  hanshin post 12:00 field 0  upcoming      -> dropped (not carded)
      R7  hanshin post 13:00 field 8  results=True  -> dropped (already run)
      R9  hanshin post NULL  field 9  upcoming      -> default-in, NULLS LAST
      R11 hanshin post 15:00 field 18 upcoming      -> default-in
    Wrong date (20260621):
      N1  hanshin post 09:00 field 12 upcoming      -> dropped (wrong date)
    """
    rows = [
        _race("jra-20260620-09-01", post_hour=9, field_size=12),
        _race("jra-20260620-09-02", post_hour=10, field_size=10),
        _race("jra-20260620-06-03", racecourse="fukushima", post_hour=11, field_size=14),
        _race("jra-20260620-09-05", post_hour=12, field_size=0),
        _race("jra-20260620-09-07", post_hour=13, field_size=8, results_available=True),
        _race("jra-20260620-09-09", post_hour=None, field_size=9),
        _race("jra-20260620-09-11", post_hour=15, field_size=18),
        _race("jra-20260621-09-01", date="20260621", post_hour=9, field_size=12),
    ]
    write_parquet(rows, lake.mart(MART_RACES))
    return lake


# --- the default filter -----------------------------------------------------


def test_default_select_returns_upcoming_sorted_by_post_time_nulls_last(
    populated_lake, role_file
):
    """Upcoming + field>=1, sorted by post time with NULL post times last."""
    ids = pipeline.select(populated_lake, _TARGET_DAY, role_file=role_file)
    assert ids == [
        "jra-20260620-09-01",  # 09:00
        "jra-20260620-09-02",  # 10:00
        "jra-20260620-06-03",  # 11:00 (fukushima -- no venue filter)
        "jra-20260620-09-11",  # 15:00
        "jra-20260620-09-09",  # NULL -> NULLS LAST
    ]


def test_wrong_date_returns_empty(populated_lake, role_file):
    assert pipeline.select(populated_lake, "20260101", role_file=role_file) == []


def test_missing_mart_returns_empty(lake, role_file):
    """No mart file at all is a valid 'no card' state -- return [], don't raise."""
    assert pipeline.select(lake, _TARGET_DAY, role_file=role_file) == []
    # select_specs shares the early-return; verify it directly too.
    assert pipeline.select_specs(lake, _TARGET_DAY, role_file=role_file) == []


# --- results_available gate -------------------------------------------------


def test_results_excluded_by_default_included_with_include_run(
    populated_lake, role_file
):
    default_ids = pipeline.select(populated_lake, _TARGET_DAY, role_file=role_file)
    assert "jra-20260620-09-07" not in default_ids  # results_available=True

    run_ids = pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file, include_run=True
    )
    assert "jra-20260620-09-07" in run_ids
    # R7 posts 13:00 -> sorts between R3 (11:00) and R11 (15:00)
    assert run_ids.index("jra-20260620-09-07") < run_ids.index("jra-20260620-09-11")


# --- min_field_size ---------------------------------------------------------


def test_min_field_size_drops_uncarded_races(populated_lake, role_file):
    # default (min_field_size=1) drops R5 (field 0)
    default_ids = pipeline.select(populated_lake, _TARGET_DAY, role_file=role_file)
    assert "jra-20260620-09-05" not in default_ids

    # min_field_size=0 includes R5 (posts 12:00 -> between R3 and R11)
    wide = pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file, min_field_size=0
    )
    assert "jra-20260620-09-05" in wide
    assert wide.index("jra-20260620-06-03") < wide.index("jra-20260620-09-05")


# --- venue + races subsetting ----------------------------------------------


def test_venue_filter_matches_racecourse_case_insensitive(populated_lake, role_file):
    hanshin = pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file, venue="hanshin"
    )
    assert "jra-20260620-06-03" not in hanshin  # fukushima dropped
    assert "jra-20260620-09-01" in hanshin

    # case-insensitive on the venue arg (LOWER(racecourse) = LOWER(?))
    caps = pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file, venue="Hanshin"
    )
    assert caps == hanshin


def test_races_subset_filters_by_race_number(populated_lake, role_file):
    ids = pipeline.select(populated_lake, _TARGET_DAY, role_file=role_file, races=[3])
    assert ids == ["jra-20260620-06-03"]  # R3 is the fukshima race, number 3


def test_venue_and_races_compose(populated_lake, role_file):
    # races=[1,3] without venue -> R1 (hanshin) + R3 (fukushima)
    both = pipeline.select(populated_lake, _TARGET_DAY, role_file=role_file, races=[1, 3])
    assert both == ["jra-20260620-09-01", "jra-20260620-06-03"]

    # composed with venue=hanshin, R3 (fukushima) is dropped at the SQL layer
    composed = pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file, venue="hanshin", races=[1, 3]
    )
    assert composed == ["jra-20260620-09-01"]


# --- select_specs -----------------------------------------------------------


def test_select_specs_returns_post_time_tuples(populated_lake, role_file):
    specs = pipeline.select_specs(
        populated_lake, _TARGET_DAY, role_file=role_file, venue="hanshin"
    )
    assert all(isinstance(t, tuple) and len(t) == 2 for t in specs)
    # order matches select()
    assert [rid for rid, _pt in specs] == pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file, venue="hanshin"
    )
    by_rid = dict(specs)
    # NULL scheduled_post_time surfaces as None (not a coerced epoch)
    assert by_rid["jra-20260620-09-09"] is None
    # the 09:00 UTC instant round-trips; compare instants because DuckDB
    # projects TIMESTAMPTZ to the session tz on read (memory: display gotcha).
    pt = by_rid["jra-20260620-09-01"]
    assert pt is not None
    assert pt.astimezone(timezone.utc) == datetime(2026, 6, 20, 9, 0, tzinfo=timezone.utc)


def test_select_specs_and_select_agree_on_order(populated_lake, role_file):
    specs = pipeline.select_specs(populated_lake, _TARGET_DAY, role_file=role_file)
    assert [rid for rid, _ in specs] == pipeline.select(
        populated_lake, _TARGET_DAY, role_file=role_file
    )


# --- device guard + input parsing ------------------------------------------


def test_wrong_device_raises(populated_lake, tmp_path):
    rf = tmp_path / ".device"
    rf.write_text("role = capture-pc\n")
    with pytest.raises(WrongDeviceError):
        pipeline.select(populated_lake, _TARGET_DAY, role_file=rf)


def test_no_role_file_raises(populated_lake, tmp_path):
    # A role_file path that does not exist -> current_role returns None -> refuse.
    # Deterministic (doesn't depend on the repo's real .device).
    missing = tmp_path / "missing.device"
    with pytest.raises(WrongDeviceError):
        pipeline.select(populated_lake, _TARGET_DAY, role_file=missing)


def test_normalize_race_date_accepts_both_formats():
    assert pipeline._normalize_race_date("20260620") == pipeline._normalize_race_date(
        "2026-06-20"
    )
    with pytest.raises(ValueError):
        pipeline._normalize_race_date("not-a-date")


def test_accepts_iso_date_input(populated_lake, role_file):
    """The CLI passes YYYYMMDD, but YYYY-MM-DD is also accepted (robustness)."""
    assert pipeline.select(populated_lake, "2026-06-20", role_file=role_file) == (
        pipeline.select(populated_lake, _TARGET_DAY, role_file=role_file)
    )
