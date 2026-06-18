"""Tests for the netkeiba race-header adapter (ADR-0004 grade end-to-end).

Covers:
- grade display string -> JV-Data grade_code letter (spec reverse map)
- parse_race_payload happy path + open/maiden race (grade=None)
- silver row shape mirrors jravan_silver._race_record PLUS netkeiba_race_id
- build_race end-to-end with the test fixture
- available_at = published event time, NEVER scrape time (the PIT trap)
- idempotent re-ingest adds zero rows
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")

from keibamon_core.adapters import netkeiba_races
from keibamon_core.adapters.jravan import GRADE_CODE_MAP, grade_label
from keibamon_core.ingestion import jravan_silver
from keibamon_core.lake import read_dataset
from keibamon_core.paths import LakePaths

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"

NK_RACE_ID = "20260609031111"  # the raw netkeiba numeric id (kai/nichi encoded)
CANONICAL_RACE_ID = "jra-20260620-09-11"  # Hanshin (jyo 09 per project map), R11


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# --- grade display -> code (the spec reverse map) ----------------------------


def test_parse_grade_handles_unicode_roman_numerals() -> None:
    """netkeiba's canonical form: G with unicode roman numerals (Ⅰ=U+2160...)."""
    assert netkeiba_races.parse_grade("GⅠ") == "A"
    assert netkeiba_races.parse_grade("GⅡ") == "B"
    assert netkeiba_races.parse_grade("GⅢ") == "C"


def test_parse_grade_handles_parens_and_whitespace() -> None:
    """netkeiba wraps the grade symbol in parens on the race-card header."""
    assert netkeiba_races.parse_grade("(GⅢ)") == "C"
    assert netkeiba_races.parse_grade(" ( GⅡ ) ") == "B"
    # full-width parens too (some endpoints)
    assert netkeiba_races.parse_grade("（GⅠ）") == "A"


def test_parse_grade_handles_ascii_fallback() -> None:
    """Some endpoints emit ASCII G1/G2/G3 -- map to the same letters."""
    assert netkeiba_races.parse_grade("G1") == "A"
    assert netkeiba_races.parse_grade("G2") == "B"
    assert netkeiba_races.parse_grade("G3") == "C"


def test_parse_grade_handles_jump_prefix() -> None:
    """Jump grades: J・GⅠ (middle-dot). The 障害 grades are separable from flat
    (codes F/G/H) and default OUT of GRADED_DEFAULT."""
    assert netkeiba_races.parse_grade("J・GⅠ") == "F"
    assert netkeiba_races.parse_grade("J・GⅡ") == "G"
    assert netkeiba_races.parse_grade("J・GⅢ") == "H"
    # JG1 not graded by default (JRA flat only).
    assert grade_label(netkeiba_races.parse_grade("J・GⅠ")) == "JG1"
    assert "JG1" not in {"G1", "G2", "G3"}


def test_parse_grade_none_for_non_graded() -> None:
    """Maiden / open / listed / special races are NOT graded -> None."""
    assert netkeiba_races.parse_grade(None) is None
    assert netkeiba_races.parse_grade("") is None
    assert netkeiba_races.parse_grade("オープン") is None
    assert netkeiba_races.parse_grade("500万") is None
    assert netkeiba_races.parse_grade("リステッド") is None  # 'listed' -> code L not in our map
    assert netkeiba_races.parse_grade("未勝利") is None


def test_grade_reverse_map_round_trips_with_grade_code_map() -> None:
    """Every value in GRADE_CODE_MAP has a corresponding display string in the
    adapter's reverse map (the two never drift)."""
    for display, code in netkeiba_races._GRADE_DISPLAY_TO_CODE.items():
        assert code in GRADE_CODE_MAP, f"unknown code {code!r} for display {display!r}"
    # Spot-check the canonical round-trip: GⅠ display -> A code -> G1 label.
    assert grade_label(netkeiba_races.parse_grade("GⅠ")) == "G1"


# --- parse_race_payload (the brittle layer) ----------------------------------


def test_parse_race_payload_extracts_header_fields() -> None:
    parsed = netkeiba_races.parse_race_payload(
        _load("race_header_graded.json"), NK_RACE_ID
    )
    assert parsed is not None
    assert parsed["grade_code"] == "A"  # GⅠ
    assert parsed["race_name"] == "Takarazuka Kinen"
    assert parsed["post_time_jst"] == "15:40"
    assert parsed["distance_m"] == 2200
    assert parsed["venue"] == "hanshin"
    assert parsed["published_time"] == datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)


def test_parse_race_payload_open_race_grade_none() -> None:
    """2-year-old maiden race -- grade=None on the source -> grade_code None."""
    parsed = netkeiba_races.parse_race_payload(
        _load("race_header_open.json"), "20260609031101"
    )
    assert parsed is not None
    assert parsed["grade_code"] is None


def test_parse_race_payload_raises_on_missing_event_time() -> None:
    """No event-time field -> loud raise (the available_at_bulk_download trap)."""
    import json

    body = json.dumps({"status": "ok", "data": {"race_name": "X"}})
    with pytest.raises(ValueError, match="event-time"):
        netkeiba_races.parse_race_payload(body, NK_RACE_ID)


