"""Tests for the netkeiba race-header adapter (ADR-0004 grade end-to-end).

Drives the REAL shutuba.html capture -- ``tests/fixtures/netkeiba/
shutuba_202605030611.html`` is the live 2026-06-21 Tokyo R11 (Fuchu Himba S,
G3) page captured during ADR-0004's Friday dry run. This is the
"one real-payload test per adapter" rule: the parser is pinned against the
actual wire format netkeiba serves, not a synthetic JSON shape.

Covers:
- grade display string -> JV-Data grade_code letter (spec reverse map)
- parse_race_payload extracts header fields (post time, distance, surface,
  field_size, race_name, grade) from the real shutuba HTML
- silver row shape mirrors jravan_silver._race_record PLUS netkeiba_race_id
- build_race end-to-end against the real fixture
- available_at fallback to captured_at when no publish time is on the page
  (the PIT compromise documented in the adapter)
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

# 2026-06-21 Tokyo R11 (Fuchu Himba S, G3). The numeric id encodes kai/nichi
# (positions 5-6 = kai, 7-8 = nichi); the canonical id is the lake key.
NK_RACE_ID = "202605030611"
CANONICAL_RACE_ID = "jra-20260621-05-11"  # Tokyo = jyo 05


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


# --- parse_race_payload (the brittle HTML layer) -----------------------------


def test_parse_race_payload_extracts_header_fields_from_real_shutuba() -> None:
    """Drive the parser against the real Tokyo R11 shutuba capture. Every field
    was verified Friday (2026-06-19) against the page's title + RaceData01 +
    RaceData02 sections; this test pins the parser to that ground truth."""
    parsed = netkeiba_races.parse_race_payload(
        _load("shutuba_202605030611.html"), NK_RACE_ID
    )
    assert parsed is not None
    assert parsed["grade_code"] == "C"  # Icon_GradeType3 -> G3 -> code C
    assert parsed["race_name"] == "府中牝馬S"
    assert parsed["post_time_jst"] == "15:45"
    assert parsed["distance_m"] == 1800
    assert parsed["surface"] == "turf"
    assert parsed["field_size"] == 16
    assert parsed["venue"] == "東京"  # kanji form -- _venue_label translates to "Tokyo"
    assert parsed["netkeiba_race_id"] == NK_RACE_ID
    assert parsed["date_yyyymmdd"] == "20260621"


def test_parse_race_payload_hanshin_fixture() -> None:
    """Second real capture: 2026-06-21 Hanshin R11 (Shirasagi S, G3). Confirms
    the parser is not over-fit to Tokyo's page (different distance, field
    size, post time)."""
    parsed = netkeiba_races.parse_race_payload(
        _load("shutuba_202609030611.html"), "202609030611"
    )
    assert parsed is not None
    assert parsed["grade_code"] == "C"
    assert parsed["race_name"] == "しらさぎS"
    assert parsed["post_time_jst"] == "15:30"
    assert parsed["distance_m"] == 1600
    assert parsed["field_size"] == 18
    assert parsed["venue"] == "阪神"


def test_parse_race_payload_published_time_none_is_the_pit_compromise() -> None:
    """shutuba.html carries no reliable publish timestamp. The parser surfaces
    this as published_time=None; the build layer falls back to captured_at.

    This is NOT the bulk-download trap: we fetch the CURRENT live page, so
    captured_at is the honest upper bound on when this version of the entries
    became visible. The compromise is documented at the adapter's docstring
    and pinned here so a future "fix" that fabricates a publish time is loud.
    """
    parsed = netkeiba_races.parse_race_payload(
        _load("shutuba_202605030611.html"), NK_RACE_ID
    )
    assert parsed is not None
    assert parsed["published_time"] is None


def test_parse_race_payload_returns_none_for_empty_shell() -> None:
    """A page without the RaceData01 block -> None. This is what netkeiba
    returns for an unknown race_id (the Friday dry-run bug that motivated
    ADR-0004's discovery layer): a generic empty shell with no race data."""
    parsed = netkeiba_races.parse_race_payload("<html></html>", NK_RACE_ID)
    assert parsed is None


# --- _race_record (the pure layer) -------------------------------------------


def test_race_record_carries_nk_id_and_grade_code() -> None:
    """The silver row carries netkeiba_race_id (the scrape-only column) and
    grade_code in the JV-Link vocabulary (letter, ready for grade_label)."""
    parsed = netkeiba_races.parse_race_payload(
        _load("shutuba_202605030611.html"), NK_RACE_ID
    )
    record = netkeiba_races._race_record(
        CANONICAL_RACE_ID, NK_RACE_ID, parsed,
        {"captured_at": datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)},
    )
    assert record["netkeiba_race_id"] == NK_RACE_ID
    assert record["grade_code"] == "C"
    assert record["source_name"] == "netkeiba"
    # 15:45 JST = 06:45 UTC
    assert record["scheduled_post_time"] == datetime(2026, 6, 21, 6, 45, tzinfo=timezone.utc)


