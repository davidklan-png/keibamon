from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("pyarrow", reason="pyarrow is required for API data tests")
pytest.importorskip("fastapi", reason="fastapi is required for API tests")
pytest.importorskip("httpx", reason="httpx is required for fastapi TestClient")

from fastapi.testclient import TestClient

from keibamon_api.main import app

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "csv"

RACE_1 = "r-2026-0503-hanshin-11"
RACE_2 = "r-2026-0607-tokyo-10"


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("KEIBAMON_DATA_ROOT", str(tmp_path / "data"))
    return TestClient(app)


def _import_fixture(client: TestClient) -> dict:
    response = client.post("/api/imports/csv", json={"path": str(FIXTURE_CSV)})
    assert response.status_code == 200, response.text
    return response.json()


def test_races_empty_state_before_import(client: TestClient) -> None:
    response = client.get("/api/races")
    assert response.status_code == 200
    body = response.json()
    assert body["races"] == []
    assert body["status"] == "no_data_imported"

    detail = client.get(f"/api/races/{RACE_1}")
    assert detail.status_code == 404


def test_import_csv_endpoint_and_list_races(client: TestClient) -> None:
    report = _import_fixture(client)
    assert report["status"] == "imported"
    assert report["gold_feature_rows"] == 5

    response = client.get("/api/races")
    body = response.json()
    assert body["status"] == "ok"
    assert body["count"] == 2
    race_ids = [race["race_id"] for race in body["races"]]
    assert race_ids == [RACE_1, RACE_2]  # sorted by race_date


def test_race_detail_returns_entries_results_and_features(client: TestClient) -> None:
    _import_fixture(client)

    finished = client.get(f"/api/races/{RACE_1}").json()
    assert finished["race"]["race_id"] == RACE_1
    assert finished["results_available"] is True
    assert len(finished["entries"]) == 2
    winner = next(e for e in finished["entries"] if e["horse_id"] == "h-001")
    assert winner["finish_position"] == 1
    assert len(finished["features"]) == 2

    upcoming = client.get(f"/api/races/{RACE_2}").json()
    assert upcoming["results_available"] is False
    assert len(upcoming["entries"]) == 3
    assert all(e["finish_position"] is None for e in upcoming["entries"])


def test_race_detail_unknown_race_is_404(client: TestClient) -> None:
    _import_fixture(client)
    response = client.get("/api/races/r-does-not-exist")
    assert response.status_code == 404


def test_import_csv_endpoint_missing_path_is_404(client: TestClient) -> None:
    response = client.post("/api/imports/csv", json={"path": "/path/does/not/exist"})
    assert response.status_code == 404
