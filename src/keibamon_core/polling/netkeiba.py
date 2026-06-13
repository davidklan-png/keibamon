from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

JST = timezone(timedelta(hours=9))

ODDS_API_URL = (
    "https://race.netkeiba.com/api/api_get_jra_odds.html"
    "?race_id={race_id}&type={odds_type}&action=update"
)
USER_AGENT = "Keibamon/0.1 (personal research; low-frequency odds polling)"
FETCH_TIMEOUT_SECONDS = 20

# Block keys inside the win/place payload's "odds" object.
_WIN_BLOCK = "1"
_PLACE_BLOCK = "2"

# netkeiba api_get_jra_odds 'type' param -> pool label. type=1 (win+place) is
# CONFIRMED against captured payloads (returns blocks "1"=win, "2"=place, plus the
# data object's h_tansho/h_fukusho/... sale flags). The exotic type codes below
# follow the order of those h_* flags (wakuren, umaren, wide, umatan, sanrenpuku,
# sanrentan) and are TO BE VERIFIED against the first live archived exotic race --
# the raw payload is archived regardless, so verification is replayable and nothing
# is lost if a code is off. See parse_combo_odds_payload.
POOL_TYPES: dict[str, str] = {
    "1": "win_place",         # 単勝・複勝 [confirmed]
    "2": "bracket_quinella",  # 枠連      [verify]
    "3": "quinella",          # 馬連      [verify]
    "4": "wide",              # ワイド     [verify]
    "5": "exacta",            # 馬単      [verify]
    "6": "trio",              # 三連複     [verify]
    "7": "trifecta",          # 三連単     [verify]
}
EXOTIC_TYPES: tuple[str, ...] = tuple(t for t in POOL_TYPES if t != "1")


# In-process conditional-GET cache: url -> (etag, last_modified, text). Lets a
# repeated fetch send If-None-Match / If-Modified-Since and reuse the cached body
# on a 304, so a static source costs almost no bandwidth. Process-local by design
# (cleared on restart); the poller's change-detection is the durable layer.
_COND_CACHE: dict[str, tuple[str | None, str | None, str]] = {}


def fetch_odds_payload(
    netkeiba_race_id: str, odds_type: str = "1", timeout: float = FETCH_TIMEOUT_SECONDS
) -> str:
    """Fetch the raw odds JSON for one race + one pool ``odds_type`` (network;
    isolated for testing).

    Single GET per call, polite User-Agent, no retries — the poller's schedule
    is the rate limiter. Sends conditional headers (ETag/Last-Modified) and
    returns the cached body unchanged on a 304 Not Modified, so polling a static
    source is cheap. Everything else in the polling package is pure and testable
    offline.
    """
    import urllib.error
    import urllib.request

    url = ODDS_API_URL.format(race_id=netkeiba_race_id, odds_type=odds_type)
    headers = {"User-Agent": USER_AGENT}
    cached = _COND_CACHE.get(url)
    if cached:
        etag, last_mod, _ = cached
        if etag:
            headers["If-None-Match"] = etag
        if last_mod:
            headers["If-Modified-Since"] = last_mod

    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            _COND_CACHE[url] = (
                response.headers.get("ETag"),
                response.headers.get("Last-Modified"),
                text,
            )
            return text
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and cached:
            return cached[2]  # not modified: reuse cached body
        raise


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


def parse_combo_odds_payload(
    payload_text: str,
    race_id: str,
    pool: str,
    raw_uri: str,
    captured_at: datetime,
) -> list[dict[str, Any]]:
    """Parse an exotic (combination-keyed) odds payload into combo_odds rows.

    PROVISIONAL parser. It is validated only against the confirmed win/place
    block shape so far -- ``{key: [odds, ..., popularity]}``. Exotic pools use
    the same combo-keyed structure, but the exact block numbering and value
    layout must be confirmed against the first live archived exotic race before
    the parsed values are trusted. The poller archives every raw payload to
    bronze regardless, so this parse is fully replayable and nothing is lost if
    it needs correcting.

    Treats each entry's key as the combination string and the value list as
    ``[odds, ..., popularity]`` (first numeric = odds, trailing integer =
    popularity), mirroring the confirmed win/place layout. ``block`` retains the
    raw block key so multi-block payloads remain distinguishable downstream.
    """
    payload = json.loads(payload_text)
    data = payload.get("data") or {}
    odds_blocks = data.get("odds") or {}
    if not odds_blocks:
        return []

    available_at = _parse_official_datetime(data.get("official_datetime")) or captured_at
    status = str(payload.get("status") or "unknown")
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = datetime.now(timezone.utc)

    records: list[dict[str, Any]] = []
    for block_key, block in odds_blocks.items():
        if not isinstance(block, dict):
            continue
        for combo, values in block.items():
            if not isinstance(values, list) or not values:
                continue
            records.append(
                {
                    "race_id": race_id,
                    "pool": pool,
                    "block": str(block_key),
                    "combo": str(combo),
                    "odds": _odds_value(values, 0),
                    "popularity": _int_value(values, len(values) - 1),
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
