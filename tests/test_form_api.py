"""HTTP-level tests for the Milestone-4 form endpoints.

Builds the form marts from silver fixtures (same scenario as test_form_marts),
then exercises the FastAPI endpoints through TestClient -- proving the PIT
filter, the no_history fallback, and the batch race endpoint work end to end.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("fastapi")
pytest.importorskip("httpx")

from fastapi.testclient import TestClient

from keibamon_api.main import app  # noqa: E402
from keibamon_core.lake import write_dataset  # noqa: E402
from keibamon_core.marts import build_form_marts  # noqa: E402
from keibamon_core.paths import LakePaths  # noqa: E402

_R0 = "jra-20260520-05-01"
_R1 = "jra-20260601-05-01"
_R2 = "jra-20260608-05-01"
_R3 = "jra-20260628-05-11"  # G3 target (upcoming, no result)
_R4 = "jra-20260710-05-01"  # future Alpha win -- PIT-excluded
_POST = datetime(2026, 6, 1, 6, 0, tzinfo=timezone.utc)


def _part(rid: str) -> tuple[int, str]:
    parts = rid.split("-")
    return int(parts[1][:4]), parts[2]


def _race(rid: str, post: datetime, *, grade_code: str | None = None,
          dist: int = 2000, wetness: int = 1) -> dict[str, Any]:
    return {
        "race_id": rid, "race_date": post.replace(hour=0, minute=0),
        "racecourse": "Tokyo", "country": "JP", "surface": "turf",
        "distance_m": dist, "scheduled_post_time": post, "race_name": f"r-{rid}",
        "grade_code": grade_code, "last_3f_seconds": 34.0, "weather": "fine",
        "going_turf": "good", "going_dirt": None, "going_wetness": wetness,
        "going": "good", "source_name": "jravan", "source_record_id": f"RA:{rid}",
        "raw_uri": f"b/{rid}", "content_hash": f"h-{rid}", "ingested_at": post,
        "published_time": post, "available_at": post,
        "year": _part(rid)[0], "venue": _part(rid)[1],
    }


def _entry(rid: str, no: int, *, name: str, jockey: str, trainer: str = "t1") -> dict[str, Any]:
    return {
        "race_id": rid, "horse_id": "0000000000", "horse_name": name,
        "horse_number": no, "gate": no, "jockey_id": jockey, "trainer_id": trainer,
        "carried_weight_kg": 57, "body_weight_kg": 480, "source_name": "jravan",
        "source_record_id": f"SE:{rid}:{no}", "raw_uri": f"b/{rid}",
        "content_hash": f"he-{rid}-{no}", "ingested_at": _POST,
        "published_time": _POST, "available_at": _POST,
        "year": _part(rid)[0], "venue": _part(rid)[1],
    }


def _result(rid: str, no: int, *, pos: int, pop: int = 1, win_odds: float = 3.0,
            available: datetime = _POST) -> dict[str, Any]:
    return {
        "race_id": rid, "horse_id": "0000000000", "horse_number": no,
        "finish_position": pos, "finish_time_seconds": 95.0, "margin": "1",
        "win_odds": win_odds, "popularity": pop, "last_3f_seconds": 33.5,
        "source_name": "jravan", "source_record_id": f"SE:{rid}:{no}",
        "raw_uri": f"b/{rid}", "content_hash": f"hr-{rid}-{no}",
        "ingested_at": available, "published_time": available, "available_at": available,
        "year": _part(rid)[0], "venue": _part(rid)[1],
    }


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    races = [
        _race(_R0, datetime(2026, 5, 20, 6, tzinfo=timezone.utc), dist=1600),
        _race(_R1, datetime(2026, 6, 1, 6, tzinfo=timezone.utc), wetness=3),
        _race(_R2, datetime(2026, 6, 8, 6, tzinfo=timezone.utc), dist=2400),
        _race(_R3, datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc), grade_code="C"),
        _race(_R4, datetime(2026, 7, 10, 6, tzinfo=timezone.utc)),
    ]
    entries = [
        _entry(_R0, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry(_R1, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry(_R1, 2, name="Gamma", jockey="j03", trainer="tC"),
        _entry(_R3, 1, name="Alpha", jockey="j02", trainer="tA"),  # upcoming
        _entry(_R4, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry(_R2, 3, name="Beta", jockey="j01", trainer="tB"),
    ]
    results = [
        _result(_R0, 1, pos=2, available=datetime(2026, 5, 20, 6, tzinfo=timezone.utc)),
        _result(_R1, 1, pos=1, available=datetime(2026, 6, 1, 6, tzinfo=timezone.utc)),
        _result(_R1, 2, pos=2, available=datetime(2026, 6, 1, 6, tzinfo=timezone.utc)),
        _result(_R2, 3, pos=3, available=datetime(2026, 6, 8, 6, tzinfo=timezone.utc)),
        _result(_R4, 1, pos=1, available=datetime(2026, 7, 10, 6, tzinfo=timezone.utc)),
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))
    build_form_marts(lake)
    monkeypatch.setenv("KEIBAMON_DATA_ROOT", str(lake.root))
    return TestClient(app)


def test_horse_form_endpoint_pit_excludes_future(client: TestClient) -> None:
    # as_of = G3 target post time (JST). Alpha has R0+R1 before it; R4 is after.
    r = client.get("/api/horses/Alpha/form", params={"as_of": "2026-06-28T15:30:00+09:00"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["career"]["starts"] == 2  # NOT 3 (R4 excluded), NOT incl R3
    assert all("2026-07-10" not in (str(d) or "")
               for d in [x["available_at"] for x in body["recent_finishes"]])
    assert "not betting advice" in body["context_note"].lower()


def test_horse_form_endpoint_unknown_is_no_history(client: TestClient) -> None:
    r = client.get("/api/horses/Nobody/form")
    assert r.status_code == 200
    assert r.json()["status"] == "no_history"


def test_jockey_form_endpoint_combos(client: TestClient) -> None:
    r = client.get("/api/jockeys/j01/form", params={"as_of": "2026-06-28T15:30:00+09:00"})
    body = r.json()
    assert body["status"] == "ok"
    # j01: Alpha x2 (R0,R1) + Beta x1 (R2) within the PIT window
    assert body["career"]["starts"] == 3
    by_horse = {c["horse_name_key"]: c for c in body["combos"]["by_horse"]}
    assert by_horse["Alpha"]["starts"] == 2


def test_race_form_batch_endpoint(client: TestClient) -> None:
    # R3 is the upcoming G3; Alpha is its only declared runner.
    r = client.get(f"/api/races/{_R3}/form")
    assert r.status_code == 200
    body = r.json()
    assert body["race_id"] == _R3
    assert len(body["runners"]) == 1
    only = body["runners"][0]
    assert only["horse_name"] == "Alpha"
    # Alpha's form-to-date for the G3 = R0 + R1 (the future R4 win excluded).
    assert only["form"]["status"] == "ok"
    assert only["form"]["career"]["starts"] == 2


def test_race_form_batch_unknown_race_is_404(client: TestClient) -> None:
    r = client.get("/api/races/jra-1999-05-99/form")
    assert r.status_code == 404
