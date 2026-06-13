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