# --- _race_record (the pure layer) -------------------------------------------


def test_race_record_carries_nk_id_and_grade_code() -> None:
    """The silver row carries netkeiba_race_id (the scrape-only column) and
    grade_code in the JV-Link vocabulary (letter, ready for grade_label)."""
    parsed = netkeiba_races.parse_race_payload(
        _load("race_header_graded.json"), NK_RACE_ID
    )
    record = netkeiba_races._race_record(
        CANONICAL_RACE_ID, NK_RACE_ID, parsed, {}
    )
    assert record["netkeiba_race_id"] == NK_RACE_ID
    assert record["grade_code"] == "A"
    assert record["source_name"] == "netkeiba"
    assert record["scheduled_post_time"] == datetime(2026, 6, 20, 6, 40, tzinfo=timezone.utc)
    # 15:40 JST = 06:40 UTC


def test_race_record_columns_cover_what_mart_reads() -> None:
    """The netkeiba_races silver row carries every column the mart reads from a
    race row (race_id, race_date, racecourse, country, surface, distance_m,
    scheduled_post_time, grade_code, source_name, content_hash) PLUS
    netkeiba_race_id (the scrape-only column). Other jravan-only columns
    (going/weather/last_3f -- race-day-condition fields JV-Link carries but
    netkeiba's race-header does not) are absent; the mart handles them via
    .get() so NULL falls through cleanly."""
    parsed = netkeiba_races.parse_race_payload(
        _load("race_header_graded.json"), NK_RACE_ID
    )
    record = netkeiba_races._race_record(
        CANONICAL_RACE_ID, NK_RACE_ID, parsed, {}
    )

    # The set of columns the mart actually reads from a race row (refresh_marts).
    mart_race_reads = {
        "race_id", "race_date", "racecourse", "country", "surface",
        "distance_m", "scheduled_post_time", "grade_code",
        "source_name", "content_hash",
    }
    have = set(record.keys())
    missing = mart_race_reads - have
    assert missing == set(), f"missing columns the mart reads: {missing}"
    assert "netkeiba_race_id" in have, "scrape-only nk id column must be present"


# --- build_race end-to-end ---------------------------------------------------


def test_build_race_writes_one_row_with_nk_id(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    n = netkeiba_races.build_race(
        lake, NK_RACE_ID, CANONICAL_RACE_ID,
        payload_text=_load("race_header_graded.json"),
    )
    assert n == 1
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    assert len(rows) == 1
    only = rows[0]
    assert only["race_id"] == CANONICAL_RACE_ID
    assert only["netkeiba_race_id"] == NK_RACE_ID
    assert only["grade_code"] == "A"
    assert only["source_name"] == "netkeiba"


def test_build_race_idempotent_reingest_adds_zero_rows(tmp_path: Path) -> None:
    """Re-ingesting an unchanged payload returns 0 (partition-aware upsert)."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    payload = _load("race_header_graded.json")
    n1 = netkeiba_races.build_race(lake, NK_RACE_ID, CANONICAL_RACE_ID, payload_text=payload)
    n2 = netkeiba_races.build_race(lake, NK_RACE_ID, CANONICAL_RACE_ID, payload_text=payload)
    assert n1 == 1
    assert n2 == 0
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    assert len(rows) == 1


def test_build_race_available_at_is_event_time_not_scrape_time(tmp_path: Path) -> None:
    """The available_at_bulk_download PIT trap: available_at MUST be the
    payload's published event time, NEVER the scrape download time."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    fake_scrape_time = datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc)  # next day
    netkeiba_races.build_race(
        lake, NK_RACE_ID, CANONICAL_RACE_ID,
        payload_text=_load("race_header_graded.json"),
        captured_at=fake_scrape_time,
    )
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    only = rows[0]
    # Fixture's official_datetime is "2026-06-20 09:00:00" JST = 00:00 UTC.
    # captured_at was a full day later; available_at must equal the event time.
    assert only["available_at"] == datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)
    assert only["available_at"] != fake_scrape_time


def test_build_race_persists_numeric_nk_id_from_payload_not_lookup(tmp_path: Path) -> None:
    """The persisted netkeiba_race_id is the NUMERIC form (e.g. '20260609031111')
    extracted from the payload, NOT the synthetic lookup id (e.g.
    'r-2026-0620-hanshin-11') the caller passes. The numeric form is what the
    live-odds endpoint wants; it encodes kai/nichi and cannot be derived from
    the canonical id.

    scrape_ingest.py passes the SYNTHETIC form as lookup_id; the persisted
    column still ends up numeric because the adapter extracts it from the
    payload's own race_id field."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    lookup_synthetic = "r-2026-0620-hanshin-11"
    expected_numeric = "20260609031111"  # what the fixture's data.race_id carries
    netkeiba_races.build_race(
        lake, lookup_synthetic, CANONICAL_RACE_ID,
        payload_text=_load("race_header_graded.json"),
    )
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    only = rows[0]
    assert only["netkeiba_race_id"] == expected_numeric
    assert only["netkeiba_race_id"] != lookup_synthetic
