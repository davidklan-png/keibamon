"""Tests for ``netkeiba_discovery.discover_card`` — the day-index bootstrap
that supplies numeric netkeiba ids the rest of the scrape-sourced path needs.

The Phase-2 assumption that ``netkeiba_race_id`` could be synthesized from
``(date, venue, raceno)`` is wrong: the id encodes ``kai``/``nichi``, which
aren't recoverable from the calendar date. Discovery fetches the day's
race-list page once and reads each race's numeric id off the
``shutuba.html?race_id=…`` href. This module pins:

  - The fixture (a real 2026-06-21 capture) parses cleanly and yields the
    expected races.
  - The two GⅢ on 2026-06-21 (Fuchu Himba S @ Tokyo, Shirasagi S @ Hanshin)
    are correctly identified, with the verified numeric ids (202605030611,
    202609030611) and JST post times (15:45 / 15:30).
  - Venue digits in the numeric id ARE the JRA track codes (05=Tokyo,
    09=Hanshin) — no remap.
  - A malformed/empty page returns ``[]`` (cancellation / future date).
  - The fetch seam (``fetch_fn=``) keeps tests offline.

This is the real-payload test for the discovery layer — the fixture is the
live capture from ADR-0004's Friday dry run, not synthetic JSON. The same
"bake in a real-payload test" rule applies to every scrape adapter.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

from keibamon_core.adapters.netkeiba_discovery import (
    DiscoveredRace,
    discover_card,
)

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"
REAL_LIST_20260621 = FIXTURES / "race_list_20260621.html"


@pytest.fixture
def race_list_html() -> str:
    """The real 2026-06-21 race-list page (Friday's live capture)."""
    return REAL_LIST_20260621.read_text(encoding="utf-8")


@pytest.fixture
def discovered(race_list_html: str) -> list[DiscoveredRace]:
    """All races on 2026-06-21, parsed via the test fetch seam."""
    return discover_card(
        "20260621", fetch_fn=lambda _date: race_list_html
    )


# --- the day-index bootstrap contract ----------------------------------------


def test_real_fixture_yields_three_meetings_36_races(discovered):
    """2026-06-21 is a 3-venue Sunday (Tokyo + Hanshin + Hakodate). Each
    venue cards 12 races → 36 discovered races total. The fixture is the
    live capture; this is the real-payload test for the parser."""
    assert len(discovered) == 36
    venues = {d.venue_code for d in discovered}
    # Three distinct venues on this Sunday.
    assert len(venues) == 3


def test_grades_filter_via_post_parse_finds_the_two_g3(discovered):
    """The two GⅢ on 2026-06-21 are exactly the user's expected pair
    (verified Friday against each race's individual shutuba page). Discovery
    surfaces them with grade_label='G3' so the self-resolving track
    (`track --grades G1,G2,G3`) selects them."""
    g3 = [d for d in discovered if d.grade_label == "G3"]
    assert len(g3) == 2
    by_id = {d.numeric_id: d for d in g3}
    assert "202605030611" in by_id  # Fuchu Himba S, Tokyo R11
    assert "202609030611" in by_id  # Shirasagi S, Hanshin R11


def test_fuchu_himba_fields_verified_against_live_page(discovered):
    """The Tokyo GⅢ is Fuchu Himba S, R11, 15:45 JST, 芝1800m. These fields
    were verified Friday against the race's individual shutuba page; this
    test pins discovery's extraction against the same ground truth."""
    tokyo_g3 = next(
        d for d in discovered if d.numeric_id == "202605030611"
    )
    assert tokyo_g3.race_name == "府中牝馬S"
    assert tokyo_g3.grade_label == "G3"
    assert tokyo_g3.venue_code == "05"  # Tokyo per JRA code
    assert tokyo_g3.race_no == 11
    assert tokyo_g3.post_time_jst == "15:45"
    assert tokyo_g3.distance == "芝1800m"
    assert tokyo_g3.field_size == 16
    assert tokyo_g3.canonical_race_id == "jra-20260621-05-11"


def test_shirasagi_fields_verified_against_live_page(discovered):
    """The Hanshin GⅢ is Shirasagi S (しらさぎS), R11, 15:30 JST, 芝1600m.
    Same ground-truth check as the Fuchu Himba test."""
    hanshin_g3 = next(
        d for d in discovered if d.numeric_id == "202609030611"
    )
    assert hanshin_g3.race_name == "しらさぎS"
    assert hanshin_g3.grade_label == "G3"
    assert hanshin_g3.venue_code == "09"  # Hanshein per JRA code
    assert hanshin_g3.race_no == 11
    assert hanshin_g3.post_time_jst == "15:30"
    assert hanshin_g3.distance == "芝1600m"
    assert hanshin_g3.field_size == 18
    assert hanshin_g3.canonical_race_id == "jra-20260621-09-11"


def test_numeric_id_venue_digits_match_jra_codes_no_remap(discovered):
    """ADR-0004 contract: the venue digits at positions 5-6 of the numeric
    id ARE the official JRA track codes (05=Tokyo, 09=Hanshin, 08=Kyoto, …).
    The earlier 'JRA 09=Kyoto' decode was wrong — confirmed by Friday's live
    capture, where id 202609030611's shutuba page renders 阪神/Hanshin. The
    project's canonical ``jra-YYYYMMDD-<jyo>-NN`` id shares the same code;
    no netkeiba-vs-JRA remap belongs in this codebase."""
    # Every numeric id's venue_code matches the canonical id's jyo segment.
    for d in discovered:
        assert d.canonical_race_id.startswith(
            f"jra-20260621-{d.venue_code}-"
        ), f"{d.numeric_id} venue_code mismatch with canonical id"


def test_post_time_utc_conversion_is_jst_to_utc(discovered):
    """15:45 JST = 06:45 UTC (JST is UTC+9). The lake's
    ``scheduled_post_time`` column stores UTC instants; this conversion is
    what `refresh_marts` surfaces for the self-resolving track."""
    tokyo = next(
        d for d in discovered if d.numeric_id == "202605030611"
    )
    utc = tokyo.post_time_utc()
    assert utc is not None
    assert utc.astimezone(timezone.utc) == datetime(
        2026, 6, 21, 6, 45, tzinfo=timezone.utc
    )


def test_grade_icon_word_boundary_does_not_false_match_icon13_or_16(
    race_list_html: str,
):
    """The page uses Icon_GradeType13 (turf surface icon) and
    Icon_GradeType16 (JPN-graded icon) for non-graded metadata. The parser's
    grade extraction MUST be word-bounded so those don't false-match
    Icon_GradeType1/3/6. Only true graded races surface a G label."""
    from keibamon_core.adapters.netkeiba_discovery import _extract_grade

    assert _extract_grade('<span class="Icon_GradeType Icon_GradeType3"></span>') == "G3"
    assert _extract_grade('<span class="Icon_GradeType Icon_GradeType1"></span>') == "G1"
    # Word boundary: 13 / 16 must NOT match.
    assert _extract_grade('<span class="Icon_GradeType Icon_GradeType13"></span>') is None
    assert _extract_grade('<span class="Icon_GradeType Icon_GradeType16"></span>') is None
    # No grade icon at all.
    assert _extract_grade('<li class="RaceList_DataItem ">') is None


def test_empty_page_returns_empty_list_not_raise():
    """A future date with no card published, or a weather cancellation,
    returns []. The discovery layer doesn't distinguish — callers decide."""
    result = discover_card("20260101", fetch_fn=lambda _d: "<html></html>")
    assert result == []


def test_sort_order_is_venue_then_race_no(discovered):
    """The card iterates in (venue_code, race_no) order so the orchestrator
    can sweep a venue's races R1→R12 before moving to the next venue. Stable
    on equal keys preserves the page's running order."""
    keys = [(d.venue_code, d.race_no) for d in discovered]
    assert keys == sorted(keys)


def test_kaisai_date_promise_no_two_races_share_a_canonical_id(discovered):
    """Within one kaisai day, every (venue_code, race_no) pair is unique —
    hence every canonical race_id is unique. This is the invariant that lets
    the orchestrator key per-race silver writes by canonical race_id."""
    canonicals = [d.canonical_race_id for d in discovered]
    assert len(canonicals) == len(set(canonicals))


def test_fetch_fn_seam_keeps_test_offline(monkeypatch):
    """The fetch_fn seam is what keeps the test suite off the network. A
    stub returning a fixture body must never trigger a real HTTP call.

    This test FAILS if anyone removes the ``fetch_fn=`` parameter from
    ``discover_card`` (forcing the network path), because the production
    fetch path would call ``netkeiba_http.fetch_payload`` with a malformed
    URL on this host.

    Note: discover_card now retries by default (R4 -- Tokyo truncation root
    cause). The stub is called multiple times but each call is the stub --
    never the network. ``attempts=1`` is the deterministic-test path that
    still pins the seam.
    """
    # Sentinel: if the fetch_fn is bypassed, this counter stays 0.
    calls = []

    def stub(date_yyyymmdd):
        calls.append(date_yyyymmdd)
        return (FIXTURES / "race_list_20260621.html").read_text(encoding="utf-8")

    result = discover_card("20260621", fetch_fn=stub, attempts=1)
    assert calls == ["20260621"]
    assert len(result) == 36


# ---------------------------------------------------------------------------
# R4 (Tokyo truncation root cause) -- retry-merge in discover_card.
# A single-GET discover was the producer's actual failure mode: netkeiba's
# race_list_sub.html occasionally omits one venue's late races on a single
# fetch, then returns the full card on the next. The retry-merge takes the
# UNION of N attempts so a transient miss in one response is recovered.
# ---------------------------------------------------------------------------


def _build_html(race_ids_by_venue: dict[str, list[str]]) -> str:
    """Synthesize a minimal race-list-sub HTML page that the parser accepts.
    Each race_id is a 12-digit numeric id; venue_code is positions 5-6."""
    items = []
    for venue, rids in race_ids_by_venue.items():
        for rid in rids:
            # Minimal <li> with the href the parser matches + a post_time
            # so _parse_race_list extracts it cleanly.
            items.append(
                f'<li class="RaceList_DataItem">'
                f'<a href="/race/shutuba.html?race_id={rid}&amp;x=1">x</a>'
                f'<span class="RaceList_Itemtime">15:45 </span>'
                f'<span class="ItemTitle">Race</span>'
                f'</li>'
            )
    return "<html><body>" + "".join(items) + "</body></html>"


def _full_card() -> str:
    return _build_html(
        {
            "05": [f"2026050306{i:02d}" for i in range(1, 13)],  # Tokyo R1-R12
            "09": [f"2026090306{i:02d}" for i in range(1, 13)],  # Hanshin R1-R12
            "02": [f"2026020306{i:02d}" for i in range(1, 13)],  # Hakodate R1-R12
        }
    )


def _truncated_card() -> str:
    """Tokyo truncated to R1-R8 -- the verification layer's observed state."""
    return _build_html(
        {
            "05": [f"2026050306{i:02d}" for i in range(1, 9)],  # Tokyo R1-R8 only
            "09": [f"2026090306{i:02d}" for i in range(1, 13)],
            "02": [f"2026020306{i:02d}" for i in range(1, 13)],
        }
    )


def test_retry_merge_recovers_transient_truncation():
    """The R4 fix: the FIRST fetch returns a truncated card (Tokyo R1-R8 only),
    the SECOND returns the full card. Retry-merge takes the UNION so Tokyo R9-R12
    are recovered instead of being published as a truncated snapshot."""
    responses = iter([_truncated_card(), _full_card(), _full_card()])
    result = discover_card(
        "20260621",
        fetch_fn=lambda _d: next(responses),
        attempts=3,
        sleep_s=0,  # no real wait between stub calls
    )
    by_venue = {}
    for r in result:
        by_venue[r.venue_code] = by_venue.get(r.venue_code, 0) + 1
    assert by_venue == {"02": 12, "05": 12, "09": 12}, by_venue
    assert len(result) == 36


def test_retry_merge_persistent_truncation_returns_truncated():
    """If every attempt returns the same truncated card, retry-merge can't
    recover. This is the residual hole the structural floor in
    expose_live.partial_flag catches -- discover returns 32 races, the
    publisher publishes but flags meta.counts.partial."""
    result = discover_card(
        "20260621",
        fetch_fn=lambda _d: _truncated_card(),
        attempts=3,
        sleep_s=0,
    )
    by_venue = {}
    for r in result:
        by_venue[r.venue_code] = by_venue.get(r.venue_code, 0) + 1
    assert by_venue == {"02": 12, "05": 8, "09": 12}, by_venue


def test_retry_default_attempts_is_3():
    """Default is 3 attempts so production recovers a transient miss without
    configuration. Tests that inject fetch_fn must pass attempts=1 for
    deterministic single-call behavior (see test_fetch_fn_seam... above)."""
    calls = []
    result = discover_card(
        "20260621",
        fetch_fn=lambda d: (calls.append(d) or _full_card()),
        sleep_s=0,
    )
    assert len(calls) == 3
    assert len(result) == 36


def test_retry_raises_when_every_attempt_errors():
    """ADR-0004: silent scrape failure loses race days -- surface the last
    exception when every attempt raised."""
    def err(_d):
        raise RuntimeError("network down")
    with pytest.raises(RuntimeError, match="network down"):
        discover_card("20260621", fetch_fn=err, attempts=3, sleep_s=0)

