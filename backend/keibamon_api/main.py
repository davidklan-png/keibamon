from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from keibamon_core import __version__
from keibamon_core.ingestion import GOLD_FEATURE_SET, MART_RACE_ENTRIES, MART_RACES, import_csv_source
from keibamon_core.lake import read_parquet_if_exists
from keibamon_core.lake_query import query as lake_query
from keibamon_core.marts import (
    HORSE_FORM_MART,
    JOCKEY_FORM_MART,
    build_horse_card,
    build_jockey_card,
    normalize_name,
)
from keibamon_core.paths import LakePaths

_JST = ZoneInfo("Asia/Tokyo")

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


# ---------------------------------------------------------------------------
# Milestone 4 lookup -- horse + jockey form/context panels.
#
# Recreational context to shape intuition, NOT a tip or edge claim (see
# app_plan.md Guardrails). Reads the pre-built form marts via lake_query with a
# strict point-in-time filter (``available_at < as_of``) so the target race and
# anything after it are excluded. Missing mart / unknown entity -> a graceful
# ``no_history`` body, never 500.
# ---------------------------------------------------------------------------


def _parse_as_of(raw: str | None) -> datetime:
    """Tolerant as_of -> a UTC datetime anchoring the PIT filter.

    Accepts an ISO timestamp (with or without offset; naive assumed JST, this
    being a JRA app), a date (``YYYY-MM-DD`` / ``YYYYMMDD``, taken as JST
    midnight), or empty/None (-> now UTC). Unparseable -> now UTC. Never raises.
    """
    if not raw:
        return datetime.now(timezone.utc)
    text = raw.strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        # compact date form like 20260628
        digits = "".join(ch for ch in text if ch.isdigit())
        if len(digits) >= 8:
            try:
                dt = datetime(int(digits[0:4]), int(digits[4:6]), int(digits[6:8]))
            except ValueError:
                return datetime.now(timezone.utc)
        else:
            return datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_JST)
    return dt.astimezone(timezone.utc)


def _pit_rows(mart_name: str, where: str, params: list[Any], lake: LakePaths) -> list[dict[str, Any]]:
    """Read a form mart PIT-filtered + newest-first. Empty list if no mart."""
    path = lake.mart(mart_name)
    if not path.exists():
        return []
    sql = f"SELECT * FROM {{m}} WHERE {where} ORDER BY available_at DESC"
    table = lake_query(sql, params=params, m=path)
    return table.to_pylist()


@app.get("/api/horses/{name}/form")
def horse_form(name: str, as_of: str | None = None) -> dict[str, Any]:
    lake = get_lake()
    when = _parse_as_of(as_of)
    key = normalize_name(name)
    if key is None:
        return {"status": "no_history", "horse_name": name, "as_of": as_of}
    rows = _pit_rows(
        HORSE_FORM_MART, "horse_name_key = ? AND available_at < ?", [key, when], lake
    )
    return build_horse_card(rows, horse_name=name, as_of=as_of)


@app.get("/api/jockeys/{jockey_id}/form")
def jockey_form(jockey_id: str, as_of: str | None = None) -> dict[str, Any]:
    lake = get_lake()
    when = _parse_as_of(as_of)
    rows = _pit_rows(
        JOCKEY_FORM_MART, "jockey_id = ? AND available_at < ?", [jockey_id, when], lake
    )
    return build_jockey_card(rows, jockey_id=jockey_id, as_of=as_of)


@app.get("/api/races/{race_id}/form")
def race_form(race_id: str, as_of: str | None = None) -> dict[str, Any]:
    """Batch: form for every runner in a race, one request.

    Runners come from the race's entries (de-duplicated, JV-Link preferred). The
    PIT anchor is the race's own ``scheduled_post_time`` (so each runner's form
    excludes this race) unless ``as_of`` is passed explicitly.
    """
    lake = get_lake()
    entries_ds = lake.silver_dataset("jravan_race_entries")
    if not entries_ds.exists():
        return {"race_id": race_id, "status": "no_data_imported", "runners": []}

    when = _parse_as_of(as_of)
    if as_of is None:
        # Anchor on this race's post time when available.
        races_ds = lake.silver_dataset("jravan_races")
        if races_ds.exists():
            rt = lake_query(
                "SELECT scheduled_post_time FROM {r} WHERE race_id = ?",
                params=[race_id], r=races_ds,
            ).to_pylist()
            if rt and rt[0].get("scheduled_post_time"):
                when = rt[0]["scheduled_post_time"].astimezone(timezone.utc)

    runners = lake_query(
        "SELECT DISTINCT ON (horse_number) horse_number, horse_name "
        "FROM {e} WHERE race_id = ? "
        "ORDER BY horse_number, CASE source_name WHEN 'jravan' THEN 0 ELSE 1 END",
        params=[race_id], e=entries_ds,
    ).to_pylist()
    if not runners:
        raise HTTPException(status_code=404, detail=f"Race not found: {race_id}")

    cards = []
    for rn in runners:
        nm = rn.get("horse_name")
        key = normalize_name(nm)
        rows = (
            _pit_rows(
                HORSE_FORM_MART,
                "horse_name_key = ? AND available_at < ?",
                [key, when],
                lake,
            )
            if key
            else []
        )
        cards.append(
            {
                "horse_number": rn.get("horse_number"),
                "horse_name": nm,
                "form": build_horse_card(rows, horse_name=nm, as_of=as_of),
            }
        )
    return {"race_id": race_id, "as_of": as_of, "runners": cards}
