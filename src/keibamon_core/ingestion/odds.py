from __future__ import annotations

import csv
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from keibamon_core.lake import read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths

ODDS_TABLE = "odds_snapshots"

ODDS_COLUMNS = (
    "race_id",
    "horse_number",
    "win_odds",
    "place_odds_low",
    "place_odds_high",
    "popularity",
    "status",
    "captured_at",
    "available_at",
    "source_name",
    "raw_uri",
    "content_hash",
    "ingested_at",
)


def append_odds_snapshots(lake: LakePaths, records: list[dict[str, Any]]) -> int:
    """Append odds snapshots to the silver time series, deduplicated.

    Odds are an accumulating time series, never overwritten. The dedupe key
    is ``(race_id, horse_number, available_at)`` — the official source
    timestamp — so polling faster than the source updates is harmless and
    re-imports are idempotent. Returns the number of newly added rows.
    """
    existing = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    seen = {_dedupe_key(row) for row in existing}

    added = 0
    for record in records:
        key = _dedupe_key(record)
        if key in seen:
            continue
        seen.add(key)
        existing.append(record)
        added += 1

    if added:
        existing.sort(key=lambda r: (r["race_id"], r["horse_number"], _as_utc(r["available_at"])))
        write_parquet(existing, lake.silver_table(ODDS_TABLE))
    return added


def load_odds_csv(path: Path) -> list[dict[str, Any]]:
    """Parse an odds.csv file into silver-shaped odds snapshot records.

    Expected columns: race_id, horse_number, win_odds, place_odds_low,
    place_odds_high, popularity, status, captured_at, available_at.
    """
    content = path.read_bytes()
    content_hash = hashlib.sha256(content).hexdigest()
    ingested_at = datetime.now(timezone.utc)

    records: list[dict[str, Any]] = []
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            available_at = _parse_time(row["available_at"])
            records.append(
                {
                    "race_id": row["race_id"],
                    "horse_number": int(row["horse_number"]),
                    "win_odds": _opt_float(row.get("win_odds")),
                    "place_odds_low": _opt_float(row.get("place_odds_low")),
                    "place_odds_high": _opt_float(row.get("place_odds_high")),
                    "popularity": _opt_int(row.get("popularity")),
                    "status": row.get("status") or "unknown",
                    "captured_at": _parse_time(row.get("captured_at")) or available_at,
                    "available_at": available_at,
                    "source_name": "csv",
                    "raw_uri": str(path),
                    "content_hash": content_hash,
                    "ingested_at": ingested_at,
                }
            )
    return records


def _dedupe_key(record: dict[str, Any]) -> tuple[str, int, datetime]:
    return (record["race_id"], record["horse_number"], _as_utc(record["available_at"]))


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _opt_float(value: str | None) -> float | None:
    return float(value) if value not in (None, "") else None


def _opt_int(value: str | None) -> int | None:
    return int(value) if value not in (None, "") else None
