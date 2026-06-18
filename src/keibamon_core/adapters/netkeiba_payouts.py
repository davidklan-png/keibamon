"""netkeiba payout-table adapter -> ``jravan_payouts``.

This is the adapter Stage-4 settlement reads. Same three-layer shape as the
entries/results adapters, plus three correctness invariants the silver shape
already enforces for JV-Link rows:

  - **One row per winning combo per pool.** A list-valued pool in the source
    (dead-heat place / wide) emits one row per (combo, payout) on the page.
    The parser does NOT dedupe -- :func:`settlement._load_official_payouts`
    MAX-collapses duplicates on read.
  - **Combos canonicalized via ``settlement._normalize_selection``.** Win/place
    -> ``"01"``; quinella/wide -> ``"0108"``; trifecta -> ``"010809"``;
    bracket_quinella -> ``"23"``. This is what makes new scrape rows slot into
    ``settle_many``'s lookup unchanged.
  - **All eight pools.** win, place, bracket_quinella, quinella, wide, exacta,
    trio, trifecta.

Status: fixture-tested against ``tests/fixtures/netkeiba/payouts_*.json``.
The record-builder is load-bearing; the parser is explicitly marked for
real-world recalibration before PC cutover (ADR-0004).
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Callable, Iterable

from keibamon_core.adapters import netkeiba_http
from keibamon_core.ingestion.scrape_upsert import scrape_upsert
from keibamon_core.paths import LakePaths

# Canonicalize combos through settlement's own normalization so the new rows
# slot into settle_many's lookup unchanged. ``_normalize_selection`` is the
# oracle's lookup key formatter -- reusing it here is the load-bearing contract.
from keibamon_core.ingestion.settlement import _normalize_selection

SOURCE_NAME = "netkeiba"
BRONZE_SOURCE = "netkeiba_payouts"
TABLE = "jravan_payouts"
# Include source_name so a scrape payout row coexists with the JV-Link row for
# the same (race, pool, combo) -- the cross-validation gate compares them
# side-by-side. settlement._load_official_payouts MAX-collapses per
# (race, pool, combo) regardless of source, so duplicate JV-Link + scrape
# rows on the read side still resolve to one payout; only the SILVER table
# keeps both observations distinct for the audit.
NATURAL_KEY: tuple[str, ...] = ("race_id", "pool", "combo", "source_name")

_EVENT_TIME_FIELDS = ("official_datetime", "update_datetime", "published_time")

# netkeiba's Japanese pool labels -> the silver pool vocabulary that
# settlement.py uses. ``_normalize_selection`` keys off these labels.
_POOL_LABELS: dict[str, str] = {
    "tansho": "win",
    "fukusho": "place",
    "wakuren": "bracket_quinella",
    "umaren": "quinella",
    "wide": "wide",
    "umatan": "exacta",
    "sanrenpuku": "trio",
    "sanrentan": "trifecta",
}


def parse_payouts_payload(
    payload_text: str, nk_race_id: str
) -> list[dict[str, Any]]:
    """Extract one intermediate dict per (pool, combo, payout) on the page.

    Fixture format -- the ``data.payouts`` block maps netkeiba pool labels to
    either a single dict (one combo), or a list of dicts (multiple combos /
    dead-heat). Each leaf dict has ``combo`` / ``payout`` / optional
    ``ninki``:

    .. code-block:: json

        {
          "status": "ok",
          "data": {
            "official_datetime": "2026-06-20 15:30:30",
            "payouts": {
              "tansho": {"combo": "14", "payout": "290", "ninki": "1"},
              "fukusho": [
                {"combo": "14", "payout": "130", "ninki": "1"},
                {"combo": "16", "payout": "110", "ninki": "2"}
              ],
              "sanrentan": {"combo": "141608", "payout": "45600", "ninki": "60"}
            }
          }
        }

    Returns ``[]`` for payloads with no payouts block (race not yet decided).
    Combos are NOT canonicalized here -- that happens in :func:`_payout_record`
    via ``_normalize_selection`` so the parser stays a pure wire-extractor.

    Failure modes are loud per ADR-0004's "loud monitoring on scrape failure"
    mandate: malformed JSON raises ``ValueError`` (the bronze archive already
    captured the raw bytes); a missing event-time field raises ``ValueError``
    rather than silently falling back to the scrape time.
    """
    payload = json.loads(payload_text)  # raises ValueError on malformed JSON
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return []
    payouts = data.get("payouts") or data.get("harai") or {}
    if not isinstance(payouts, dict):
        return []

    published = _extract_event_time(data)
    if published is None:
        raise ValueError(
            f"payouts payload for {nk_race_id} has no event-time field "
            f"({_EVENT_TIME_FIELDS}); refusing to fall back to scrape time "
            "(available_at_bulk_download PIT trap)"
        )
    out: list[dict[str, Any]] = []
    for source_label, block in payouts.items():
        pool = _POOL_LABELS.get(source_label, source_label)
        for leaf in _iter_payout_leaves(block):
            combo_raw = leaf.get("combo")
            payout = _to_int(leaf.get("payout"))
            if combo_raw is None or payout is None:
                continue
            out.append({
                "pool": pool,
                "combo_raw": str(combo_raw),
                "payout_yen": payout,
                "popularity": _to_int(leaf.get("ninki")),
                "published_time": published,
                "source_race_id": nk_race_id,
            })
    return out


def _payout_record(
    race_id: str, raw: dict[str, Any], meta: dict[str, Any]
) -> dict[str, Any]:
    """Pure layer: one (pool, combo, payout) -> the EXACT jravan_payouts shape.

    Combos are canonicalized through :func:`settlement._normalize_selection` --
    the same function the settlement oracle uses to look up a bet's payout --
    so the scrape rows drop into ``settle_many``'s map unchanged. Mirrors
    :func:`jravan_silver.build_jravan_payouts` byte-for-byte (column set +
    provenance). For scrape rows ``available_at`` and ``published_time`` are
    the same instant by construction.
    """
    published = raw.get("published_time")
    return {
        "race_id": race_id,
        "pool": raw["pool"],
        "combo": _normalize_selection(raw["combo_raw"], raw["pool"]),
        "payout_yen": raw["payout_yen"],
        "popularity": raw.get("popularity"),
        # Provenance.
        "source_name": SOURCE_NAME,
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": meta.get("ingested_at"),
        "published_time": published,
        "available_at": published,  # event time, NOT scrape download time
    }


def build_payouts(
    lake: LakePaths,
    nk_race_id: str,
    race_id: str,
    *,
    fetch_fn: Callable[[str], str] | None = None,
    captured_at: datetime | None = None,
    payload_text: str | None = None,
) -> int:
    """Fetch one race's payouts -> bronze archive -> silver upsert.

    See :func:`netkeiba_entries.build_entries` for the seam contract. Returns
    the count of NEW silver rows. Re-running an already-settled day returns 0.
    """
    captured_at = captured_at or netkeiba_http.utc_now()
    if payload_text is None:
        fetch_fn = fetch_fn or _default_fetch
        payload_text = fetch_fn(nk_race_id)

    raw_path = netkeiba_http.archive_raw(
        lake, BRONZE_SOURCE, nk_race_id, "payouts", payload_text, captured_at
    )
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = netkeiba_http.utc_now()

    parsed = parse_payouts_payload(payload_text, nk_race_id)
    records = [
        _payout_record(
            race_id,
            raw,
            {
                "source_record_id": f"{nk_race_id}:payouts",
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


def _iter_payout_leaves(block: Any) -> Iterable[dict[str, Any]]:
    """A pool's block is either a single leaf dict or a list of leaves
    (dead-heat / multi-combo pools like place/wide). Coerce to a flat list."""
    if isinstance(block, dict):
        # A leaf has a `combo` key; if it lacks one, treat the dict itself as
        # a map of {combo: payout} (a shorthand seen in some netkeiba formats).
        if "combo" in block:
            yield block
        else:
            for combo, payout in block.items():
                if isinstance(payout, dict):
                    yield {"combo": combo, **payout}
                else:
                    yield {"combo": combo, "payout": payout}
    elif isinstance(block, list):
        for leaf in block:
            if isinstance(leaf, dict):
                yield leaf


def _to_int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None
