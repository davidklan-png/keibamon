from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from keibamon_core.ingestion.gold import build_gold_features
from keibamon_core.ingestion.marts import refresh_marts
from keibamon_core.ingestion.silver import build_silver_tables
from keibamon_core.ingestion.snapshot import snapshot_csv_source
from keibamon_core.paths import LakePaths


@dataclass(frozen=True)
class ImportReport:
    snapshot_id: str
    bronze_dir: str
    silver_counts: dict[str, int]
    gold_feature_rows: int
    mart_counts: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "snapshot_id": self.snapshot_id,
            "bronze_dir": self.bronze_dir,
            "silver_counts": self.silver_counts,
            "gold_feature_rows": self.gold_feature_rows,
            "mart_counts": self.mart_counts,
        }


def import_csv_source(csv_root: Path, lake: LakePaths) -> ImportReport:
    """End-to-end local CSV import: bronze -> silver -> gold -> marts."""
    lake.ensure()
    snapshot = snapshot_csv_source(csv_root, lake)
    silver_counts = build_silver_tables(lake, snapshot.directory)
    gold_rows = build_gold_features(lake)
    mart_counts = refresh_marts(lake)
    return ImportReport(
        snapshot_id=snapshot.snapshot_id,
        bronze_dir=str(snapshot.directory),
        silver_counts=silver_counts,
        gold_feature_rows=gold_rows,
        mart_counts=mart_counts,
    )
