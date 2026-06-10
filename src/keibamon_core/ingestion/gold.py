from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from keibamon_core.features.dataset import validate_feature_rows
from keibamon_core.features.point_in_time import is_available
from keibamon_core.ingestion.odds import ODDS_TABLE
from keibamon_core.lake import read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.schemas import FeatureRow

GOLD_FEATURE_SET = "race_horse_features"


def build_gold_features(lake: LakePaths) -> int:
    """Build initial point-in-time feature rows from silver tables.

    Every row is validated so that no source record with
    ``available_at > as_of_time`` can leak into the features.
    """
    races = {r["race_id"]: r for r in read_parquet_if_exists(lake.silver_table("races"))}
    entries = read_parquet_if_exists(lake.silver_table("race_entries"))
    results = read_parquet_if_exists(lake.silver_table("race_results"))
    odds = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))

    results_by_horse: dict[str, list[dict[str, Any]]] = {}
    for result in results:
        results_by_horse.setdefault(result["horse_id"], []).append(result)

    odds_by_runner: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for snapshot in odds:
        odds_by_runner.setdefault((snapshot["race_id"], snapshot["horse_number"]), []).append(
            snapshot
        )

    field_sizes: dict[str, int] = {}
    for entry in entries:
        field_sizes[entry["race_id"]] = field_sizes.get(entry["race_id"], 0) + 1

    rows: list[FeatureRow] = []
    records: list[dict[str, Any]] = []

    for entry in sorted(entries, key=lambda e: (e["race_id"], e["horse_id"])):
        race = races.get(entry["race_id"])
        if race is None:
            continue

        as_of_time = _as_utc(race.get("scheduled_post_time") or race["race_date"])
        source_available_ats = [_as_utc(race["available_at"]), _as_utc(entry["available_at"])]

        career = _career_stats(
            results_by_horse.get(entry["horse_id"], []),
            current_race_id=entry["race_id"],
            as_of_time=as_of_time,
            source_available_ats=source_available_ats,
        )

        market = _odds_features(
            odds_by_runner.get((entry["race_id"], entry.get("horse_number") or -1), []),
            as_of_time=as_of_time,
            source_available_ats=source_available_ats,
        )

        features: dict[str, float | int | str | bool | None] = {
            "gate": entry.get("gate"),
            "horse_number": entry.get("horse_number"),
            "carried_weight_kg": entry.get("carried_weight_kg"),
            "distance_m": race.get("distance_m"),
            "surface": race.get("surface"),
            "field_size": field_sizes.get(entry["race_id"], 0),
            **career,
            **market,
        }

        rows.append(
            FeatureRow(
                race_id=entry["race_id"],
                horse_id=entry["horse_id"],
                as_of_time=as_of_time,
                features=features,
                source_available_ats=tuple(source_available_ats),
            )
        )
        records.append(
            {
                "race_id": entry["race_id"],
                "horse_id": entry["horse_id"],
                "as_of_time": as_of_time,
                "max_source_available_at": max(source_available_ats),
                **features,
            }
        )

    # Hard gate: refuse to persist anything that uses future information.
    validate_feature_rows(rows)

    write_parquet(records, lake.gold_features(GOLD_FEATURE_SET))
    return len(records)


def _career_stats(
    horse_results: list[dict[str, Any]],
    current_race_id: str,
    as_of_time: datetime,
    source_available_ats: list[datetime],
) -> dict[str, float | int | None]:
    """Aggregate prior results that were available strictly at or before as_of_time.

    Results from the current race, and any result whose ``available_at`` is in
    the future relative to ``as_of_time``, are excluded.
    """
    starts = wins = top3 = 0
    for result in horse_results:
        if result["race_id"] == current_race_id:
            continue
        available_at = _as_utc(result["available_at"])
        if not is_available(available_at, as_of_time):
            continue
        source_available_ats.append(available_at)
        starts += 1
        position = result.get("finish_position")
        if position is not None:
            wins += 1 if position == 1 else 0
            top3 += 1 if position <= 3 else 0

    return {
        "career_starts": starts,
        "career_wins": wins,
        "career_top3": top3,
        "career_win_rate": round(wins / starts, 4) if starts else None,
        "career_top3_rate": round(top3 / starts, 4) if starts else None,
    }


def _odds_features(
    snapshots: list[dict[str, Any]],
    as_of_time: datetime,
    source_available_ats: list[datetime],
) -> dict[str, float | int | None]:
    """Market features from odds snapshots available at or before as_of_time.

    Uses the earliest and latest available snapshots: ``win_odds`` is the
    last price you could actually have seen before post time, ``win_odds_open``
    the first announced price, and ``win_odds_drift_pct`` the move between
    them (negative = money came for this horse). Snapshots published after
    ``as_of_time`` are excluded, exactly like every other source.
    """
    usable = sorted(
        (s for s in snapshots if is_available(_as_utc(s["available_at"]), as_of_time)),
        key=lambda s: _as_utc(s["available_at"]),
    )
    if not usable:
        return {
            "win_odds": None,
            "win_odds_popularity": None,
            "win_odds_open": None,
            "win_odds_drift_pct": None,
        }

    first, last = usable[0], usable[-1]
    source_available_ats.append(_as_utc(first["available_at"]))
    if last is not first:
        source_available_ats.append(_as_utc(last["available_at"]))

    drift = None
    if first.get("win_odds") and last.get("win_odds"):
        drift = round((last["win_odds"] - first["win_odds"]) / first["win_odds"] * 100, 2)

    return {
        "win_odds": last.get("win_odds"),
        "win_odds_popularity": last.get("popularity"),
        "win_odds_open": first.get("win_odds"),
        "win_odds_drift_pct": drift,
    }


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
