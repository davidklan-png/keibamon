"""netkeiba race-card (出馬表 / shutuba) adapter -> ``jravan_race_entries``.

Three layers, deliberately separated so the wire-payload extractor can be
recalibrated against real netkeiba without touching the silver shape:

  - :func:`parse_entries_payload` -- BRITTLE: extract intermediate runner dicts
    from a netkeiba race-card payload (JSON now; HTML later). Returns one dict
    per runner with raw fields.
  - :func:`_entry_record` / :func:`_entry_record_for_runner` -- PURE: map one
    intermediate dict to the EXACT ``jravan_race_entries`` silver shape
    (mirrors :func:`jravan_silver._entry_record`). Carries
    ``source_name='netkeiba'`` on every row. ``available_at`` = the entries'
    own published event time, never the scrape download time.
  - :func:`build_entries` -- orchestrate fetch -> bronze archive -> silver
    upsert. Takes a ``fetch_fn=`` injection seam so tests run offline.

Status: the record-builder and orchestration are load-bearing and tested.
The parser is fixture-tested against ``tests/fixtures/netkeiba/entries_*.json``
and is explicitly marked for real-world recalibration against live netkeiba
before the capture PC is switched off (ADR-0004).
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
BRONZE_SOURCE = "netkeiba_entries"
TABLE = "jravan_race_entries"
# Include source_name so a scrape row for the same (race, horse) as an existing
# JV-Link row COEXISTS rather than overwrites -- the cross-validation gate
# (tools/validate_scrape_vs_jravan.py) reads both sources side-by-side over the
# overlap window, and the placeholder-pair test relies on JV-Link + scrape rows
# for the same horse_number staying distinct.
NATURAL_KEY: tuple[str, ...] = ("race_id", "horse_number", "source_name")

# JSON keys that may carry the entries' published time (event time, JST).
# `official_datetime` is the same key the odds payload uses; `published_time`
# is a fallback name some shutuba endpoints expose.
_EVENT_TIME_FIELDS = ("official_datetime", "update_datetime", "published_time")


def parse_entries_payload(
    payload_text: str, nk_race_id: str
) -> list[dict[str, Any]]:
    """Extract one intermediate runner dict per declared horse.

    The fixture format mirrors netkeiba's JSON style -- a ``data`` block with
    a list of runner records under ``runners`` (or ``shutuba``):

    .. code-block:: json

        {
          "status": "ok",
          "data": {
            "official_datetime": "2026-06-20 09:00:00",
            "runners": [
              {"wakuban": "1", "umaban": "01", "bamei": "...",
               "ketto_num": "2016101234", "jockey_code": "05123",
               "trainer_code": "01045", "futan": "56.0", "bataiju": "480"}
            ]
          }
        }

    Each runner dict carries the raw fields the record builder needs. Returns
    ``[]`` for payloads with no runner list (pre-announcement / wrong page).

    The parser is intentionally permissive about missing keys: netkeiba's
    `ketto_num` (bloodline number) is sometimes blank for foreign IC-tagged
    horses -- those are the placeholder-trap rows
    (``DATA_TRAPS['SE.ketto_num=0000000000']``). The record builder preserves
    ``horse_number`` so the (race_id, horse_number) join stays exact.

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
    runners = data.get("runners") or data.get("shutuba") or []
    if not isinstance(runners, list):
        return []

    published = _extract_event_time(data)
    if published is None:
        raise ValueError(
            f"entries payload for {nk_race_id} has no event-time field "
            f"({_EVENT_TIME_FIELDS}); refusing to fall back to scrape time "
            "(available_at_bulk_download PIT trap)"
        )
    out: list[dict[str, Any]] = []
    for raw in runners:
        if not isinstance(raw, dict):
            continue
        rec = {
            "horse_number": _to_int(raw.get("umaban")),
            "gate": _to_int(raw.get("wakuban")),
            "horse_id": _clean_str(raw.get("ketto_num")) or "0000000000",
            "horse_name": _clean_str(raw.get("bamei")),
            "jockey_id": _clean_str(raw.get("jockey_code")),
            "trainer_id": _clean_str(raw.get("trainer_code")),
            "carried_weight_kg": _to_float(raw.get("futan")),
            "body_weight_kg": _to_int(raw.get("bataiju")),
            "published_time": published,
            "source_race_id": nk_race_id,
        }
        if rec["horse_number"] is None:
            # Without umaban we cannot join to results/payouts -- skip rather
            # than emit an orphan row.
            continue
        out.append(rec)
    return out


