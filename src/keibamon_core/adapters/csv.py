from __future__ import annotations

import csv
import hashlib
from datetime import datetime, timezone

UTC = timezone.utc
from pathlib import Path
from typing import Iterable

from keibamon_core.adapters.base import SourceAdapter
from keibamon_core.schemas import Race, RaceEntry, RaceResult, SourceMetadata


class CsvSourceAdapter(SourceAdapter):
    """CSV adapter for the guaranteed local ingestion path.

    Expected files:
    - races.csv
    - entries.csv
    - results.csv
    """

    source_name = "csv"

    def __init__(self, root: Path):
        self.root = root

    def list_races(self, start: datetime, end: datetime, venue: str | None = None) -> Iterable[str]:
        for row in self._read_csv("races.csv"):
            race_time = datetime.fromisoformat(row["race_date"])
            if start <= race_time <= end and (venue is None or row["racecourse"] == venue):
                yield row["race_id"]

    def fetch_race_card(self, race_id: str) -> tuple[Race, list[RaceEntry]]:
        race_row = next(row for row in self._read_csv("races.csv") if row["race_id"] == race_id)
        race_meta = self._metadata("races.csv", race_id, race_row.get("available_at"))
        race = Race(
            race_id=race_row["race_id"],
            race_date=datetime.fromisoformat(race_row["race_date"]),
            racecourse=race_row["racecourse"],
            country=race_row.get("country", "JP"),
            surface=race_row.get("surface", "unknown"),  # type: ignore[arg-type]
            distance_m=int(race_row["distance_m"]),
            scheduled_post_time=self._parse_optional_time(race_row.get("scheduled_post_time")),
            metadata=race_meta,
        )

        entries = []
        for row in self._read_csv("entries.csv"):
            if row["race_id"] != race_id:
                continue
            entries.append(
                RaceEntry(
                    race_id=row["race_id"],
                    horse_id=row["horse_id"],
                    horse_name=row["horse_name"],
                    jockey_id=row.get("jockey_id") or None,
                    trainer_id=row.get("trainer_id") or None,
                    gate=self._parse_optional_int(row.get("gate")),
                    carried_weight_kg=self._parse_optional_float(row.get("carried_weight_kg")),
                    horse_number=self._parse_optional_int(row.get("horse_number")),
                    metadata=self._metadata("entries.csv", f"{race_id}:{row['horse_id']}", row.get("available_at")),
                )
            )

        return race, entries

    def fetch_result(self, race_id: str) -> list[RaceResult]:
        results = []
        for row in self._read_csv("results.csv"):
            if row["race_id"] != race_id:
                continue
            results.append(
                RaceResult(
                    race_id=row["race_id"],
                    horse_id=row["horse_id"],
                    finish_position=self._parse_optional_int(row.get("finish_position")),
                    finish_time_seconds=self._parse_optional_float(row.get("finish_time_seconds")),
                    margin=row.get("margin") or None,
                    metadata=self._metadata("results.csv", f"{race_id}:{row['horse_id']}", row.get("available_at")),
                )
            )
        return results

    def _read_csv(self, filename: str) -> list[dict[str, str]]:
        path = self.root / filename
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))

    def _metadata(self, filename: str, record_id: str, available_at: str | None) -> SourceMetadata:
        path = self.root / filename
        content = path.read_bytes()
        timestamp = self._parse_optional_time(available_at) or datetime.now(UTC)
        return SourceMetadata(
            source_name=self.source_name,
            source_record_id=record_id,
            raw_uri=str(path),
            content_hash=hashlib.sha256(content).hexdigest(),
            ingested_at=datetime.now(UTC),
            published_time=timestamp,
            available_at=timestamp,
        )

    @staticmethod
    def _parse_optional_time(value: str | None) -> datetime | None:
        if not value:
            return None
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    @staticmethod
    def _parse_optional_int(value: str | None) -> int | None:
        return int(value) if value not in (None, "") else None

    @staticmethod
    def _parse_optional_float(value: str | None) -> float | None:
        return float(value) if value not in (None, "") else None

