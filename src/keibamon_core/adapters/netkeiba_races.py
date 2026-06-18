"""netkeiba race-header adapter -> ``netkeiba_races`` silver table.

Three layers, deliberately separated so the wire-payload extractor can be
recalibrated against real netkeiba without touching the silver shape:

  - :func:`parse_grade` / :func:`parse_race_payload` -- BRITTLE: extract the
    race-header fields (grade, post time, distance, surface) from a netkeiba
    race-card payload.
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

Status: the record-builder and orchestration are load-bearing and tested.
The parser is fixture-tested against ``tests/fixtures/netkeiba/race_header_*.json``
and is explicitly marked for real-world recalibration against live netkeiba
before the capture PC is switched off (ADR-0004).
"""
from __future__ import annotations

import hashlib
import json
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

# JSON keys that may carry the race header's published time (event time, JST).
# Mirrors entries/results/payouts; the same polite-fetch event-time rule applies
# (``available_at`` = event time, never the scrape download time).
_EVENT_TIME_FIELDS = ("official_datetime", "update_datetime", "published_time")

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
    """Extract a race-header dict from a netkeiba race-card payload.

    Fixture format mirrors netkeiba's JSON style -- a ``data`` block with
    race-level fields:

    .. code-block:: json

        {
          "status": "ok",
          "data": {
            "official_datetime": "2026-06-20 09:00:00",
            "race_id": "20260609030111",
            "race_num": "11",
            "date": "2026-06-20",
            "venue": "hanshin",
            "race_name": "Takarazuka Kinen",
            "grade": "GⅠ",
            "post_time": "15:40",
            "distance_m": 2200,
            "track_code": "10"
          }
        }

    Returns ``None`` for an empty/missing payload. Raises ``ValueError`` on
    malformed JSON or when no event-time field is present -- the latter would
    otherwise silently fall back to scrape time (the
    ``available_at_bulk_download`` PIT trap). The bronze archive already
    captured the raw bytes, so a raise never loses data.
    """
    payload = json.loads(payload_text)  # raises ValueError on malformed JSON
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None

    published = _extract_event_time(data)
    if published is None:
        raise ValueError(
            f"race payload for {nk_race_id} has no event-time field "
            f"({_EVENT_TIME_FIELDS}); refusing to fall back to scrape time "
            "(available_at_bulk_download PIT trap)"
        )

    return {
        "published_time": published,
        # netkeiba's NUMERIC race_id (e.g. '20260609031111') encodes kai/nichi
        # and is what the live-odds endpoint wants. This is DISTINCT from the
        # synthetic id (r-2026-0620-hanshin-11) we use for crosswalk -- the
        # numeric form is not derivable from (date, venue, race_no) and must
        # come from the payload itself. Persisted so the self-resolving track
        # (`track --grades`) can look it up from the lake without a hand-entered
        # value.
        "netkeiba_race_id": _clean_str(data.get("race_id")),
        "race_num": _to_int(data.get("race_num")),
        "race_name": _clean_str(data.get("race_name")),
        "grade_code": parse_grade(data.get("grade")),
        "post_time_jst": _clean_str(data.get("post_time")),
        "distance_m": _to_int(data.get("distance_m")),
        "track_code": _clean_str(data.get("track_code")),
        "venue": _clean_str(data.get("venue")),
        "date_yyyymmdd": _clean_str(data.get("date")),
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

    ``lookup_id`` is the synthetic id used to fetch the payload
    (``r-2026-0620-hanshin-11`` or the numeric form). The persisted
    ``netkeiba_race_id`` comes from the PAYLOAD itself (parsed["netkeiba_race_id"]),
    which is the numeric form (e.g. '20260609031111') the live-odds endpoint
    wants -- not derivable from the lookup key.
    """
    post_time = _post_time_utc(parsed, race_id)
    # Prefer the payload's numeric race_id; fall back to the lookup_id only when
    # the payload omitted it (some endpoints do). The lookup_id may be the
    # synthetic form, which is correct for crosswalk but NOT for the live-odds
    # fetch -- downstream code must handle the case.
    nk_id_persisted = parsed.get("netkeiba_race_id") or lookup_id
    return {
        "race_id": race_id,
        "race_date": _race_date(parsed, race_id),
        "racecourse": _venue_label(parsed.get("venue")),
        "country": "JP",
        "surface": _surface_from_track_code(parsed.get("track_code")),
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
        "published_time": parsed.get("published_time"),
        "available_at": parsed.get("published_time"),  # event time, NOT scrape time
        # The scrape-only column: netkeiba's numeric race_id encodes kai/nichi
        # and is not derivable from the canonical id. Persisted so the
        # self-resolving track (`track --grades`) can look it up from the lake
        # without a hand-entered value.
        "netkeiba_race_id": nk_id_persisted,
    }


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

    ``lookup_id`` is the synthetic id (``r-2026-0620-hanshin-11``) used to
    fetch the payload; the canonical ``race_id`` (``jra-20260620-09-11``) is
    the lake key. The persisted ``netkeiba_race_id`` is extracted from the
    payload itself (the numeric form, not derivable from the lookup key).

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
        },
    )
    _stamp_partition_keys([record], race_id)
    return scrape_upsert(lake, TABLE, [record], natural_key=NATURAL_KEY)


# --- internals ----------------------------------------------------------------


def _default_fetch(nk_race_id: str) -> str:
    """Polite fetch via :mod:`netkeiba_http`. Overridable by tests via
    ``fetch_fn``; the real endpoint is calibrated separately."""
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


def _extract_event_time(data: dict[str, Any]) -> datetime | None:
    """First non-null JST timestamp among :data:`_EVENT_TIME_FIELDS`."""
    for key in _EVENT_TIME_FIELDS:
        parsed = netkeiba_http.parse_official_datetime(data.get(key))
        if parsed is not None:
            return parsed
    return None


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
    """Pull (year, month, day) from the payload's date field, falling back to
    the canonical race_id (jra-YYYYMMDD-...). Month/day default to 1/1 when no
    date is available so year-only partitions still write."""
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


# Lightweight venue-code map -- mirrors jravan_silver.JYO_CODES but keyed by
# the netkeiba venue slug (the form used in the synthetic r- ids). Kept local
# so this module stays standalone; crosswalk_race_id in curve_log has the
# authoritative slug->jyo map.
_VENUE_LABEL: dict[str, str] = {
    "sapporo": "Sapporo", "hakodate": "Hakodate", "fukushima": "Fukushima",
    "niigata": "Niigata", "tokyo": "Tokyo", "nakayama": "Nakayama",
    "chukyo": "Chukyo", "kyoto": "Kyoto", "hanshin": "Hanshin", "kokura": "Kokura",
}


def _venue_label(slug: str | None) -> str | None:
    if not slug:
        return None
    return _VENUE_LABEL.get(slug.lower(), slug.capitalize())


# netkeiba track codes -> surface label. Subset; mirrors
# adapters.jravan.track_code_to_surface for the codes that appear on race cards.
_TRACK_CODE_TO_SURFACE: dict[str, str] = {
    "10": "turf", "11": "turf",  # 芝 (turf) -- inner/outer variants
    "20": "dirt", "21": "dirt",  # ダート (dirt)
    "29": "turf",  # 障害 (jump -- starts on turf; surface label coarse)
}


def _surface_from_track_code(code: str | None) -> str | None:
    return _TRACK_CODE_TO_SURFACE.get((code or "").strip())


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _to_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None
