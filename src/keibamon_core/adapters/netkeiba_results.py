"""netkeiba race-result adapter -> ``jravan_race_results``.

Same three-layer shape as :mod:`netkeiba_entries`:

  - :func:`parse_results_payload` -- BRITTLE wire-payload extractor over
    ``result.html``'s ``<table class="RaceTable01 ... ResultRefund">`` rows.
    Fixture-tested against a REAL captured result page
    (``tests/fixtures/netkeiba/result_202609030411.html`` -- the live
    2026-06-14 宝塚記念 G1 capture with 18 finishers).
  - :func:`_result_record` -- PURE silver-shape mapper; byte-identical to
    :func:`jravan_silver._result_record`. ``finish_position=None`` when the
    source reports no official placing (DNF / excluded).
  - :func:`build_results` -- orchestrate fetch -> bronze archive -> silver
    upsert. Same ``fetch_fn`` injection seam as the entries adapter.

WIRE FORMAT. ``race.netkeiba.com/race/result.html?race_id=<numeric_id>`` is
server-rendered HTML. The result+refund table is one ``<table>`` with header
row + one row per finisher. Verified columns (in order, from the 2026-06-14
Takarazuka Kinen capture):

    0. 着順 (finish_position) -- '1', '2', ... ; '0'/'00'/'' for DNF/scratched
    1. 枠 (bracket / wakuban)
    2. 馬番 (horse_number / umaban)
    3. 馬名 (horse name) -- carries the ``db.netkeiba.com/horse/KETTO_NUM`` link
    4. 性齢 (sex/age)
    5. 斤量 (carried weight)
    6. 騎手 (jockey) -- carries ``/jockey/result/recent/CODE/`` link
    7. タイム (finish time, m:ss.f)
    8. 着差 (margin)
    9. 人気 (popularity)
    10. 単勝オッズ (win odds, decimal)
    11. 後3F (last-3F time)
    12-14. corner positions, trainer, horse weight (not parsed here)

The parser walks each row's ``<td>`` cells positionally and extracts the
fields above. ``win_odds`` is converted from decimal (e.g. 3.9) per the spec
(JV-Data's win_odds is decimal odds). The exact win payout lives in
``jravan_payouts`` via the payouts adapter.

PIT COMPROMISE on available_at. ``result.html`` carries no reliable publish
timestamp (no 確定時刻 field in the static HTML; netkeiba stamps it via JS at
runtime). The parser returns ``published_time=None``; :func:`_result_record`
falls back to ``captured_at`` (the scrape time). This is the honest upper
bound on when this version of the results became visible -- NOT the
``available_at_bulk_download`` trap, since we fetch the live page rather than
a bulk file.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any, Callable

from keibamon_core.adapters import netkeiba_http
from keibamon_core.ingestion.scrape_upsert import scrape_upsert
from keibamon_core.paths import LakePaths

SOURCE_NAME = "netkeiba"
BRONZE_SOURCE = "netkeiba_results"
TABLE = "jravan_race_results"
# Include source_name so scrape result rows coexist with JV-Link rows for the
# same (race, horse) -- see netkeiba_entries.NATURAL_KEY for the rationale.
NATURAL_KEY: tuple[str, ...] = ("race_id", "horse_number", "source_name")


def parse_results_payload(
    payload_text: str, nk_race_id: str
) -> list[dict[str, Any]]:
    """Extract one intermediate dict per finisher from ``result.html``.

    Splits the page on the ``ResultRefund`` table rows (one ``<tr>`` per
    finisher, after the header row). Returns ``[]`` for a page with no
    result table (race not yet run, or a malformed capture).

    Failure modes:
      - Empty table (no finishers parsed): returns ``[]``. Caller decides
        whether to warn; per ADR-0004 a SHUTUBA page with no results is
        expected pre-race, not a failure.
      - Missing cell: the row's field stays ``None`` -- permissive.
      - ``finish_position == 0`` / ``""``: mapped to ``None`` (matches
        ``_result_record``'s handling of "no official placing").
    """
    table = _extract_result_table(payload_text)
    if not table:
        return []
    out: list[dict[str, Any]] = []
    for row_html in _iter_data_rows(table):
        cells = _split_cells(row_html)
        if len(cells) < 11:
            continue  # not a finisher row (e.g. a header or corner-summary row)

        umaban = _to_int(_cell_text(cells[2]))
        if umaban is None:
            continue  # without umaban we can't join payouts / settle
        finish_raw = _cell_text(cells[0])
        finish = _to_int(finish_raw)
        rec: dict[str, Any] = {
            "horse_number": umaban,
            # 枠 (bracket / wakuban) -- cell[1], previously unused. Feeds
            # bracket_quinella (枠連) settlement: the resolver needs to map a
            # finisher's horse_number to its bracket, which isn't derivable
            # from horse_number alone once a field is large enough that
            # multiple horses share a bracket. See live/result.py build_result.
            "waku": _to_int(_cell_text(cells[1])),
            "horse_id": _extract_horse_id_from_cell(cells[3]) or "0000000000",
            "finish_position": finish if finish else None,
            # Raw 着順 cell text (ADR-0007 R1): lets downstream distinguish
            # 取消/除外 (scratched; refunded) from 中止 (DNF; no refund) from
            # 失格 (DQ; placings stand). ``finish_position`` collapses all to
            # None which would erase the refund path. Empty string for actual
            # numeric placings so downstream can skip the cost.
            "finish_position_raw": finish_raw if not finish else "",
            "finish_time_seconds": _parse_finish_time(_cell_text(cells[7])),
            "margin": _clean_str(_cell_text(cells[8])),
            "win_odds": _to_float(_cell_text(cells[10])),
            "popularity": _to_int(_cell_text(cells[9])),
            "last_3f_seconds": _to_float(_cell_text(cells[11])),
            "published_time": None,  # PIT compromise -- see module docstring
            "source_race_id": nk_race_id,
        }
        out.append(rec)
    return out


def _result_record(
    race_id: str, raw: dict[str, Any], meta: dict[str, Any]
) -> dict[str, Any]:
    """Pure layer: one finisher dict -> the EXACT jravan_race_results silver shape.

    ``horse_number`` is always carried (the placeholder-id guard: when several
    runners share ``horse_id='0000000000'``, the ``(race_id, horse_number)``
    join is the only exact key -- DATA_TRAPS['SE.ketto_num=0000000000']).
    ``available_at`` is the published event time when present; falls back to
    ``captured_at`` floored to UTC midnight when the parser returned ``None``
    (PIT compromise for result.html -- the page carries no publish timestamp).
    The midnight floor lets same-day re-scrapes dedupe.
    """
    published = _event_time_with_scrape_fallback(
        raw.get("published_time"), meta.get("captured_at")
    )
    return {
        "race_id": race_id,
        "horse_id": raw.get("horse_id"),
        "horse_number": raw.get("horse_number"),
        "finish_position": raw.get("finish_position"),
        "finish_time_seconds": raw.get("finish_time_seconds"),
        "margin": raw.get("margin"),
        "win_odds": raw.get("win_odds"),
        "popularity": raw.get("popularity"),
        "last_3f_seconds": raw.get("last_3f_seconds"),
        # Provenance -- ingested_at + published_time stringified to match the
        # existing jravan_* silver schema (string columns). See
        # netkeiba_http.format_provenance_iso for the BUG-4 rationale.
        "source_name": SOURCE_NAME,
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": netkeiba_http.format_provenance_iso(meta.get("ingested_at")),
        "published_time": netkeiba_http.format_provenance_iso(published),
        "available_at": published,
    }


def _event_time_with_scrape_fallback(
    published: datetime | None, captured_at: datetime | None
) -> datetime | None:
    """Pick the event time for ``available_at`` / ``published_time`` columns.

    Mirrors :func:`netkeiba_races._event_time_with_scrape_fallback`. Kept
    local so this module stays standalone.
    """
    if published is not None:
        return published
    if captured_at is None:
        return None
    if captured_at.tzinfo is None:
        from datetime import timezone as _tz
        captured_at = captured_at.replace(tzinfo=_tz.utc)
    return captured_at.replace(hour=0, minute=0, second=0, microsecond=0)


def build_results(
    lake: LakePaths,
    nk_race_id: str,
    race_id: str,
    *,
    fetch_fn: Callable[[str], str] | None = None,
    captured_at: datetime | None = None,
    payload_text: str | None = None,
) -> int:
    """Fetch one race's results -> bronze archive -> silver upsert.

    See :func:`netkeiba_entries.build_entries` for the seam contract. Returns
    the count of NEW silver rows.
    """
    captured_at = captured_at or netkeiba_http.utc_now()
    if payload_text is None:
        fetch_fn = fetch_fn or _default_fetch
        payload_text = fetch_fn(nk_race_id)

    raw_path = netkeiba_http.archive_raw(
        lake, BRONZE_SOURCE, nk_race_id, "results", payload_text, captured_at
    )
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = netkeiba_http.utc_now()

    parsed = parse_results_payload(payload_text, nk_race_id)
    records = [
        _result_record(
            race_id,
            raw,
            {
                "source_record_id": f"{nk_race_id}:results",
                "raw_uri": str(raw_path),
                "content_hash": content_hash,
                "ingested_at": ingested_at,
                "captured_at": captured_at,  # for the available_at fallback
            },
        )
        for raw in parsed
    ]
    _stamp_partition_keys(records, race_id)
    return scrape_upsert(lake, TABLE, records, natural_key=NATURAL_KEY)


# --- internals ----------------------------------------------------------------


def _default_fetch(nk_race_id: str) -> str:
    url = f"https://race.netkeiba.com/race/result.html?race_id={nk_race_id}"
    body, _ = netkeiba_http.fetch_payload(url)
    return body


def _stamp_partition_keys(records: list[dict[str, Any]], race_id: str) -> None:
    parts = race_id.split("-")
    year = int(parts[1][:4]) if len(parts) > 1 and parts[1][:4].isdigit() else 0
    venue = parts[2] if len(parts) > 2 else "unknown"
    for r in records:
        r["year"] = year
        r["venue"] = venue


# --- HTML extractors (the brittle layer) --------------------------------------


def _extract_result_table(html: str) -> str:
    """Pull the inner HTML of the ResultRefund table (the one table on the
    page that holds finishers + payouts). The class is ``RaceTable01
    RaceCommon_Table ResultRefund Table_Show_All``."""
    m = re.search(
        r'<table[^>]*class="[^"]*ResultRefund[^"]*"[^>]*>(.*?)</table>',
        html, re.S,
    )
    return m.group(1) if m else ""


def _iter_data_rows(table: str):
    """Yield each ``<tr>`` body in the table. The first row is the header
    (cells are ``<th>``); the rest are finishers (cells are ``<td>``)."""
    for chunk in re.split(r'<tr[^>]*>', table)[1:]:
        end = chunk.find("</tr>")
        if end >= 0:
            chunk = chunk[:end]
        yield chunk


def _split_cells(row: str) -> list[str]:
    """Return the inner-HTML of each ``<td>``/``<th>`` cell in the row, in
    document order. We include both td and th so header rows and data rows
    parse through the same positional logic."""
    return [
        m.group(1)
        for m in re.finditer(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.S)
    ]


def _cell_text(cell_html: str) -> str:
    """Strip nested tags and collapse whitespace -- the cell's visible text."""
    text = re.sub(r'<[^>]+>', ' ', cell_html)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def _extract_horse_id_from_cell(cell: str) -> str | None:
    """Cell 3 (馬名) carries the ``db.netkeiba.com/horse/KETTO_NUM`` link."""
    m = re.search(r'db\.netkeiba\.com/horse/([0-9]{10})', cell)
    return m.group(1) if m else None


def _parse_finish_time(value: str) -> float | None:
    """netkeiba 'm:ss.f' (e.g. '1:32.4') -> seconds. None on malformed input.

    Distinct from :func:`netkeiba_payouts._to_float`: finish times have a
    minutes prefix separated by ``:``. We also handle bare seconds ('32.4')
    for sprint distances where the source sometimes drops the minute."""
    if not value:
        return None
    s = value.strip()
    if s in ("0000", "9999", "--", "----", "*"):
        return None
    try:
        if ":" in s:
            mm, rest = s.split(":", 1)
            return int(mm) * 60.0 + float(rest)
        return float(s)
    except ValueError:
        return None


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


def _to_float(value: Any) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None
