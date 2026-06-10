from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from keibamon_core.adapters.csv import CsvSourceAdapter
from keibamon_core.ingestion.odds import append_odds_snapshots, load_odds_csv
from keibamon_core.ingestion.snapshot import latest_csv_snapshot_dir
from keibamon_core.lake import write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.schemas import Race, RaceEntry, RaceResult, SourceMetadata

SILVER_TABLES = ("races", "race_entries", "race_results")

_ALL_TIME_START = datetime(1900, 1, 1, tzinfo=timezone.utc)
_ALL_TIME_END = datetime(2999, 12, 31, tzinfo=timezone.utc)


def build_silver_tables(lake: LakePaths, snapshot_dir: Path | None = None) -> dict[str, int]:
    """Normalize the latest bronze CSV snapshot into silver Parquet tables."""
    if snapshot_dir is None:
        snapshot_dir = latest_csv_snapshot_dir(lake)
    if snapshot_dir is None:
        raise FileNotFoundError(
            "No bronze CSV snapshot found. Run snapshot_csv_source / import a CSV source first."
        )

    adapter = CsvSourceAdapter(snapshot_dir)
    has_results = (snapshot_dir / "results.csv").is_file()

    race_records: list[dict[str, Any]] = []
    entry_records: list[dict[str, Any]] = []
    result_records: list[dict[str, Any]] = []

    for race_id in sorted(set(adapter.list_races(_ALL_TIME_START, _ALL_TIME_END))):
        race, entries = adapter.fetch_race_card(race_id)
        race_records.append(_race_record(race))
        entry_records.extend(_entry_record(entry) for entry in entries)
        if has_results:
            result_records.extend(_result_record(result) for result in adapter.fetch_result(race_id))

    race_records.sort(key=lambda r: (r["race_date"], r["race_id"]))
    entry_records.sort(key=lambda r: (r["race_id"], r["horse_id"]))
    result_records.sort(key=lambda r: (r["race_id"], r["horse_id"]))

    write_parquet(race_records, lake.silver_table("races"))
    write_parquet(entry_records, lake.silver_table("race_entries"))
    write_parquet(result_records, lake.silver_table("race_results"))

    # Odds are an accumulating time series: merged via append+dedupe so a CSV
    # import never clobbers snapshots collected by the live poller.
    odds_added = 0
    odds_path = snapshot_dir / "odds.csv"
    if odds_path.is_file():
        odds_added = append_odds_snapshots(lake, load_odds_csv(odds_path))

    return {
        "races": len(race_records),
        "race_entries": len(entry_records),
        "race_results": len(result_records),
        "odds_snapshots": odds_added,
    }


def _ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _metadata_columns(metadata: SourceMetadata) -> dict[str, Any]:
    return {
        "source_name": metadata.source_name,
        "source_record_id": metadata.source_record_id,
        "raw_uri": metadata.raw_uri,
        "content_hash": metadata.content_hash,
        "ingested_at": _ensure_utc(metadata.ingested_at),
        "published_time": _ensure_utc(metadata.published_time),
        "available_at": _ensure_utc(metadata.available_at),
    }


def _race_record(race: Race) -> dict[str, Any]:
    return {
        "race_id": race.race_id,
        "race_date": _ensure_utc(race.race_date),
        "racecourse": race.racecourse,
        "country": race.country,
        "surface": race.surface,
        "distance_m": race.distance_m,
        "scheduled_post_time": _ensure_utc(race.scheduled_post_time),
        **_metadata_columns(race.metadata),
    }


def _entry_record(entry: RaceEntry) -> dict[str, Any]:
    return {
        "race_id": entry.race_id,
        "horse_id": entry.horse_id,
        "horse_number": entry.horse_number,
        "horse_name": entry.horse_name,
        "jockey_id": entry.jockey_id,
        "trainer_id": entry.trainer_id,
        "gate": entry.gate,
        "carried_weight_kg": entry.carried_weight_kg,
        **_metadata_columns(entry.metadata),
    }


def _result_record(result: RaceResult) -> dict[str, Any]:
    return {
        "race_id": result.race_id,
        "horse_id": result.horse_id,
        "finish_position": result.finish_position,
        "finish_time_seconds": result.finish_time_seconds,
        "margin": result.margin,
        **_metadata_columns(result.metadata),
    }
