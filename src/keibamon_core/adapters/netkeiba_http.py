"""Shared fetch + bronze-archive primitives for the non-odds netkeiba adapters.

Pulls the polite-fetch conventions out of ``polling/netkeiba.py`` so the
entries/results/payouts adapters can reuse them without duplicating the
network layer. Three primitives:

- :func:`fetch_payload` — polite GET with a descriptive User-Agent, conditional
  GET (ETag / If-Modified-Since), and a process-wide rate floor. The rate floor
  is **mandatory** under ADR-0004: scraping is the post-cutover source of
  truth, so politeness is non-negotiable.
- :func:`archive_raw` — idempotent one-shot bronze write of the raw payload,
  sha256 change-detected so re-ingesting an unchanged payload adds no file.
  Pattern lifted from ``polling/poller.py:poll_once``.
- :func:`parse_official_datetime` — re-export of ``polling/netkeiba``'s single
  JST→datetime parsing path, so every adapter stamps ``available_at`` the same
  way (the ``available_at_bulk_download`` lesson).

This module is deliberately network-thin. Parsing lives in the per-table
adapter (``netkeiba_entries`` / ``netkeiba_results`` / ``netkeiba_payouts``)
because each payload has its own shape.
"""
from __future__ import annotations

import hashlib
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from keibamon_core.paths import LakePaths
from keibamon_core.polling.netkeiba import _parse_official_datetime

# Re-exported under a public name so adapter call sites read cleanly. This is
# the single JST parsing path for every netkeiba payload; callers must not roll
# their own (the ``available_at_bulk_download`` lesson is exactly what happens
# when two paths disagree on what "the event time" means).
parse_official_datetime = _parse_official_datetime

USER_AGENT = "Keibamon/0.1 (personal research; low-frequency scrape)"
FETCH_TIMEOUT_SECONDS = 20

# ADR-0004 mandatory polite fetch: minimum gap between any two fetches. Loud on
# violation -- politeness is the load-bearing assumption of going scrape-only.
MIN_FETCH_INTERVAL_SECONDS = 3.0
_LAST_FETCH_MONOTONIC: float = 0.0

# In-process conditional-GET cache: url -> (etag, last_modified, body). On a 304
# the cached body is returned verbatim. Process-local by design; the bronze
# archive is the durable layer.
_COND_CACHE: dict[str, tuple[str | None, str | None, str]] = {}


def fetch_payload(
    url: str,
    *,
    timeout: float = FETCH_TIMEOUT_SECONDS,
) -> tuple[str, dict[str, str | None]]:
    """Single polite GET. Returns ``(body, headers)``.

    Sends ``If-None-Match`` / ``If-Modified-Since`` on repeat fetches and
    returns the cached body unchanged on a 304 Not Modified, so polling a
    static source is cheap. The conditional cache is process-local; the bronze
    archive is the durable layer.

    Paces itself: if less than :data:`MIN_FETCH_INTERVAL_SECONDS` has elapsed
    since the last fetch (from ANY caller in this process -- discovery counts
    against the per-race adapter calls), sleeps until the floor is satisfied.
    This is the BUG-3 fix: the orchestrator (``tools/scrape_ingest.py``) loops
    through up to four adapter calls per race, and each ``build_*`` calls
    ``fetch_payload`` once -- the floor at the network layer keeps every
    fetch polite without the orchestrator having to know about it. Tests
    bypass this by injecting a ``fetch_fn=`` seam into the adapter; they never
    touch this network path.

    Decodes the body using the charset advertised in the ``Content-Type``
    header, falling back to UTF-8. ADR-0004's calibration found netkeiba's
    race pages are served as ``text/html; charset=UTF-8`` (verified against
    multiple shutuba/result captures on 2026-06-19) -- but we honor the header
    rather than hard-code UTF-8 so a future server-side change doesn't silently
    produce mojibake.
    """
    _pace_to_rate_floor()
    headers: dict[str, str] = {"User-Agent": USER_AGENT}
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
            raw = response.read()
            charset = _charset_from_content_type(
                response.headers.get("Content-Type", "")
            )
            body = raw.decode(charset)
            resp_headers = {
                "ETag": response.headers.get("ETag"),
                "Last-Modified": response.headers.get("Last-Modified"),
            }
            _COND_CACHE[url] = (resp_headers["ETag"], resp_headers["Last-Modified"], body)
            return body, resp_headers
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and cached:
            return cached[2], {"ETag": cached[0], "Last-Modified": cached[1]}
        raise


