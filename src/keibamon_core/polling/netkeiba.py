from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

JST = timezone(timedelta(hours=9))

ODDS_API_URL = "https://race.netkeiba.com/api/api_get_jra_odds.html?race_id={race_id}&type=1&action=update"
USER_AGENT = "Keibamon/0.1 (personal research; low-frequency odds polling)"
FETCH_TIMEOUT_SECONDS = 20

# Block keys in the odds payload ("odds" object).
_WIN_BLOCK = "1"
_PLACE_BLOCK = "2"


def fetch_odds_payload(netkeiba_race_id: str, timeout: float = FETCH_TIMEOUT_SECONDS) -> str:
    """Fetch the raw odds JSON for one race (network; isolated for testing).

    Single GET per call, polite User-Agent, no retries — the poller's
    schedule is the rate limiter. Everything else in the polling package is
    pure and testable offline.
    """
    import urllib.request

    request = urllib.request.Request(
        ODDS_API_URL.format(race_id=netkeiba_race_id),
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def parse_odds_payload(
    payload_text: str,
    race_id: str,
    raw_uri: str,
    captured_at: datetime,
) -> list[dict[str, Any]]:
    """Parse a netkeiba odds payload into silver odds_snapshot records.

    ``available_at`` comes from the payload's ``official_datetime`` (JST,
    the JRA official odds timestamp), falling back to ``captured_at``.
    Returns an empty list when the payload carries no odds yet (pre-announcement).
    """
    payload = json.loads(payload_text)
    data = payload.get("data") or {}
    odds_blocks = data.get("odds") or {}
    win_block: dict[str, list[str]] = odds_blocks.get(_WIN_BLOCK) or {}
    place_block: dict[str, list[str]] = odds_blocks.get(_PLACE_BLOCK) or {}
    if not win_block and not place_block:
        return []

    available_at = _parse_official_datetime(data.get("official_datetime")) or captured_at
    status = str(payload.get("status") or "unknown")
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = datetime.now(timezone.utc)

    records: list[dict[str, Any]] = []
    for number_str in sorted(set(win_block) | set(place_block)):
        win = win_block.get(number_str) or []
        place = place_block.get(number_str) or []
        records.append(
            {
                "race_id": race_id,
                "horse_number": int(number_str),
                "win_odds": _odds_value(win, 0),
                "place_odds_low": _odds_value(place, 0),
                "place_odds_high": _odds_value(place, 1),
                "popularity": _int_value(win, 2),
                "status": status,
                "captured_at": captured_at,
                "available_at": available_at,
                "source_name": "netkeiba",
                "raw_uri": raw_uri,
                "content_hash": content_hash,
                "ingested_at": ingested_at,
            }
        )
    return records


def _parse_official_datetime(value: str | None) -> datetime | None:
    """netkeiba sends naive JST like '2026-06-07 15:10:41'."""
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=JST)
    except ValueError:
        return None


def _odds_value(values: list[str], index: int) -> float | None:
    try:
        return float(values[index])
    except (IndexError, TypeError, ValueError):
        return None


def _int_value(values: list[str], index: int) -> int | None:
    try:
        return int(values[index])
    except (IndexError, TypeError, ValueError):
        return None