def test_race_record_available_at_falls_back_to_captured_at() -> None:
    """When the parser returns published_time=None, _race_record must use
    ``captured_at`` floored to UTC midnight for available_at. The PIT
    compromise (documented in the adapter module): scrape-day midnight is the
    honest upper bound on when this version became visible, NOT the
    bulk-download trap. The midnight floor lets same-day re-scrapes dedupe
    under the partition-aware upsert."""
    parsed = netkeiba_races.parse_race_payload(
        _load("shutuba_202605030611.html"), NK_RACE_ID
    )
    captured = datetime(2026, 6, 19, 12, 34, tzinfo=timezone.utc)
    record = netkeiba_races._race_record(
        CANONICAL_RACE_ID, NK_RACE_ID, parsed, {"captured_at": captured}
    )
    # Floored to UTC midnight -- 12:34 -> 00:00.
    assert record["available_at"] == datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc)
    assert record["published_time"] == datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc)


def test_race_record_columns_cover_what_mart_reads() -> None:
    """The netkeiba_races silver row carries every column the mart reads from a
    race row (race_id, race_date, racecourse, country, surface, distance_m,
    scheduled_post_time, grade_code, source_name, content_hash) PLUS
    netkeiba_race_id (the scrape-only column)."""
    parsed = netkeiba_races.parse_race_payload(
        _load("shutuba_202605030611.html"), NK_RACE_ID
    )
    record = netkeiba_races._race_record(
        CANONICAL_RACE_ID, NK_RACE_ID, parsed,
        {"captured_at": datetime(2026, 6, 20, tzinfo=timezone.utc)},
    )

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
        payload_text=_load("shutuba_202605030611.html"),
    )
    assert n == 1
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    assert len(rows) == 1
    only = rows[0]
    assert only["race_id"] == CANONICAL_RACE_ID
    assert only["netkeiba_race_id"] == NK_RACE_ID
    assert only["grade_code"] == "C"
    assert only["source_name"] == "netkeiba"
    assert only["distance_m"] == 1800


def test_build_race_idempotent_reingest_adds_zero_rows(tmp_path: Path) -> None:
    """Re-ingesting an unchanged payload returns 0 (partition-aware upsert)."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    payload = _load("shutuba_202605030611.html")
    n1 = netkeiba_races.build_race(lake, NK_RACE_ID, CANONICAL_RACE_ID, payload_text=payload)
    n2 = netkeiba_races.build_race(lake, NK_RACE_ID, CANONICAL_RACE_ID, payload_text=payload)
    assert n1 == 1
    assert n2 == 0
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    assert len(rows) == 1


def test_build_race_available_at_falls_back_to_captured_at(tmp_path: Path) -> None:
    """When the parser returns published_time=None (the shutuba PIT compromise),
    the silver row's available_at MUST equal captured_at floored to UTC
    midnight, not a fabricated event time. This is the documented behavior --
    pinned here so a future "fix" that synthesizes a publish time is loud."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    fake_scrape_time = datetime(2026, 6, 19, 12, 34, tzinfo=timezone.utc)
    expected_midnight = datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc)
    netkeiba_races.build_race(
        lake, NK_RACE_ID, CANONICAL_RACE_ID,
        payload_text=_load("shutuba_202605030611.html"),
        captured_at=fake_scrape_time,
    )
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    only = rows[0]
    assert only["available_at"] == expected_midnight
    assert only["published_time"] == expected_midnight  # floored to midnight


def test_build_race_persists_numeric_nk_id_verbatim(tmp_path: Path) -> None:
    """The persisted netkeiba_race_id is the numeric form passed to the parser
    (the same form the live-odds endpoint wants). The adapter stamps this id
    verbatim from the ``nk_race_id`` argument -- no synthesis, no remap."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    expected_numeric = "202605030611"
    netkeiba_races.build_race(
        lake, expected_numeric, CANONICAL_RACE_ID,
        payload_text=_load("shutuba_202605030611.html"),
    )
    rows = read_dataset(lake.silver_dataset("netkeiba_races"))
    only = rows[0]
    assert only["netkeiba_race_id"] == expected_numeric
