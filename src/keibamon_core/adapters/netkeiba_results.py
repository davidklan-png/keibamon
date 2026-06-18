"""netkeiba race-result adapter -> ``jravan_race_results``.

Same three-layer shape as :mod:`netkeiba_entries`:

  - :func:`parse_results_payload` -- BRITTLE wire-payload extractor. Returns
    one intermediate dict per finisher.
  - :func:`_result_record` -- PURE silver-shape mapper; byte-identical to
    :func:`jravan_silver._result_record`. ``finish_position=None`` when the
    source reports no official placing (DNF / excluded). ``available_at`` is
    the official-result event time, never the scrape download time.
  - :func:`build_results` -- orchestrate fetch -> bronze archive -> silver
    upsert. Same ``fetch_fn`` injection seam as the entries adapter.

Calibration note: the parser is fixture-tested against
``tests/fixtures/netkeiba/results_*.json``. Real netkeiba likely serves HTML,
and the parser must be recalibrated before the capture PC is switched off
(ADR-0004). The record builder is load-bearing and pure.
"""
from __future__ import annotations

import hashlib
import json
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

# JSON keys that may carry the official-result published time (event time, JST).
_EVENT_TIME_FIELDS = ("official_datetime", "update_datetime", "published_time")

# netkeiba reports finish time as a "m:ss.f" string (e.g. "1:32.4"). The source
# sometimes drops the minutes prefix on sprint distances. We parse leniently and
# return None on any malformed value rather than guess.


def parse_results_payload(
    payload_text: str, nk_race_id: str
) -> list[dict[str, Any]]:
    """Extract one intermediate dict per finisher.

    Fixture format mirrors netkeiba's JSON style -- a ``data`` block with a
    ``results`` (or ``seiseki``) list:

    .. code-block:: json

        {
          "status": "ok",
          "data": {
            "official_datetime": "2026-06-20 15:30:00",
            "results": [
              {"umaban": "14", "ketto_num": "2016101234", "chakujun": "1",
               "time": "1:32.4", "akhirashi": "33.4", "tansho": "290",
               "ninki": "1", "makuri": "1/2"}
            ]
          }
        }

    Returns ``[]`` for payloads with no result list (race not yet run). A
    ``chakujun`` of 0 / "" / "00" maps to ``finish_position=None`` (matches
    ``_result_record``'s handling of "no official placing").

    Failure modes are loud per ADR-0004's "loud monitoring on scrape failure"
    mandate: malformed JSON raises ``ValueError`` (the bronze archive already
    captured the raw bytes, so the data is not lost); a missing event-time
    field raises ``ValueError`` rather than silently falling back to the scrape
    time (the ``available_at_bulk_download`` PIT trap).
    """
    payload = json.loads(payload_text)  # raises ValueError on malformed JSON
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return []
    results = data.get("results") or data.get("seiseki") or []
    if not isinstance(results, list):
        return []

    published = _extract_event_time(data)
    if published is None:
        raise ValueError(
            f"results payload for {nk_race_id} has no event-time field "
            f"({_EVENT_TIME_FIELDS}); refusing to fall back to scrape time "
            "(available_at_bulk_download PIT trap)"
        )
    out: list[dict[str, Any]] = []
    for raw in results:
        if not isinstance(raw, dict):
            continue
        umaban = _to_int(raw.get("umaban"))
        if umaban is None:
            continue  # without umaban we can't join payouts / settle
        finish = _to_int(raw.get("chakujun")) or _to_int(raw.get("chakugai"))
        # netkeiba's result page shows the WIN PAYOUT (yen per 100-yen bet) for
        # the winner, not decimal odds. JV-Data's `win_odds` is decimal odds,
        # so convert payout_yen / 100 to keep the column semantically consistent
        # across sources. The exact payout yen lives in jravan_payouts.
        tansho_yen = _to_int(raw.get("tansho"))
        rec = {
            "horse_number": umaban,
            "horse_id": _clean_str(raw.get("ketto_num")) or "0000000000",
            "finish_position": finish if finish else None,  # 0 / None -> None
            "finish_time_seconds": _parse_finish_time(raw.get("time")),
            "margin": _clean_str(raw.get("makuri")),
            "win_odds": (tansho_yen / 100.0) if tansho_yen else None,
            "popularity": _to_int(raw.get("ninki")),
            "last_3f_seconds": _to_float(raw.get("akhirashi")),
            "published_time": published,
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
    For scrape rows ``available_at`` and ``published_time`` are the same instant
    by construction; both kept for schema parity with JV-Link.
    """
    published = raw.get("published_time")
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
        # Provenance.
        "source_name": SOURCE_NAME,
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": meta.get("ingested_at"),
        "published_time": published,
        "available_at": published,  # event time, NOT scrape download time
    }


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


def _extract_event_time(data: dict[str, Any]) -> datetime | None:
    for key in _EVENT_TIME_FIELDS:
        parsed = netkeiba_http.parse_official_datetime(data.get(key))
        if parsed is not None:
            return parsed
    return None


def _parse_finish_time(value: Any) -> float | None:
    """netkeiba "m:ss.f" (e.g. '1:32.4') -> seconds. None on malformed input."""
    if value is None:
        return None
    s = str(value).strip()
    if not s or s in ("0000", "9999"):
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
