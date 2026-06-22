"""Tests for tools/jravan/publish_d1.py -- verifies the D1 upsert request shape
without making a network call (HTTP opener is injected)."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "publish_d1", Path(__file__).resolve().parents[1] / "tools" / "jravan" / "publish_d1.py"
)
publish_d1 = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(publish_d1)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def read(self):
        return self._payload


def test_push_to_d1_builds_correct_request():
    captured = {}

    def fake_opener(request, timeout=None):
        captured["url"] = request.full_url
        captured["headers"] = {k.lower(): v for k, v in request.header_items()}
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["method"] = request.get_method()
        return _FakeResponse({"success": True, "result": []})

    snapshot = {"meta": {"venue": "Hanshin", "published_at": "2026-06-14T06:30:00Z"},
                "races": [{"race_no": 11, "runners": [{"umaban": 5, "win_odds": 2.6}]}]}

    out = publish_d1.push_to_d1(
        snapshot, key="hanshin", account_id="acct123", db_id="db456",
        token="tok789", _opener=fake_opener,
    )

    assert out == {"success": True, "result": []}
    assert captured["method"] == "POST"
    assert "accounts/acct123/d1/database/db456/query" in captured["url"]
    assert captured["headers"]["authorization"] == "Bearer tok789"
    # SQL is a parameterised upsert; params carry key, the JSON payload, timestamp
    assert "INSERT OR REPLACE INTO live_snapshot" in captured["body"]["sql"]
    key, payload, published_at = captured["body"]["params"]
    assert key == "hanshin"
    assert published_at == "2026-06-14T06:30:00Z"        # taken from meta
    reparsed = json.loads(payload)
    assert reparsed["races"][0]["runners"][0]["win_odds"] == 2.6   # round-trips


def test_push_to_d1_defaults_published_at_when_missing(monkeypatch):
    captured = {}

    def fake_opener(request, timeout=None):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        return _FakeResponse({"success": True})

    publish_d1.push_to_d1(
        {"meta": {}, "races": []}, account_id="a", db_id="d", token="t", _opener=fake_opener,
    )
    # a timestamp was generated (ISO-8601, ends with +00:00 for UTC)
    assert captured["body"]["params"][2].endswith("+00:00")


def test_fetch_snapshot_returns_parsed_payload_when_row_present():
    """Guard's read path: SELECT payload ... -> parsed JSON. Verifies the SQL
    shape + params + JSON parse so the guard in expose_live.main gets a real
    dict to compare against."""
    captured = {}

    def fake_opener(request, timeout=None):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["url"] = request.full_url
        captured["method"] = request.get_method()
        # D1 REST envelope: result[0].results[].payload is the stored JSON string
        stored = {"meta": {"date": "20260621"}, "races": [{"race_no": i} for i in range(1, 37)]}
        return _FakeResponse(
            {"success": True, "result": [{"results": [{"payload": json.dumps(stored)}]}]}
        )

    snap = publish_d1.fetch_snapshot(
        key="current", account_id="acct", db_id="db", token="tok", _opener=fake_opener
    )

    # SQL shape: parameterized SELECT, key bound
    assert "SELECT payload FROM live_snapshot" in captured["body"]["sql"]
    assert captured["body"]["params"] == ["current"]
    assert captured["method"] == "POST"
    # Parsed round-trip
    assert snap is not None
    assert snap["meta"]["date"] == "20260621"
    assert len(snap["races"]) == 36


def test_fetch_snapshot_returns_none_when_row_absent():
    """First publish / cleared key: no row → None. The guard must let the
    publish through (no prior to clobber)."""

    def fake_opener(request, timeout=None):
        return _FakeResponse({"success": True, "result": [{"results": []}]})

    snap = publish_d1.fetch_snapshot(
        key="never-used", account_id="a", db_id="d", token="t", _opener=fake_opener
    )
    assert snap is None


def test_fetch_snapshot_returns_none_on_malformed_payload():
    """A garbage payload (shouldn't happen, but defense in depth) → None, not
    a raised exception. The guard then lets the publish through."""

    def fake_opener(request, timeout=None):
        return _FakeResponse(
            {"success": True, "result": [{"results": [{"payload": "not json"}]}]}
        )

    snap = publish_d1.fetch_snapshot(
        key="current", account_id="a", db_id="d", token="t", _opener=fake_opener
    )
    assert snap is None


# ---------------------------------------------------------------------------
# R4 (Tokyo truncation root cause) -- race_card_max helpers.
# The per-(date, venue) high-water table is the guard's INDEPENDENT baseline.
# fetch_race_card_max reads it; upsert_race_card_max advances it after a
# successful publish. Errors degrade to empty / logged so a missing or
# not-yet-created race_card_max table can't strand the dashboard.
# ---------------------------------------------------------------------------


def test_fetch_race_card_max_returns_empty_for_no_dates():
    """No dates -> no query -> empty dict. Cheap boundary case."""
    out = publish_d1.fetch_race_card_max(
        [], account_id="a", db_id="d", token="t", _opener=lambda *a, **k: None
    )
    assert out == {}


def test_fetch_race_card_max_parses_rows_to_dict():
    """Read path: SELECT ... -> {(date, venue): max_races}. Verifies the IN
    clause + row extraction so the guard gets a real dict to compare against."""
    captured = {}

    def fake_opener(request, timeout=None):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        return _FakeResponse(
            {
                "success": True,
                "result": [
                    {
                        "results": [
                            {"date_yyyymmdd": "20260621", "venue_code": "05", "max_races": 12},
                            {"date_yyyymmdd": "20260621", "venue_code": "09", "max_races": 12},
                            {"date_yyyymmdd": "20260621", "venue_code": "02", "max_races": 12},
                        ]
                    }
                ],
            }
        )

    out = publish_d1.fetch_race_card_max(
        ["20260621"], account_id="a", db_id="d", token="t", _opener=fake_opener
    )
    # IN clause with one placeholder per date
    assert "WHERE date_yyyymmdd IN (?)" in captured["body"]["sql"]
    assert captured["body"]["params"] == ["20260621"]
    assert out == {
        ("20260621", "05"): 12,
        ("20260621", "09"): 12,
        ("20260621", "02"): 12,
    }


def test_fetch_race_card_max_degrades_to_empty_on_query_error():
    """If race_card_max doesn't exist yet (pre-migration) or the query fails,
    the guard must NOT die -- it treats the state as 'no prior max' so the
    publish goes through (the structural floor is the backstop for this case)."""
    def fake_opener(request, timeout=None):
        # D1 returns HTTP 200 with an error envelope for "no such table"
        return _FakeResponse(
            {"success": False, "errors": [{"code": 7500, "text": "no such table"}]}
        )

    # _d1_query raises on non-2xx; simulate via an opener that raises RuntimeError
    def raising_opener(request, timeout=None):
        raise RuntimeError("HTTP 500")

    out = publish_d1.fetch_race_card_max(
        ["20260621"], account_id="a", db_id="d", token="t", _opener=raising_opener
    )
    assert out == {}


def test_upsert_race_card_max_issues_on_conflict_do_update():
    """Write path: INSERT ... ON CONFLICT DO UPDATE WHERE excluded > current.
    Verifies the SQL shape + params so a regression in the upsert semantics
    (e.g. losing the WHERE clause) is caught."""
    captured_sqls = []

    def fake_opener(request, timeout=None):
        body = json.loads(request.data.decode("utf-8"))
        captured_sqls.append((body["sql"], body["params"]))
        return _FakeResponse(
            {"success": True, "result": [{"meta": {"changes": 1}}]}
        )

    n = publish_d1.upsert_race_card_max(
        {("20260621", "05"): 12, ("20260621", "09"): 12},
        account_id="a", db_id="d", token="t", _opener=fake_opener,
    )
    assert n == 2  # both inserts counted
    # Each row upserted separately -- 2 SQL executions.
    assert len(captured_sqls) == 2
    sql = captured_sqls[0][0]
    assert "INSERT INTO race_card_max" in sql
    assert "ON CONFLICT(date_yyyymmdd, venue_code) DO UPDATE" in sql
    assert "excluded.max_races > race_card_max.max_races" in sql  # never lower
    params = captured_sqls[0][1]
    assert params[0] in ("20260621",)  # date
    assert params[1] in ("05", "09")  # venue
    assert params[2] == 12  # max_races


def test_upsert_race_card_max_noop_on_empty_input():
    """Empty counts dict -> no SQL issued -> returns 0."""
    called = []

    def fake_opener(request, timeout=None):
        called.append(request)
        return _FakeResponse({"success": True, "result": [{"meta": {"changes": 0}}]})

    n = publish_d1.upsert_race_card_max(
        {}, account_id="a", db_id="d", token="t", _opener=fake_opener
    )
    assert n == 0
    assert called == []

