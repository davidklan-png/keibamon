from __future__ import annotations

from typing import Any

from keibamon_core.adapters.jravan import grade_label
from keibamon_core.ingestion.gold import GOLD_FEATURE_SET
from keibamon_core.lake import read_dataset, read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths

MART_RACES = "races"
MART_RACE_ENTRIES = "race_entries"


def _read_silver_any(lake: LakePaths, table: str) -> list[dict[str, Any]]:
    """Source-resolve a silver table, preferring the canonical ``jravan_*`` dataset.

    The live lake holds ``jravan_*`` tables (Hive-partitioned under
    ``normalized/jravan_<table>/year=.../venue=.../``), written by
    ``jravan_silver.build_jravan_silver``. The CSV-source path writes a single
    ``normalized/<table>.parquet`` (see ``ingestion/silver.py``). Prefer
    ``jravan_*`` when it is present and non-empty; fall back to the CSV table so
    the fixture-driven CSV tests stay green and a legacy lake still resolves.
    """
    jravan_dir = lake.silver_dataset(f"jravan_{table}")
    if jravan_dir.exists():
        rows = read_dataset(jravan_dir)
        if rows:
            return rows
    return read_parquet_if_exists(lake.silver_table(table))


def refresh_marts(lake: LakePaths) -> dict[str, int]:
    """Materialize DuckDB-readable mart Parquet files for API and UI reads.

    Marts are plain Parquet files under ``data/marts`` so they can be queried
    directly with DuckDB (``read_parquet``) or served by FastAPI.
    """
    races = _read_silver_any(lake, "races")
    # netkeiba race-header rows live in their own silver table (``netkeiba_races``)
    # so the JV-Link silver schema stays byte-identical (no extra columns). The
    # mart reads both, prefers JV-Link per race_id, and coalesces
    # ``netkeiba_race_id`` from the scrape table for the self-resolving track.
    nk_races = read_dataset(lake.silver_dataset("netkeiba_races"))
    entries = _read_silver_any(lake, "race_entries")
    results = _read_silver_any(lake, "race_results")
    features = read_parquet_if_exists(lake.gold_features(GOLD_FEATURE_SET))

    results_by_key = {(r["race_id"], r["horse_id"]): r for r in results}
    features_by_key = {(f["race_id"], f["horse_id"]): f for f in features}
    races_with_results = {r["race_id"] for r in results}

    field_sizes: dict[str, int] = {}
    for entry in entries:
        field_sizes[entry["race_id"]] = field_sizes.get(entry["race_id"], 0) + 1

    # Index netkeiba race rows by race_id for cross-source coalescing. The
    # netkeiba table may carry fields the JV-Link row cannot (notably
    # ``netkeiba_race_id``, which encodes kai/nichi and is not derivable from
    # the canonical id). The mart's preferred row for a race is the JV-Link row
    # when it exists (JV-Link is the authoritative oracle while it lasts); we
    # graft netkeiba-only fields onto it.
    nk_by_race: dict[str, dict[str, Any]] = {r["race_id"]: r for r in nk_races}
    # Also let a netkeiba-only race surface (pre-market scrape before any JV-Link
    # pull): merge them into the main races list with source_name tagged.
    jra_ids = {r["race_id"] for r in races}
    combined: list[dict[str, Any]] = list(races)
    combined.extend(r for r in nk_races if r["race_id"] not in jra_ids)

    # Dedupe by race_id, preferring non-netkeiba source rows when both exist.
    chosen: dict[str, dict[str, Any]] = {}
    for race in combined:
        rid = race["race_id"]
        src = race.get("source_name") or ""
        existing = chosen.get(rid)
        if existing is None:
            chosen[rid] = race
            continue
        # Replace only when the new row is authoritative (JV-Link) and the
        # existing one is netkeiba. Netkeiba never displaces JV-Link.
        if src != "netkeiba" and (existing.get("source_name") or "") == "netkeiba":
            chosen[rid] = race

    race_rows: list[dict[str, Any]] = []
    for race in sorted(chosen.values(), key=lambda r: (r["race_date"], r["race_id"])):
        # `.get` so either silver schema (jravan_* or CSV-source) maps without
        # KeyError. The jravan races mart shape carries every column below, but
        # this stays robust if a future source omits one.
        rid = race["race_id"]
        nk_row = nk_by_race.get(rid, {})
        race_rows.append(
            {
                "race_id": rid,
                "race_date": race.get("race_date"),
                "racecourse": race.get("racecourse"),
                "country": race.get("country"),
                "surface": race.get("surface"),
                "distance_m": race.get("distance_m"),
                "scheduled_post_time": race.get("scheduled_post_time"),
                "field_size": field_sizes.get(rid, 0),
                "results_available": rid in races_with_results,
                "source_name": race.get("source_name"),
                "content_hash": race.get("content_hash"),
                # Normalized grade label (G1/G2/G3/JG1/JG2/JG3/None). Derived
                # from grade_code via the spec-derived map (see
                # adapters.jravan.grade_label). None for non-graded/listed/unknown.
                # Both sources carry grade_code; JV-Link's wins when both exist.
                "grade": grade_label(race.get("grade_code")),
                # netkeiba's race id (encodes kai/nichi; not derivable from the
                # canonical id). Surfaced for the self-resolving track
                # (`track --grades`). NULL on JV-Link-only rows; coalesces from
                # the netkeiba_races silver table when one exists.
                "netkeiba_race_id": (
                    race.get("netkeiba_race_id") or nk_row.get("netkeiba_race_id")
                ),
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
