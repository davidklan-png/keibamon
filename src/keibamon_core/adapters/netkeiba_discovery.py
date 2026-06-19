"""Day-index discovery: netkeiba's numeric race_id is NOT derivable from
``(date, venue, raceno)`` — the id encodes ``kai``/``nichi`` (which meeting
at that venue, which day of that meeting) and those aren't recoverable from
the calendar date alone. ADR-0004's Friday dry run confirmed this: passing
the synthetic internal id (``r-2026-0621-tokyo-1``) as ``?race_id=`` gets a
generic empty shell back. The numeric id must be DISCOVERED from netkeiba's
day index.

This module fetches the day's race-list page ONCE per race day and reads
each race's numeric id off its ``shutuba.html?race_id=…`` link, along with
the meta the manifest needs (grade label, post time JST, distance, field
size, race name). No computation of ids — only extraction from the page.

The discovered ``DiscoveredRace`` records feed two downstream paths:

  - The orchestrator (``tools/scrape_ingest.py``) iterates them and passes
    ``numeric_id`` to each per-table adapter (``netkeiba_races`` /
    ``netkeiba_entries`` / ``netkeiba_results`` / ``netkeiba_payouts``).
  - ``netkeiba_races.build_race`` persists ``numeric_id`` into the
    ``netkeiba_race_id`` silver column, which ``refresh_marts`` surfaces
    for self-resolving ``track --grades`` (no hand-entered ids).

Venue-code sanity: per ADR-0004 (verified 2026-06-19 against live netkeiba),
the venue digits at positions 5-6 of the numeric id ARE the official JRA
track codes (05=Tokyo, 09=Hanshin, 08=Kyoto, …). The earlier "09=Kyoto"
decode note was wrong. No netkeiba-vs-JRA remap is needed; the canonical
``jra-YYYYMMDD-<jyo>-NN`` id and the numeric id share the same venue code.

This is the bootstrap that makes the Phase-2 self-resolve design actually
work. A race with no discovered numeric id is named and skipped — never
fabricated (a wrong id silently captures the wrong race, unrecoverable).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from keibamon_core.adapters import netkeiba_http

# JST tz constant for converting the page's "HH:MM" post time to a UTC instant.
# Local copy (not imported from polling/netkeiba) to keep this module
# standalone; the value is the same.
_JST = timezone(timedelta(hours=9))

# netkeiba's race-list item carries a grade icon as a CSS class. The numeric
# suffix maps to the spec-derived grade label (1=G1, 2=G2, 3=G3). The page
# also uses Icon_GradeType4-7 for JPN/listed/special grades and Icon_GradeType16
# for JPN-graded — those don't normalize to a G-label and stay None (matches
# ``adapters.jravan.grade_label``'s handling of non-graded codes).
_GRADE_ICON_TO_LABEL: dict[str, str] = {
    "1": "G1",
    "2": "G2",
    "3": "G3",
}

# netkeiba numeric race_id is 12 digits: YYYY VV KK NN RR (year, venue, kai,
# nichi, race_no). We don't decode kai/nichi here — they're opaque to the
# project — but we DO read the venue code (positions 5-6) and race_no
# (positions 11-12) off the id to build the canonical form.
_NUMERIC_ID_RE = re.compile(r"race_id=(\d{12})(?:&|\"|$)")


@dataclass(frozen=True)
class DiscoveredRace:
    """One race linked from netkeiba's day index.

    The ``numeric_id`` is what every per-table adapter passes to
    ``?race_id=`` on the wire. ``canonical_race_id`` is the lake key. Both
    are derived from the SAME href in the day's race list — they never come
    from computation, only extraction.
    """

    numeric_id: str  # "202605030611" — netkeiba's 12-digit form
    canonical_race_id: str  # "jra-20260621-05-11"
    date_yyyymmdd: str  # "20260621"
    venue_code: str  # "05" (JRA track code, NOT a slug)
    race_no: int  # 11
    grade_label: str | None  # "G1"/"G2"/"G3"/None — normalized for select/track
    post_time_jst: str | None  # "15:45"
    distance: str | None  # "芝1800m"
    field_size: int | None  # 16
    race_name: str | None  # "府中牝馬S"

    def post_time_utc(self) -> datetime | None:
        """Convert the page's ``HH:MM`` (JST) to a UTC datetime, the form the
        lake's ``scheduled_post_time`` column stores. Returns ``None`` if the
        page omitted the post time (rare; happens for non-carded races)."""
        if not self.post_time_jst:
            return None
        try:
            hh, mm = self.post_time_jst.split(":")
            d = datetime.strptime(self.date_yyyymmdd, "%Y%m%d")
            return datetime(
                d.year, d.month, d.day, int(hh), int(mm), tzinfo=_JST
            ).astimezone(timezone.utc)
        except (ValueError, AttributeError):
            return None


def discover_card(
    date_yyyymmdd: str, *, fetch_fn: Callable[[str], str] | None = None
) -> list[DiscoveredRace]:
    """Fetch the day's race-list page once; return one ``DiscoveredRace`` per
    linked race.

    Returns ``[]`` for a card with no published races (cancellation, future
    date). Raises on network / parse failure — per ADR-0004, silent scrape
    failure loses race days.

    ``fetch_fn`` is the test seam: tests inject a stub returning a fixture
    body and the network is never touched. Production leaves it ``None``
    and the polite-fetch path in :mod:`netkeiba_http` is used.
    """
    fetch_fn = fetch_fn or _default_fetch
    html = fetch_fn(date_yyyymmdd)
    return _parse_race_list(html, date_yyyymmdd)


# --- internals ----------------------------------------------------------------


def _default_fetch(date_yyyymmdd: str) -> str:
    """One polite GET of the day's race-list page. The race_list_sub form is
    lighter than the full top page but exposes the same race hrefs."""
    url = (
        "https://race.netkeiba.com/top/race_list_sub.html"
        f"?kaisai_date={date_yyyymmdd}"
    )
    body, _ = netkeiba_http.fetch_payload(url)
    return body


def _parse_race_list(html: str, date_yyyymmdd: str) -> list[DiscoveredRace]:
    """Split the page into per-race list items and extract one
    ``DiscoveredRace`` per item.

    The page structure (verified against 2026-06-21's live capture):
    each race lives in ``<li class="RaceList_DataItem…">…</li>`` and carries
    the href in the first ``<a>``, the title in ``<span class="ItemTitle">``,
    the post time in ``<span class="RaceList_Itemtime">15:45 </span>``, the
    distance in ``<span class="RaceList_ItemLong">芝1800m</span>``, the field
    size in ``<span class="RaceList_Itemnumber">16頭 </span>``, and the grade
    as a CSS class ``Icon_GradeType1``/``2``/``3`` (word-bounded so
    ``Icon_GradeType13``/``16`` don't match — those mean surface/JPN grades).
    """
    out: list[DiscoveredRace] = []
    seen: set[str] = set()
    # Each race is in <li class="RaceList_DataItem">…</li>. Split on the
    # opening tag; the first chunk is the page preamble.
    for item in re.split(r'<li class="RaceList_DataItem[^"]*">', html)[1:]:
        rid_m = _NUMERIC_ID_RE.search(item)
        if not rid_m:
            continue
        numeric_id = rid_m.group(1)
        if numeric_id in seen:
            # Each race appears twice on the page (shutuba link + movie link).
            continue
        seen.add(numeric_id)

        venue_code = numeric_id[4:6]
        try:
            race_no = int(numeric_id[10:12])
        except ValueError:
            continue  # malformed; skip loud rather than guess

        canonical = f"jra-{date_yyyymmdd}-{venue_code}-{race_no:02d}"
        out.append(
            DiscoveredRace(
                numeric_id=numeric_id,
                canonical_race_id=canonical,
                date_yyyymmdd=date_yyyymmdd,
                venue_code=venue_code,
                race_no=race_no,
                grade_label=_extract_grade(item),
                post_time_jst=_extract_post_time(item),
                distance=_extract_distance(item),
                field_size=_extract_field_size(item),
                race_name=_extract_race_name(item),
            )
        )

    # Sort by (venue_code, race_no) so callers iterate the card in running
    # order within each venue. Stable on equal keys preserves page order.
    out.sort(key=lambda d: (d.venue_code, d.race_no))
    return out


def _extract_grade(item_html: str) -> str | None:
    """Icon_GradeType1/2/3 → G1/G2/G3. Word-bounded so Icon_GradeType13/16
    (surface/JPN-grade icons) don't false-match."""
    m = re.search(r"Icon_GradeType([123])\b", item_html)
    return _GRADE_ICON_TO_LABEL[m.group(1)] if m else None


def _extract_post_time(item_html: str) -> str | None:
    """RaceList_Itemtime">HH:MM </span> → 'HH:MM'."""
    m = re.search(r'RaceList_Itemtime">([\d:]+)', item_html)
    return m.group(1).strip() if m else None


def _extract_distance(item_html: str) -> str | None:
    """RaceList_ItemLong (芝1800m / ダ1400m) → string verbatim."""
    m = re.search(r'RaceList_ItemLong[^>]*">([^<]+)<', item_html)
    return m.group(1).strip() if m else None


def _extract_field_size(item_html: str) -> int | None:
    """RaceList_Itemnumber (16頭) → 16."""
    m = re.search(r'RaceList_Itemnumber">[^<]*?(\d+)', item_html)
    return int(m.group(1)) if m else None


def _extract_race_name(item_html: str) -> str | None:
    """ItemTitle (府中牝馬S) → string verbatim."""
    m = re.search(r'class="ItemTitle">([^<]+)<', item_html)
    return m.group(1).strip() if m else None
