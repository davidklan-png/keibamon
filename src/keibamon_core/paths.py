from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LakePaths:
    """Deterministic locations for every lake layer.

    Layer naming follows the medallion convention used in the docs:
    raw == bronze, normalized == silver, features == gold.
    """

    root: Path = Path("data")

    @property
    def raw(self) -> Path:
        return self.root / "raw"

    @property
    def normalized(self) -> Path:
        return self.root / "normalized"

    @property
    def features(self) -> Path:
        return self.root / "features"

    @property
    def marts(self) -> Path:
        return self.root / "marts"

    @property
    def mlruns(self) -> Path:
        return self.root / "mlruns"

    # --- deterministic per-asset paths -------------------------------------

    def bronze_snapshot_dir(self, source_name: str, snapshot_id: str) -> Path:
        """Immutable raw snapshot directory for one source ingestion run."""
        return self.raw / source_name / snapshot_id

    def bronze_source_dir(self, source_name: str) -> Path:
        return self.raw / source_name

    def silver_table(self, table_name: str) -> Path:
        return self.normalized / f"{table_name}.parquet"

    def gold_features(self, feature_set: str) -> Path:
        return self.features / f"{feature_set}.parquet"

    def mart(self, mart_name: str) -> Path:
        return self.marts / f"{mart_name}.parquet"

    def ensure(self) -> None:
        for path in (self.raw, self.normalized, self.features, self.marts, self.mlruns):
            path.mkdir(parents=True, exist_ok=True)


DEFAULT_LAKE = LakePaths()
