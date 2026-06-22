"""publish_d1.py -- push a live race-day snapshot to the Cloudflare D1 dashboard.

Shared by the realtime JV-Link worker (PC) and the netkeiba scrape poller (Mac):
both call push_to_d1() to upsert the snapshot document that splash/live.html reads
via the Worker's /api/live route. Pure stdlib (urllib) so it runs on the PC's
32-bit venv with no extra dependencies.

Credentials come from the environment and are NEVER hard-coded or logged:
    CF_API_TOKEN       Cloudflare API token scoped to D1 Edit
    CF_ACCOUNT_ID      Cloudflare account id
    CF_D1_DATABASE_ID  keibamon-live database id

Snapshot document shape (one row, key='hanshin'):
    {"meta": {"venue","date","status","published_at",...},
     "races": [{"race_no","name","post_time_jst","status","capture":{...},
                "runners":[{"umaban","name","win_odds","win_open","place_low",
                            "place_high","model_rank"}], "result": {...}|null}]}
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone

D1_QUERY_URL = "https://api.cloudflare.com/client/v4/accounts/{acct}/d1/database/{db}/query"
UPSERT_SQL = "INSERT OR REPLACE INTO live_snapshot (key, payload, published_at) VALUES (?, ?, ?)"
FETCH_SQL = "SELECT payload FROM live_snapshot WHERE key = ?"
MAX_SELECT_SQL = (
    "SELECT date_yyyymmdd, venue_code, max_races FROM race_card_max "
    "WHERE date_yyyymmdd IN ({placeholders})"
)
MAX_UPSERT_SQL = (
    "INSERT INTO race_card_max (date_yyyymmdd, venue_code, max_races, "
    "first_seen_at, updated_at) "
    "VALUES (?, ?, ?, ?, ?) "
    "ON CONFLICT(date_yyyymmdd, venue_code) DO UPDATE SET "
    "max_races = excluded.max_races, updated_at = excluded.updated_at "
    "WHERE excluded.max_races > race_card_max.max_races"
)


def push_to_d1(
    snapshot: dict,
    *,
    key: str = "hanshin",
    account_id: str | None = None,
    db_id: str | None = None,
    token: str | None = None,
    timeout: float = 15,
    _opener=None,
) -> dict:
    """Upsert one snapshot document into live_snapshot[key]; return the API JSON.

    account_id/db_id/token default to the CF_* env vars. Raises RuntimeError on a
    non-2xx response (with the API error body) so a publish failure is loud but
    never kills the capture loop (callers wrap this in try/except). ``_opener`` is
    an injection seam for tests; production uses urllib.
    """
    account_id = account_id or os.environ["CF_ACCOUNT_ID"]
    db_id = db_id or os.environ["CF_D1_DATABASE_ID"]
    token = token or os.environ["CF_API_TOKEN"]

    payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    published_at = (snapshot.get("meta") or {}).get("published_at") or _utc_now_iso()
    body = json.dumps({"sql": UPSERT_SQL, "params": [key, payload, published_at]}).encode("utf-8")

    request = urllib.request.Request(
        D1_QUERY_URL.format(acct=account_id, db=db_id),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    opener = _opener or urllib.request.urlopen
    try:
        with opener(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"D1 publish failed (HTTP {exc.code}): {detail}") from exc


def _d1_query(
    sql: str,
    params: list,
    *,
    account_id: str | None = None,
    db_id: str | None = None,
    token: str | None = None,
    timeout: float = 15,
    _opener=None,
) -> dict:
    """Run a single SQL statement against D1 via the REST API. Returns the raw
    API JSON envelope (callers mine ``result[0].results``). Shared by fetch+push
    so they hit the same auth/endpoint shape."""
    account_id = account_id or os.environ["CF_ACCOUNT_ID"]
    db_id = db_id or os.environ["CF_D1_DATABASE_ID"]
    token = token or os.environ["CF_API_TOKEN"]

    body = json.dumps({"sql": sql, "params": params}).encode("utf-8")
    request = urllib.request.Request(
        D1_QUERY_URL.format(acct=account_id, db=db_id),
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    opener = _opener or urllib.request.urlopen
    try:
        with opener(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"D1 query failed (HTTP {exc.code}): {detail}") from exc


def fetch_snapshot(
    key: str = "current",
    *,
    account_id: str | None = None,
    db_id: str | None = None,
    token: str | None = None,
    timeout: float = 15,
    _opener=None,
) -> dict | None:
    """Read the current snapshot document for ``key`` and return the parsed
    JSON, or ``None`` if no such row exists.

    Used by the publisher's partial-publish guard (see ``expose_live._should_skip_publish``):
    before overwriting ``key='current'`` we fetch the prior payload and refuse
    the write if the new one is strictly less complete for any date. A missing
    row is fine — first publish, or the key was cleared — and the guard lets
    the write through.

    Errors raise RuntimeError (same as ``push_to_d1``) so callers can wrap and
    continue the loop without killing the agent.
    """
    env = dict(account_id=account_id, db_id=db_id, token=token, timeout=timeout)
    if _opener is not None:
        env["_opener"] = _opener
    envelope = _d1_query(FETCH_SQL, [key], **env)
    results = (
        (envelope or {})
        .get("result", [])
    )
    if not results:
        return None
    rows = results[0].get("results", []) if isinstance(results[0], dict) else []
    if not rows:
        return None
    payload = rows[0].get("payload")
    if payload is None:
        return None
    try:
        return json.loads(payload)
    except (TypeError, ValueError):
        return None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_race_card_max(
    dates_yyyymmdd: list[str],
    *,
    account_id: str | None = None,
    db_id: str | None = None,
    token: str | None = None,
    timeout: float = 15,
    _opener=None,
) -> dict[tuple[str, str], int]:
    """Read the per-(date, venue) high-water marks for the given dates.

    Returns a ``{(date, venue_code): max_races}`` dict. Empty (no rows / table
    missing / fetch error) is a legitimate state -- the publisher's guard
    treats "no prior max" as "anything publishes", since there's nothing to
    regress against. Errors degrade to empty (with a stderr warning) rather
    than killing the publish loop: a missing race_card_max read should not
    strand the dashboard.

    Used by ``expose_live.should_skip_publish`` as the INDEPENDENT baseline.
    The post-publish ``upsert_race_card_max`` advances the mark.
    """
    if not dates_yyyymmdd:
        return {}
    placeholders = ", ".join(["?"] * len(dates_yyyymmdd))
    sql = MAX_SELECT_SQL.format(placeholders=placeholders)
    env = dict(account_id=account_id, db_id=db_id, token=token, timeout=timeout)
    if _opener is not None:
        env["_opener"] = _opener
    try:
        envelope = _d1_query(sql, list(dates_yyyymmdd), **env)
    except RuntimeError as exc:
        # Most likely cause: race_card_max not yet created (pre-0006 deploy).
        # Degrade to "no prior max" rather than killing the publish.
        print(f"fetch_race_card_max: {exc!r} -- treating as empty")
        return {}
    out: dict[tuple[str, str], int] = {}
    results = (envelope or {}).get("result", [])
    if not results:
        return out
    rows = results[0].get("results", []) if isinstance(results[0], dict) else []
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = (row.get("date_yyyymmdd"), row.get("venue_code"))
        try:
            out[key] = int(row.get("max_races"))
        except (TypeError, ValueError):
            continue
    return out


def upsert_race_card_max(
    counts_by_date_venue: dict[tuple[str, str], int],
    *,
    account_id: str | None = None,
    db_id: str | None = None,
    token: str | None = None,
    timeout: float = 15,
    _opener=None,
) -> int:
    """Advance the per-(date, venue) high-water marks. Returns the number of
    rows that were newly inserted or had their max raised.

    Idempotent: the ON CONFLICT clause only raises the max -- equal-or-smaller
    counts are no-ops. Call this AFTER a successful publish so the floor the
    guard reads next cycle reflects what we just published.

    Errors raise RuntimeError (the caller's main loop logs and continues on
    the next cycle -- a missed upsert doesn't strand the snapshot, it just
    means the next guard won't see this publish as the new floor).
    """
    if not counts_by_date_venue:
        return 0
    env = dict(account_id=account_id, db_id=db_id, token=token, timeout=timeout)
    if _opener is not None:
        env["_opener"] = _opener
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    inserted_or_updated = 0
    for (date_yyyymmdd, venue_code), max_races in counts_by_date_venue.items():
        envelope = _d1_query(
            MAX_UPSERT_SQL,
            [date_yyyymmdd, venue_code, int(max_races), now_ms, now_ms],
            **env,
        )
        meta = ((envelope or {}).get("result") or [{}])[0]
        if isinstance(meta, dict):
            changes = (meta.get("meta") or {}).get("changes", 0)
            inserted_or_updated += int(changes or 0)
    return inserted_or_updated
