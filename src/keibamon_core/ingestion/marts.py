from __future__ import annotations

from typing import Any

from keibamon_core.ingestion.gold import GOLD_FEATURE_SET
from keibamon_core.lake import read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths

MART_RACES = "races"
MART_RACE_ENTRIES = "race_entries"


def refresh_marts(lake: LakePaths) -> dict[str, int]:
    """Materialize DuckDB-readable mart Parquet files for API and UI reads.

    Marts are plain Parquet files under ``data/marts`` so they can be queried
    directly with DuckDB (``read_parquet``) or served by FastAPI.
    """
    races = read_parquet_if_exists(lake.silver_table("races"))
    entries = read_parquet_if_exists(lake.silver_table("race_entries"))
    results = read_parquet_if_exists(lake.silver_table("race_results"))
    features = read_parquet_if_exists(lake.gold_features(GOLD_FEATURE_SET))

    results_by_key = {(r["race_id"], r["horse_id"]): r for r in results}
    features_by_key = {(f["race_id"], f["horse_id"]): f for f in features}
    races_with_results = {r["race_id"] for r in results}

    field_sizes: dict[str, int] = {}
    for entry in entries:
        field_sizes[entry["race_id"]] = field_sizes.get(entry["race_id"], 0) + 1

    race_rows: list[dict[str, Any]] = []
    for race in sorted(races, key=lambda r: (r["race_date"], r["race_id"])):
        race_rows.append(
            {
                "race_id": race["race_id"],
                "race_date": race["race_date"],
                "racecourse": race["racecourse"],
                "country": race["country"],
                "surface": race["surface"],
                "distance_m": race["distance_m"],
                "scheduled_post_time": race.get("scheduled_post_time"),
                "field_size": field_sizes.get(race["race_id"], 0),
                "results_available": race["race_id"] in races_with_results,
                "source_name": race["source_name"],
                "content_hash": race["content_hash"],
            }
        )

    entry_rows: list[dict[str, Any]] = []
    for entry in sorted(entries, key=lambda e: (e["race_id"], e["horse_id"])):
        key = (entry["race_id"], entry["horse_id"])
        result = results_by_key.get(key, {})
        feature = features_by_key.get(key, {})
        entry_rows.append(
            {
                "race_id": entry["race_id"],
                "horse_id": entry["horse_id"],
                "horse_number": entry.get("horse_number"),
                "horse_name": entry["horse_name"],
                "jockey_id": entry.get("jockey_id"),
                "trainer_id": entry.get("trainer_id"),
                "gate": entry.get("gate"),
                "carried_weight_kg": entry.get("carried_weight_kg"),
                "win_odds": feature.get("win_odds"),
                "win_odds_popularity": feature.get("win_odds_popularity"),
                "win_odds_drift_pct": feature.get("win_odds_drift_pct"),
                "finish_position": result.get("finish_position"),
                "finish_time_seconds": result.get("finish_time_seconds"),
                "margin": result.get("margin"),
                "career_starts": feature.get("career_starts"),
                "career_wins": feature.get("career_wins"),
                "career_top3": feature.get("career_top3"),
                "career_win_rate": feature.get("career_win_rate"),
                "career_top3_rate": feature.get("career_top3_rate"),
                "feature_as_of_time": feature.get("as_of_time"),
            }
        )

    write_parquet(race_rows, lake.mart(MART_RACES))
    write_parquet(entry_rows, lake.mart(MART_RACE_ENTRIES))

    return {MART_RACES: len(race_rows), MART_RACE_ENTRIES: len(entry_rows)}
