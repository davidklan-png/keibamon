"""netkeiba race-header adapter -> ``netkeiba_races`` silver table.

Three layers, deliberately separated so the wire-payload extractor can be
recalibrated against real netkeiba without touching the silver shape:

  - :func:`parse_grade` / :func:`parse_race_payload` -- BRITTLE: extract the
    race-header fields (grade, post time, distance, surface) from a netkeiba
    race-card page (``shutuba.html``). HTML-regex based and fixture-tested
    against a REAL captured shutuba page (``tests/fixtures/netkeiba/
    shutuba_202605030611.html`` -- the live 2026-06-21 Tokyo R11 capture).
  - :func:`_race_record` -- PURE: map the parsed dict to the silver row shape
    (mirrors :func:`jravan_silver._race_record`'s columns PLUS ``netkeiba_race_id``,
    so the self-resolving track can look up the nk id from the lake).
  - :func:`build_race` -- orchestrate fetch -> bronze archive -> silver upsert.

WHY A SEPARATE TABLE. ``jravan_silver._race_record``'s output schema is load-
bearing (byte-identical across JV-Link rows). The scrape row needs ONE extra
column (``netkeiba_race_id``) that JV-Link cannot supply. Rather than widen
JV-Link's schema, the scrape rows live in their own ``netkeiba_races`` silver
table and the mart layer coalesces. Symmetric with how the entries/results/
payouts adapters reuse JV-Link's table byte-identically -- races is the one
case where the source genuinely diverges.

WIRE FORMAT. netkeiba's ``shutuba.html`` is server-rendered HTML (NOT JSON):
``race.netkeiba.com/race/shutuba.html?race_id=<numeric_id>``. The header
meta lives in two sibling divs:

  - ``<p class="RaceData01">HH:MM発走 /<span> 芝1800m</span> ...`` -- post time
    + surface/distance. Surface is the first character (``芝`` = turf,
    ``ダ`` = dirt, ``障`` = jump).
  - ``<div class="RaceData02"><span>N回</span><span>VENUE</span><span>N日目</span>
    ...<span>N頭</span>`` -- venue name, field size.
  - ``<h1 class="RaceName">RACE_NAME<span class="Icon_GradeType Icon_GradeTypeN">``
    -- race name + grade icon (1/2/3 = G1/G2/G3).

ENCODING. UTF-8 (verified live 2026-06-19; the server's Content-Type advertises
``charset=UTF-8`` and only UTF-8 decodes the bytes cleanly).

PIT COMPROMISE on available_at. shutuba.html carries NO reliable publish
timestamp -- the ``<span id="official_time">`` slot is JS-filled at runtime
and the only static timestamps on the page are years-old JS-comment metadata.
Per ADR-0004's ``available_at = published event time`` rule, we SHOULD use the
shutuba's official publish time (typically Thursday 17:00 JST), but the page
doesn't expose it. The adapter falls back to ``captured_at`` (the scrape time)
when ``parse_race_payload`` returns ``published_time=None``. This is NOT the
``available_at_bulk_download`` trap: we fetch the CURRENT live state of the
page (not a historical bulk file), so ``captured_at`` is an honest upper bound
on when this version of the entries became visible to us. Documented at each
call site; see :func:`_race_record`.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from keibamon_core.adapters import netkeiba_http
from keibamon_core.ingestion.scrape_upsert import scrape_upsert
from keibamon_core.paths import LakePaths

SOURCE_NAME = "netkeiba"
BRONZE_SOURCE = "netkeiba_races"
TABLE = "netkeiba_races"
# One row per (race_id, source_name) -- netkeiba rows coexist with JV-Link rows
# in the SAME canonical race_id space; the mart layer prefers JV-Link and
# coalesces netkeiba-only fields (netkeiba_race_id). Include source_name in the
# natural key so an idempotent re-scrape overwrites in place rather than
# appending.
NATURAL_KEY: tuple[str, ...] = ("race_id", "source_name")

_JST = timezone(timedelta(hours=9))

# netkeiba grade display strings -> JV-Data 2003.グレードコード letters. The
# REVERSE of :data:`adapters.jravan.GRADE_CODE_MAP` so the scrape row's
# ``grade_code`` is in the same vocabulary JV-Link uses -- the mart layer
# normalizes both via :func:`adapters.jravan.grade_label`.
#
# netkeiba uses unicode roman numerals (Ⅰ=U+2160, Ⅱ=U+2161, Ⅲ=U+2162) for flat
# grades and "J・GⅠ" (with U+30FB middle dot) for jump grades. A few endpoints
# also emit plain ASCII "G1"/"G2"/"G3". All three forms map to the same letter.
# Non-graded / listed / special race headers carry "オープン"/"500万"/"1600万"/
# "リステッド"/etc. -- none of those are graded, so they map to None.
_GRADE_DISPLAY_TO_CODE: dict[str, str] = {
    # flat grades -- unicode roman numerals
    "GⅠ": "A", "GⅡ": "B", "GⅢ": "C",
    # flat grades -- ASCII fallback (some endpoints)
    "G1": "A", "G2": "B", "G3": "C",
    # jump grades (J・GⅠ etc., both unicode-dot and ASCII-dash)
    "J・GⅠ": "F", "J・GⅡ": "G", "J・GⅢ": "H",
    "J·GⅠ": "F", "J·GⅡ": "G", "J·GⅢ": "H",
    "J-G1": "F", "J-G2": "G", "J-G3": "H",
}

# Icon_GradeType class suffix -> JV-Data grade code letter. The shutuba page
# stamps the grade as a CSS class on the H1: ``Icon_GradeType1`` = G1, etc.
# Word-bounded so Icon_GradeType13 (turf surface) and Icon_GradeType16 (JPN
# graded) don't false-match. Same word-boundary discipline as discovery.py.
_GRADE_ICON_TO_CODE: dict[str, str] = {"1": "A", "2": "B", "3": "C"}

# RaceData01 surface prefix kanji -> adapters.jravan surface vocabulary.
_SURFACE_KANJI_TO_LABEL: dict[str, str] = {
    "芝": "turf",
    "ダ": "dirt",
    "障": "turf",  # 障害 (jump) starts on turf; coarse label matches jravan.
}


def parse_grade(text: str | None) -> str | None:
    """Parse netkeiba's grade display string -> JV-Data 2003.グレードコード letter.

    Returns one of ``A/B/C/F/G/H`` for graded flat/jump races, or ``None`` for
    non-graded / listed / special / unknown. The output is in the same vocabulary
    JV-Link rows use; :func:`adapters.jravan.grade_label` normalizes to G1/G2/G3.

    NOTE on JpnI/II/III: per the JV-Data spec 特記事項, the international-G vs
    domestic-Jpn distinction is NOT encoded in grade_code -- a JpnI race like
    かしわ記念 carries code A on the source and is indistinguishable from G1 at
    this layer. The disambiguating CSV was deprecated in 2011. This parser
    faithfully mirrors that conflation.
    """
    if not text:
        return None
    # Strip whitespace and surrounding parentheses -- netkeiba often wraps the
    # grade symbol in parens on the race-card header ("(GⅢ)").
    cleaned = text.strip().strip("()（）").replace(" ", "").replace("　", "")
    return _GRADE_DISPLAY_TO_CODE.get(cleaned)


def parse_race_payload(payload_text: str, nk_race_id: str) -> dict[str, Any] | None:
    """Extract a race-header dict from a netkeiba ``shutuba.html`` payload.

    The shutuba page is HTML -- server-rendered, no JSON AJAX. The relevant
    fields live in:

      - ``<p class="RaceData01">HH:MM発走 /<span> (芝|ダ)NNNNm</span>`` --
        post_time_jst + distance + surface.
      - ``<div class="RaceData02"><span>N回</span><span>東京</span>...
        <span>N頭</span>`` -- venue + field_size.
      - ``<h1 class="RaceName">RACE_NAME<span class="Icon_GradeType1"/>`` --
        race_name + grade icon.

    Returns ``None`` for a payload that doesn't carry a RaceData01 block (e.g.
    a cancelled-race placeholder or a numeric_id the server doesn't recognize --
    the Friday dry-run's empty-shell bug). All fields are best-effort: a missing
    distance or field_size surfaces as ``None`` rather than raising; the caller
    decides whether to ingest a partial row.

    Per the PIT COMPROMISE in this module's docstring, ``published_time`` is
    ALWAYS ``None`` for shutuba.html (the page carries no reliable publish
    timestamp). Callers MUST pass ``captured_at`` to :func:`build_race` so
    ``available_at`` falls back honestly.

    ``nk_race_id`` is the numeric id (e.g. ``202605030611``) the caller fetched
    the page with; it's stamped into the parsed dict because shutuba.html itself
    doesn't repeat the id in a structured field the parser can extract (the
    page's JS encodes it but the server-rendered HTML omits it).
    """
    if "RaceData01" not in payload_text:
        return None
    return {
        "published_time": None,  # shutuba.html carries no publish timestamp (PIT compromise)
        "netkeiba_race_id": nk_race_id,
        "race_num": _extract_race_num(payload_text),
        "race_name": _extract_race_name(payload_text),
        "grade_code": _extract_grade_code(payload_text),
        "post_time_jst": _extract_post_time(payload_text),
        "distance_m": _extract_distance_m(payload_text),
        "surface": _extract_surface(payload_text),
        "track_code": None,  # not surfaced as a discrete field on shutuba.html
        "venue": _extract_venue_slug(payload_text),
        "field_size": _extract_field_size(payload_text),
        "date_yyyymmdd": _extract_date_yyyymmdd(payload_text, nk_race_id),
    }


def _race_record(
    race_id: str,
    lookup_id: str,
    parsed: dict[str, Any],
    meta: dict[str, Any],
) -> dict[str, Any]:
    """Pure layer: parsed dict -> the netkeiba_races silver row shape.

    Column set mirrors :func:`jravan_silver._race_record`'s reader columns PLUS
    ``netkeiba_race_id`` (the scrape-only column that motivated the separate
    table). The mart reads both tables and coalesces.

    ``available_at``: per the PIT COMPROMISE in this module's docstring, the
    shutuba page carries no publish timestamp so the parser returns
    ``published_time=None``. We fall back to ``captured_at`` floored to UTC
    midnight -- the honest "this version became visible sometime on this
    date" upper bound. Flooring to midnight is the dedupe trick that lets a
    re-scrape on the SAME DAY hit the partition-aware upsert's
    (natural_key, available_at) dedupe (otherwise two scrapes seconds apart
    would each add a row). A re-scrape on a DIFFERENT day adds a row -- a
    genuine new observation since the page may have changed.
    """
    post_time = _post_time_utc(parsed, race_id)
    nk_id_persisted = parsed.get("netkeiba_race_id") or lookup_id
    published = _event_time_with_scrape_fallback(
        parsed.get("published_time"), meta.get("captured_at")
    )
    return {
        "race_id": race_id,
        "race_date": _race_date(parsed, race_id),
        "racecourse": _venue_label(parsed.get("venue")),
        "country": "JP",
        "surface": parsed.get("surface"),
        "distance_m": parsed.get("distance_m"),
        "scheduled_post_time": post_time,
        "race_name": parsed.get("race_name"),
        "grade_code": parsed.get("grade_code"),
        # Provenance -- mirrors jravan_silver._meta_columns.
        "source_name": SOURCE_NAME,
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": meta.get("ingested_at"),
        "published_time": published,
        "available_at": published,  # event time; floored-scrape fallback (PIT compromise)
        # The scrape-only column: netkeiba's numeric race_id encodes kai/nichi
        # and is not derivable from the canonical id. Persisted so the
        # self-resolving track (`track --grades`) can look it up from the lake
        # without a hand-entered value.
        "netkeiba_race_id": nk_id_persisted,
    }


def _event_time_with_scrape_fallback(
    published: datetime | None, captured_at: datetime | None
) -> datetime | None:
    """Pick the event time for ``available_at`` / ``published_time`` columns.

    If the parser found a real publish timestamp (rare for scrape pages), use
    it. Otherwise fall back to ``captured_at`` floored to UTC midnight -- the
    PIT-compromise "this version became visible sometime on this date" upper
    bound. The midnight floor is what makes same-day re-scrapes dedupe under
    the partition-aware upsert's (natural_key, available_at) natural key.
    """
    if published is not None:
        return published
    if captured_at is None:
        return None
    if captured_at.tzinfo is None:
        from datetime import timezone as _tz
        captured_at = captured_at.replace(tzinfo=_tz.utc)
    return captured_at.replace(hour=0, minute=0, second=0, microsecond=0)


def build_race(
    lake: LakePaths,
    lookup_id: str,
    race_id: str,
    *,
    fetch_fn: Callable[[str], str] | None = None,
    captured_at: datetime | None = None,
    payload_text: str | None = None,
) -> int:
    """Fetch one race header -> bronze archive -> silver upsert.

    ``lookup_id`` is the numeric netkeiba id (``202605030611``) used to fetch
    the page; the canonical ``race_id`` (``jra-20260621-05-11``) is the lake
    key. The persisted ``netkeiba_race_id`` is the numeric id stamped by the
    parser.

    Returns 0 or 1 (one race per payload). Re-ingesting an unchanged payload
    returns 0 thanks to the partition-aware upsert's dedupe on
    ``(race_id, source_name, available_at)``.
    """
    captured_at = captured_at or netkeiba_http.utc_now()
    if payload_text is None:
        fetch_fn = fetch_fn or _default_fetch
        payload_text = fetch_fn(lookup_id)

    raw_path = netkeiba_http.archive_raw(
        lake, BRONZE_SOURCE, lookup_id, "header", payload_text, captured_at
    )
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = netkeiba_http.utc_now()

    parsed = parse_race_payload(payload_text, lookup_id)
    if parsed is None:
        return 0
    record = _race_record(
        race_id,
        lookup_id,
        parsed,
        {
            "source_record_id": f"{lookup_id}:header",
            "raw_uri": str(raw_path),
            "content_hash": content_hash,
            "ingested_at": ingested_at,
            "captured_at": captured_at,  # for the available_at fallback
        },
    )
    _stamp_partition_keys([record], race_id)
    return scrape_upsert(lake, TABLE, [record], natural_key=NATURAL_KEY)


# --- internals ----------------------------------------------------------------


def _default_fetch(nk_race_id: str) -> str:
    """Polite fetch via :mod:`netkeiba_http`."""
    url = f"https://race.netkeiba.com/race/shutuba.html?race_id={nk_race_id}"
    body, _ = netkeiba_http.fetch_payload(url)
    return body


def _stamp_partition_keys(records: list[dict[str, Any]], race_id: str) -> None:
    """Derive ``year``+``venue`` from the canonical race_id (same logic as
    :func:`jravan_silver._write_silver`)."""
    parts = race_id.split("-")
    year = int(parts[1][:4]) if len(parts) > 1 and parts[1][:4].isdigit() else 0
    venue = parts[2] if len(parts) > 2 else "unknown"
    for r in records:
        r["year"] = year
        r["venue"] = venue


def _post_time_utc(parsed: dict[str, Any], race_id: str) -> datetime | None:
    """Convert the payload's JST ``HH:MM`` post time to a UTC datetime, anchored
    to the race date (parsed from the canonical race_id when the payload omits
    the date)."""
    hhmm = parsed.get("post_time_jst")
    if not hhmm or ":" not in hhmm:
        return None
    y, m, d = _race_date_parts(parsed, race_id)
    if y is None:
        return None
    try:
        hh, mm = hhmm.split(":", 1)
        jst = datetime(y, m, d, int(hh), int(mm), tzinfo=_JST)
    except (ValueError, TypeError):
        return None
    return jst.astimezone(timezone.utc)


def _race_date(parsed: dict[str, Any], race_id: str) -> datetime | None:
    """Race date as a UTC midnight datetime (matches jravan_silver._race_date)."""
    y, m, d = _race_date_parts(parsed, race_id)
    if y is None:
        return None
    return datetime(y, m, d, tzinfo=timezone.utc)


def _race_date_parts(parsed: dict[str, Any], race_id: str) -> tuple[int | None, int, int]:
    """Pull (year, month, day) from the parsed date field, falling back to
    the canonical race_id (jra-YYYYMMDD-...)."""
    date_str = parsed.get("date_yyyymmdd")
    if date_str:
        for fmt in ("%Y-%m-%d", "%Y%m%d"):
            try:
                dt = datetime.strptime(date_str, fmt)
                return dt.year, dt.month, dt.day
            except ValueError:
                continue
    parts = race_id.split("-")
    if len(parts) >= 2 and parts[1][:4].isdigit() and len(parts[1]) >= 8:
        yyyymmdd = parts[1]
        return int(yyyymmdd[:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8])
    if len(parts) >= 2 and parts[1][:4].isdigit():
        return int(parts[1][:4]), 1, 1
    return None, 1, 1


# Lightweight venue-name map -- mirrors jravan_silver.JYO_CODES but keyed by
# the netkeiba venue kanji (the form shutuba.html's RaceData02 uses). Kept
# local so this module stays standalone.
_VENUE_KANJI_TO_LABEL: dict[str, str] = {
    "札幌": "Sapporo", "函館": "Hakodate", "福島": "Fukushima",
    "新潟": "Niigata", "東京": "Tokyo", "中山": "Nakayama",
    "中京": "Chukyo", "京都": "Kyoto", "阪神": "Hanshin", "小倉": "Kokura",
}

# Reverse map for _venue_slug (label/slug -> kanji) -- used by tests.
_VENUE_LABEL_TO_KANJI: dict[str, str] = {v.lower(): k for k, v in _VENUE_KANJI_TO_LABEL.items()}


def _venue_label(slug: str | None) -> str | None:
    """RaceData02's venue is the kanji form (東京/阪神/...). Translate to the
    romanized label jravan_silver uses (Tokyo/Hanshin/...). If the input is
    already romanized (slug form, e.g. 'tokyo'), pass through with case-fix."""
    if not slug:
        return None
    if slug in _VENUE_KANJI_TO_LABEL:
        return _VENUE_KANJI_TO_LABEL[slug]
    # Already a slug/label -- mirror netkeiba_entries' behavior.
    return slug.capitalize()


def _surface_from_track_code(code: str | None) -> str | None:
    """Legacy -- shutuba.html doesn't carry a discrete track_code; we surface
    surface directly from the RaceData01 kanji instead. Kept for schema parity
    with downstream readers that may still call this."""
    return {"10": "turf", "11": "turf", "20": "dirt", "21": "dirt", "29": "turf"}.get(
        (code or "").strip()
    )


# --- HTML extractors (the brittle layer) --------------------------------------


def _extract_race_num(html: str) -> int | None:
    """RaceData01 sometimes carries 'N R' or the page title carries 'N R'.
    Best-effort: pull from the page title '(NNR)' if present."""
    m = re.search(r"title=\"([0-9]{1,2})R\"", html)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return None


def _extract_race_name(html: str) -> str | None:
    """``<h1 class="RaceName">RACE_NAME<span class="Icon_GradeType.../></h1>``
    -- the race name is the leading text of the h1, before the grade icon
    span. Whitespace stripped."""
    m = re.search(r'class="RaceName"[^>]*>(.*?)(?:<span|</h1>)', html, re.S)
    if not m:
        return None
    name = m.group(1).strip()
    return name or None


def _extract_grade_code(html: str) -> str | None:
    """``Icon_GradeType1`` / ``2`` / ``3`` CSS class on the RaceName h1 -> JV-Data
    grade code letter (A/B/C). Word-bounded so Icon_GradeType13/16 (surface/JPN
    icons) don't false-match. Same discipline as discovery._extract_grade."""
    m = re.search(r'Icon_GradeType([123])\b', html)
    return _GRADE_ICON_TO_CODE[m.group(1)] if m else None


