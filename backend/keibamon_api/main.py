from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from keibamon_core import __version__
from keibamon_core.ingestion import GOLD_FEATURE_SET, MART_RACE_ENTRIES, MART_RACES, import_csv_source
from keibamon_core.lake import read_parquet_if_exists
from keibamon_core.paths import LakePaths

app = FastAPI(title="Keibamon API", version=__version__)

NO_DATA_STATUS = "no_data_imported"


def get_lake() -> LakePaths:
    """Lake root is resolved per request so tests and deployments can redirect it."""
    return LakePaths(root=Path(os.environ.get("KEIBAMON_DATA_ROOT", "data")))


class CsvImportRequest(BaseModel):
    path: str


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.post("/api/imports/csv")
def import_csv(request: CsvImportRequest) -> dict[str, Any]:
    lake = get_lake()
    try:
        report = import_csv_source(Path(request.path), lake)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"Invalid CSV source data: {exc}") from exc
    return {"status": "imported", **report.to_dict()}


@app.get("/api/races")
def list_races() -> dict[str, Any]:
    lake = get_lake()
    mart_path = lake.mart(MART_RACES)
    if not mart_path.exists():
        return {
            "races": [],
            "status": NO_DATA_STATUS,
            "hint": "Import data first, e.g. POST /api/imports/csv {\"path\": \"<dir with races.csv>\"}",
        }
    races = read_parquet_if_exists(mart_path)
    return {"races": races, "status": "ok", "count": len(races)}


@app.get("/api/races/{race_id}")
def get_race(race_id: str) -> dict[str, Any]:
    lake = get_lake()
    races_path = lake.mart(MART_RACES)
    if not races_path.exists():
        raise HTTPException(
            status_code=404,
            detail={"status": NO_DATA_STATUS, "hint": "Import data first via POST /api/imports/csv"},
        )

    race = next((r for r in read_parquet_if_exists(races_path) if r["race_id"] == race_id), None)
    if race is None:
        raise HTTPException(status_code=404, detail=f"Race not found: {race_id}")

    entries = [
        e for e in read_parquet_if_exists(lake.mart(MART_RACE_ENTRIES)) if e["race_id"] == race_id
    ]
    features = [
        f
        for f in read_parquet_if_exists(lake.gold_features(GOLD_FEATURE_SET))
        if f["race_id"] == race_id
    ]

    return {
        "race": race,
        "entries": entries,
        "results_available": bool(race.get("results_available")),
        "features": features,
        "status": "ok",
    }


@app.post("/api/predictions")
def create_prediction() -> dict[str, str]:
    return {"status": "prediction_pipeline_not_materialized"}
