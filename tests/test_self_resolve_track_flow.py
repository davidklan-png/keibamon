"""End-to-end test for the lookup-free, self-resolving track flow (ADR-0004).

Exercises the WHOLE pipeline the runbook describes:

  1. Card scrape: ``scrape_ingest.py`` writes ``netkeiba_races`` silver rows
     carrying each race's grade_code + scheduled_post_time + netkeiba_race_id.
  2. Mart build: ``refresh_marts`` surfaces those into the ``races`` mart with
     grade normalized (G1/G2/G3/...) and netkeiba_race_id coalesced across
     sources when JV-Link also has the race.
  3. Self-resolving track: ``track --grades G1,G2,G3`` resolves graded race_ids
     + post times + nk ids from the mart -- across multiple venues in one run.

This is the lookup-free path: no hand-entered --venue / --nk-race-ids. A
graded race missing its nk id is named and skipped -- never fabricated (a
wrong nk id = wrong curve, unrecoverable).

The card-scrape step here synthesizes a MINIMAL shutuba-shaped HTML payload
that satisfies :mod:`netkeiba_races`'s parser. The real wire format is far
richer (see ``tests/fixtures/netkeiba/shutuba_*.html`` for full captures);
we keep this synthetic version minimal so the test stays focused on the
self-resolve FLOW rather than wire-format coverage.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.adapters import netkeiba_races
from keibamon_core.ingestion.marts import MART_RACES, refresh_marts
from keibamon_core.lake import read_parquet
from keibamon_core.paths import LakePaths

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"

# venue slug -> kanji (the form shutuba.html's RaceData02 uses). Mirrors
# netkeiba_races._VENUE_KANJI_TO_LABEL.
_VENUE_KANJI: dict[str, str] = {
    "sapporo": "札幌", "hakodate": "函館", "fukushima": "福島",
    "niigata": "新潟", "tokyo": "東京", "nakayama": "中山",
    "chukyo": "中京", "kyoto": "京都", "hanshin": "阪神", "kokura": "小倉",
}

# grade display (GⅠ unicode / None) -> Icon_GradeType class suffix. The parser
# extracts grade_code from the CSS class, not the display string.
_GRADE_DISPLAY_TO_ICON: dict[str, str] = {"GⅠ": "1", "GⅡ": "2", "GⅢ": "3"}


def _race_header_payload(
    *,
    venue: str,
    race_num: int,
    grade_display: str | None,
    post_time_hhmm: str,
    date_yyyymmdd: str = "20260620",
    nk_id: str,
    distance_m: int = 2000,
) -> str:
    """Synthesize a minimal shutuba-shaped HTML payload for one race.

    Includes the three pieces netkeiba_races.parse_race_payload regex-extracts:
    ``<p class="RaceData01">`` (post time + surface/distance),
    ``<div class="RaceData02">`` (venue kanji + N頭), and the
    ``<h1 class="RaceName">`` block with the grade icon span. Everything else
    from the real shutuba page is omitted -- this is a flow test, not a
    parser-coverage test.
    """
    venue_kanji = _VENUE_KANJI.get(venue, venue)
    grade_icon = _GRADE_DISPLAY_TO_ICON.get(grade_display or "")
    grade_span = (
        f'<span class="Icon_GradeType Icon_GradeType{grade_icon}"></span>'
        if grade_icon else ""
    )
    yyyy = int(date_yyyymmdd[:4])
    mm = int(date_yyyymmdd[4:6])
    dd = int(date_yyyymmdd[6:8])
    return f"""<!DOCTYPE html>
