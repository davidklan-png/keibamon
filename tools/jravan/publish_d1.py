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


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