def _entry_record(
    race_id: str, raw: dict[str, Any], meta: dict[str, Any]
) -> dict[str, Any]:
    """Pure layer: one runner dict -> the EXACT jravan_race_entries silver shape.

    Column set is byte-identical to :func:`jravan_silver._entry_record` so
    stages 1/2/4 read scrape rows without code changes. ``available_at`` is
    the runner's published event time (never the scrape time). For scrape rows
    ``available_at`` and ``published_time`` are the same instant by construction
    -- both columns are kept for schema parity with JV-Link rows, where they
    can legitimately differ.
    """
    bw = raw.get("body_weight_kg")  # 999=unweighable, 000=scratched -> not real
    published = raw.get("published_time")
    return {
        "race_id": race_id,
        "horse_id": raw.get("horse_id"),
        "horse_name": raw.get("horse_name"),
        "horse_number": raw.get("horse_number"),
        "gate": raw.get("gate"),
        "jockey_id": raw.get("jockey_id"),
        "trainer_id": raw.get("trainer_id"),
        "carried_weight_kg": raw.get("carried_weight_kg"),
        "body_weight_kg": bw if bw and bw not in (0, 999) else None,
        # Provenance -- source_name distinguishes scrape rows from JV-Link.
        "source_name": SOURCE_NAME,
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": meta.get("ingested_at"),
        "published_time": published,
        "available_at": published,  # event time, NOT scrape download time
    }


def build_entries(
    lake: LakePaths,
    nk_race_id: str,
    race_id: str,
    *,
    fetch_fn: Callable[[str], str] | None = None,
    captured_at: datetime | None = None,
    payload_text: str | None = None,
) -> int:
    """Fetch one race's entries -> bronze archive -> silver upsert.

    Pipeline: fetch (or use ``payload_text`` if given, the test seam) ->
    archive raw to bronze once (sha256 change-detected) -> parse -> upsert.

    ``fetch_fn`` mirrors the injection seam pattern in
    ``weekend.pipeline.post`` and ``weekend.settle_card``: tests pass a stub
    that returns a fixture body and the network is never touched. When neither
    ``fetch_fn`` nor ``payload_text`` is given, the polite-fetch path from
    :mod:`adapters.netkeiba_http` is used.

    Returns the number of NEW silver rows (re-ingesting an unchanged payload
    returns 0).
    """
    captured_at = captured_at or netkeiba_http.utc_now()
    if payload_text is None:
        fetch_fn = fetch_fn or _default_fetch
        payload_text = fetch_fn(nk_race_id)

    raw_path = netkeiba_http.archive_raw(
        lake, BRONZE_SOURCE, nk_race_id, "entries", payload_text, captured_at
    )
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = netkeiba_http.utc_now()

    parsed = parse_entries_payload(payload_text, nk_race_id)
    records = [
        _entry_record(
            race_id,
            raw,
            {
                "source_record_id": f"{nk_race_id}:entries",
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
    """Polite fetch via :mod:`netkeiba_http`. Overridable by tests via
    ``fetch_fn``; the real endpoint is calibrated separately."""
    from keibamon_core.adapters.netkeiba_http import USER_AGENT  # noqa: F401

    url = (
        f"https://race.netkeiba.com/race/shutuba.html?race_id={nk_race_id}"
    )
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