<html><head><title>R{race_num} | {yyyy}年{mm}月{dd}日 {venue_kanji}{race_num}R</title></head>
<body>
<div class="RaceList_Item02">
<div class="RaceData01">
{post_time_hhmm}発走 /<span> 芝{distance_m}m</span> (左)
</div>
<div class="RaceData02">
<span>3回</span>
<span>{venue_kanji}</span>
<span>4日目</span>
<span>サラ系３歳以上</span>
<span>オープン</span>
&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
<span>(国際)</span>
<span>定量</span>
<span>16頭</span>
</div>
</div>
<div class="RaceName">
{venue_kanji}{race_num}R
{grade_span}
</div>
</body></html>
"""


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path)


@pytest.fixture
def role_file(tmp_path: Path) -> Path:
    rf = tmp_path / ".device"
    rf.write_text("role = mac-dev\n")
    return rf


def _scrape_one_race(
    lake: LakePaths, *, venue_slug: str, jyo: str, race_num: int,
    grade_display: str | None, post_time_hhmm: str, nk_id: str,
) -> str:
    """Run the card-scrape path for one race (mirrors what
    tools/scrape_ingest.py does after ADR-0004's BUG 1 fix). Returns the
    canonical race_id.

    The lookup_id passed to :func:`netkeiba_races.build_race` is the NUMERIC
    netkeiba id (``20260503041111``) -- the form the live-odds endpoint
    expects. Under the new HTML parser contract, the lookup_id is stamped
    verbatim into the silver row's ``netkeiba_race_id`` column (the page
    itself doesn't repeat the id in a structured field). The canonical
    race_id is still derived via crosswalk from the synthetic slug form."""
    from keibamon_core.ingestion.curve_log import crosswalk_race_id

    synthetic_lookup = f"r-2026-0620-{venue_slug}-{race_num:02d}"
    canonical = crosswalk_race_id(synthetic_lookup)
    body = _race_header_payload(
        venue=venue_slug, race_num=race_num, grade_display=grade_display,
        post_time_hhmm=post_time_hhmm, nk_id=nk_id,
    )
    # Pass nk_id as the lookup (post-BUG-1 contract); the parser stamps it
    # into netkeiba_race_id verbatim.
    n = netkeiba_races.build_race(lake, nk_id, canonical, payload_text=body)
    assert n == 1, f"scrape should write 1 row, got {n}"
    return canonical


# --- Phase 2 acceptance: scrape -> mart carries the self-resolve mapping -------


def test_scrape_then_mart_carries_grade_post_time_and_nk_id(lake: LakePaths) -> None:
    """After a card scrape, the races mart carries a non-null grade label,
    scheduled_post_time, AND netkeiba_race_id for each scraped race."""
    # Scrape two graded races across two venues (Tokyo + Hanshin) plus one
    # non-graded race (which must NOT match the grades filter later).
    _scrape_one_race(
        lake, venue_slug="tokyo", jyo="05", race_num=11,
        grade_display="GⅠ", post_time_hhmm="15:25", nk_id="20260503041111",
    )
    _scrape_one_race(
        lake, venue_slug="hanshin", jyo="09", race_num=11,
        grade_display="GⅢ", post_time_hhmm="15:40", nk_id="20260609031111",
    )
    _scrape_one_race(
        lake, venue_slug="hanshin", jyo="09", race_num=9,
        grade_display=None, post_time_hhmm="14:25", nk_id="20260609030909",
    )

    refresh_marts(lake)
    rows = read_parquet(lake.mart(MART_RACES))
    by_id = {r["race_id"]: r for r in rows}

    tokyo_g1 = by_id["jra-20260620-05-11"]
    hanshin_g3 = by_id["jra-20260620-09-11"]
    hanshin_open = by_id["jra-20260620-09-09"]

    # Phase 2 contract: scraped rows surface all three fields into the mart.
    assert tokyo_g1["grade"] == "G1"
    assert tokyo_g1["netkeiba_race_id"] == "20260503041111"
    assert tokyo_g1["scheduled_post_time"] is not None
    # post_time stored as UTC; 15:25 JST = 06:25 UTC.
    assert tokyo_g1["scheduled_post_time"].astimezone(timezone.utc) == datetime(
        2026, 6, 20, 6, 25, tzinfo=timezone.utc
    )

    assert hanshin_g3["grade"] == "G3"
    assert hanshin_g3["netkeiba_race_id"] == "20260609031111"

    # Non-graded race: grade None, nk id still surfaces (for completeness).
    assert hanshin_open["grade"] is None
    assert hanshin_open["netkeiba_race_id"] == "20260609030909"


# --- Phase 3 acceptance: self-resolving track --grades ----------------------


def test_self_resolve_track_graded_multi_venue(lake: LakePaths, role_file: Path) -> None:
    """``track --grades G1,G2,G3`` with no --venue resolves graded races across
    multiple venues in one run, pulling netkeiba_race_id + post time from the
    mart. The tools/weekend_run.py:_self_resolve_track function is the
    production path; this exercises the same lake query directly."""
    # Scrape the same three races as above.
    _scrape_one_race(
        lake, venue_slug="tokyo", jyo="05", race_num=11,
        grade_display="GⅠ", post_time_hhmm="15:25", nk_id="20260503041111",
    )
    _scrape_one_race(
        lake, venue_slug="hanshin", jyo="09", race_num=11,
        grade_display="GⅢ", post_time_hhmm="15:40", nk_id="20260609031111",
    )
    _scrape_one_race(
        lake, venue_slug="hanshin", jyo="09", race_num=9,
        grade_display=None, post_time_hhmm="14:25", nk_id="20260609030909",
    )
    refresh_marts(lake)

    # The grades-filtered select is what _self_resolve_track calls internally
    # (via select_specs + a mart-side netkeiba_race_id lookup). Verify it returns
    # the two graded race_ids across BOTH venues. min_field_size=0 because the
    # header-only scrape doesn't yet have entries (realistic pre-market state).
    from keibamon_core.weekend import pipeline
    graded = pipeline.select_specs(
        lake, "20260620", role_file=role_file, include_run=True,
        min_field_size=0, grades=("G1", "G2", "G3"),
    )
    graded_ids = [rid for rid, _pt in graded]
    assert set(graded_ids) == {"jra-20260620-05-11", "jra-20260620-09-11"}
    # Non-graded Hanshin R9 absent.
    assert "jra-20260620-09-09" not in graded_ids

    # Each graded race carries its nk id + post time in the mart, ready for
    # pipeline.track to consume without further lookups.
    by_id = {r["race_id"]: r for r in read_parquet(lake.mart(MART_RACES))}
    for rid, _pt in graded:
        row = by_id[rid]
        assert row["netkeiba_race_id"], f"{rid} missing nk id in mart"
        assert row["scheduled_post_time"], f"{rid} missing post time in mart"


def test_self_resolve_track_loud_warn_on_missing_nk_id(
    lake: LakePaths, role_file: Path, capsys: pytest.CaptureFixture[str],
) -> None:
    """A graded race with no stored netkeiba_race_id is NAMED in a warning and
    SKIPPED -- never silently fabricated. The other graded races still bank."""
    # Scrape one graded race WITH an nk id and another graded race that LACKS
    # one (we hand-write its mart row directly to simulate the gap).
    _scrape_one_race(
        lake, venue_slug="tokyo", jyo="05", race_num=11,
        grade_display="GⅠ", post_time_hhmm="15:25", nk_id="20260503041111",
    )
    refresh_marts(lake)

    # Hand-write a second graded race with NO nk id (the gap scenario: someone
    # forgot to scrape the header for this race).
    from keibamon_core.lake import write_parquet
    rows = read_parquet(lake.mart(MART_RACES))
    rows.append({
        "race_id": "jra-20260620-09-11",
        "race_date": datetime(2026, 6, 20, tzinfo=timezone.utc),
        "racecourse": "Hanshin",
        "country": "JP",
        "surface": "turf",
        "distance_m": 2200,
        "scheduled_post_time": datetime(2026, 6, 20, 6, 40, tzinfo=timezone.utc),
        "field_size": 18,
        "results_available": False,
        "source_name": "jravan",
        "content_hash": "manual",
        "grade": "G1",
        "netkeiba_race_id": None,  # the gap
    })
    write_parquet(rows, lake.mart(MART_RACES))

    # Run the self-resolve function directly (it's a private helper in
    # tools/weekend_run.py; load it via importlib to mirror production code path).
    import importlib.util
    weekend_run_path = Path(__file__).resolve().parent.parent / "tools" / "weekend_run.py"
    spec = importlib.util.spec_from_file_location("weekend_run_under_test", weekend_run_path)
    assert spec is not None and spec.loader is not None
    weekend_run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(weekend_run)

    race_ids, nk_ids, post_times, names = weekend_run._self_resolve_track(
        "20260620", ("G1", "G2", "G3"), lake=lake,
    )

    # Tokyo R11 banks normally.
    assert "jra-20260620-05-11" in race_ids
    assert dict(zip(race_ids, nk_ids))["jra-20260620-05-11"] == "20260503041111"
    # Hanshin R11 (no nk id) is SKIPPED, never fabricated.
    assert "jra-20260620-09-11" not in race_ids

    # The skipped race is NAMED in a stderr warning (the loud-fail contract).
    captured = capsys.readouterr()
    assert "jra-20260620-09-11" in captured.err
    assert "netkeiba_race_id" in captured.err


def test_self_resolve_track_requires_grades_without_venue(
    lake: LakePaths, capsys: pytest.CaptureFixture[str],
) -> None:
    """--venue absent AND --grades absent -> clear error rather than a silent
    surprise. This is the guardrail against accidentally running the unfiltered
    track without nk ids."""
    import importlib.util
    weekend_run_path = Path(__file__).resolve().parent.parent / "tools" / "weekend_run.py"
    spec = importlib.util.spec_from_file_location("weekend_run_under_test", weekend_run_path)
    assert spec is not None and spec.loader is not None
    weekend_run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(weekend_run)

    # Build an argparse Namespace like the CLI would after parsing.
    import argparse
    args = argparse.Namespace(
        date="20260620",
        venue=None,
        grades=None,
        races=None,
        nk_race_ids=None,
        post_times_jst=None,
        poll_seconds=120,
        no_sleep_inhibit=True,
        max_cycles=1,
    )
    with pytest.raises(SystemExit) as exc_info:
        weekend_run._run_track(args)
    # Error message names both modes.
    assert "--grades" in str(exc_info.value)
    assert "--venue" in str(exc_info.value)