def _extract_post_time(html: str) -> str | None:
    """RaceData01: ``HH:MM発走``. The page format is ``<p class="RaceData01">\n
    15:45発走 /<span> 芝1800m</span>`` -- the post time precedes the slash."""
    m = re.search(r'RaceData01"[^>]*>\s*([0-9]{1,2}:[0-9]{2})発走', html)
    return m.group(1) if m else None


def _extract_distance_m(html: str) -> int | None:
    """RaceData01 span: ``(芝|ダ|障)NNNNm``. Distance in meters."""
    m = re.search(r'RaceData01.*?<span>\s*(芝|ダ|障)([0-9]{1,4})m', html, re.S)
    if not m:
        return None
    try:
        return int(m.group(2))
    except ValueError:
        return None


def _extract_surface(html: str) -> str | None:
    """RaceData01: the first span's leading kanji (芝=turf, ダ=dirt, 障=jump->turf)."""
    m = re.search(r'RaceData01.*?<span>\s*(芝|ダ|障)', html, re.S)
    if not m:
        return None
    return _SURFACE_KANJI_TO_LABEL.get(m.group(1))


def _extract_field_size(html: str) -> int | None:
    """RaceData02: ``<span>N頭</span>`` near the end of the div."""
    m = re.search(r'RaceData02.*?<span>\s*([0-9]{1,2})頭\s*</span>', html, re.S)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _extract_venue_slug(html: str) -> str | None:
    """RaceData02: ``<span>N回</span><span>東京</span>`` -- the SECOND span is
    the venue kanji. We return the kanji form (downstream _venue_label
    translates to the romanized label)."""
    m = re.search(
        r'RaceData02">\s*<span>[^<]*</span>\s*<span>([^<]+)</span>',
        html, re.S,
    )
    if not m:
        return None
    return m.group(1).strip()


def _extract_date_yyyymmdd(html: str, nk_race_id: str) -> str | None:
    """Prefer the page's visible 'YYYY年MM月DD日' date (anywhere in the page);
    fall back to the numeric nk_race_id's leading 8 digits (positions 1-8).
    The numeric id encodes YYYYVVKKNNRR where YYYY is the calendar year."""
    m = re.search(r'([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日', html)
    if m:
        return f"{m.group(1)}{int(m.group(2)):02d}{int(m.group(3)):02d}"
    if len(nk_race_id) >= 8 and nk_race_id[:4].isdigit():
        return nk_race_id[:8]
    return None