def _charset_from_content_type(content_type: str) -> str:
    """Pull the charset=NAME token out of a Content-Type header value.

    Defaults to ``utf-8`` -- empirically what netkeiba serves (verified
    2026-06-19 against race_list_sub.html, shutuba.html, and result.html).
    The earlier project note claiming EUC-JP was wrong; EUC-JP fails to
    decode the actual bytes (raises ``UnicodeDecodeError`` on the first
    multibyte sequence in every capture).
    """
    for chunk in content_type.split(";"):
        chunk = chunk.strip().lower()
        if chunk.startswith("charset="):
            return chunk.split("=", 1)[1].strip().strip('"\'') or "utf-8"
    return "utf-8"


def archive_raw(
    lake: LakePaths,
    source: str,
    nk_race_id: str,
    kind: str,
    payload: str,
    captured_at: datetime,
) -> Path:
    """Write a raw payload to bronze once. Idempotent on sha256(payload).

    Layout::

        <lake>/raw/<source>/<nk_race_id>/<kind>/<UTCstamp>.json
        <lake>/raw/<source>/<nk_race_id>/<kind>/_last_hash.txt

    If the last archived payload for ``(race_id, kind)`` has the same sha256,
    return the most recently written path and skip the write. Mirrors
    ``polling/poller.py:poll_once``'s change-detection state: one raw copy per
    distinct source state.

    Returns the path of the row's bronze artifact (suitable for the silver
    row's ``raw_uri``).
    """
    kind_dir = lake.bronze_source_dir(source) / nk_race_id / kind
    kind_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()

    state_path = kind_dir / "_last_hash.txt"
    if state_path.exists():
        last = state_path.read_text(encoding="utf-8").strip()
        if last == digest:
            # Same payload as last archive -- reuse the most recent path.
            stamped = sorted(kind_dir.glob("*.json"))[-1]
            return stamped

    stamp = captured_at.strftime("%Y%m%dT%H%M%S%fZ")
    path = kind_dir / f"{stamp}.json"
    path.write_text(payload, encoding="utf-8")
    state_path.write_text(digest, encoding="utf-8")
    return path


def reset_rate_floor_for_tests() -> None:
    """Reset the polite-fetch floor. Test seam only.

    Tests that exercise :func:`fetch_payload` directly (rare -- most bypass it
    via ``fetch_fn=``) call this to start each case with a clean floor.
    """
    global _LAST_FETCH_MONOTONIC
    _LAST_FETCH_MONOTONIC = 0.0


def _pace_to_rate_floor() -> None:
    """Sleep until :data:`MIN_FETCH_INTERVAL_SECONDS` has elapsed since the
    last fetch, then stamp the new floor.

    Self-pacing is the BUG-3 fix: scraping is the post-cutover source of truth
    and a rate-limit ban on the only feed would silently lose race days, so
    the floor MUST hold across every fetch in the process -- discovery's
    initial GET counts against the per-race adapter calls that follow. Putting
    the sleep here (instead of in the orchestrator) means every caller stays
    polite without having to know about the floor.
    """
    global _LAST_FETCH_MONOTONIC
    if _LAST_FETCH_MONOTONIC > 0:
        elapsed = time.monotonic() - _LAST_FETCH_MONOTONIC
        gap = MIN_FETCH_INTERVAL_SECONDS - elapsed
        if gap > 0:
            time.sleep(gap)
    _LAST_FETCH_MONOTONIC = time.monotonic()


# Module-level datetime helpers ------------------------------------------------

def utc_now() -> datetime:
    """Convenience: tz-aware UTC now. Adapter modules call this for ingested_at."""
    return datetime.now(timezone.utc)


def format_provenance_iso(dt: datetime | None) -> str | None:
    """Format a datetime as ISO 8601 with a ``Z`` suffix, or ``None``.

    Matches the existing ``jravan_*`` silver tables' ``ingested_at`` and
    ``published_time`` columns, which are typed ``string`` (not timestamp) --
    the JV-Link bronze path writes ISO 8601 strings and the silver builder
    passes them through. Scrape adapters stringify to match so the
    partition-aware upsert doesn't trip on pyarrow's type-unification
    (``ArrowTypeError: Expected bytes, got a 'datetime.datetime' object`` --
    the bug surfaced in the 2026-06-19 VALIDATE dry run). ``available_at``
    stays a datetime; only the two provenance columns are string.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        from datetime import timezone as _tz
        dt = dt.replace(tzinfo=_tz.utc)
    return dt.isoformat().replace("+00:00", "Z")
