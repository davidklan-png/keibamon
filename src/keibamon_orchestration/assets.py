from __future__ import annotations

import os
from pathlib import Path

from keibamon_core.ingestion import (
    GOLD_FEATURE_SET,
    build_gold_features,
    build_silver_tables,
    refresh_marts,
    snapshot_csv_source,
)
from keibamon_core.paths import LakePaths

try:
    from dagster import Definitions, asset
except ImportError:  # pragma: no cover - allows lightweight test environments
    Definitions = None

    def asset(fn=None, **_kwargs):
        def decorate(inner):
            return inner

        return decorate(fn) if fn else decorate


def _lake() -> LakePaths:
    return LakePaths(root=Path(os.environ.get("KEIBAMON_DATA_ROOT", "data")))


def _csv_source_root() -> Path:
    return Path(os.environ.get("KEIBAMON_CSV_SOURCE_ROOT", "data/sources/csv"))


@asset
def bronze_source_snapshots() -> str:
    """Snapshot the configured local CSV source into immutable bronze storage."""
    lake = _lake()
    lake.ensure()
    snapshot = snapshot_csv_source(_csv_source_root(), lake)
    return f"bronze snapshot {snapshot.snapshot_id} at {snapshot.directory}"


@asset(deps=[bronze_source_snapshots])
def silver_canonical_tables() -> str:
    """Normalize the latest bronze snapshot into silver Parquet tables."""
    counts = build_silver_tables(_lake())
    return f"silver tables built: {counts}"


@asset(deps=[silver_canonical_tables])
def gold_point_in_time_features() -> str:
    """Build point-in-time validated gold feature rows."""
    rows = build_gold_features(_lake())
    return f"gold feature set '{GOLD_FEATURE_SET}' built with {rows} rows"


@asset(deps=[gold_point_in_time_features])
def analytical_marts() -> str:
    """Refresh DuckDB-readable mart Parquet files for API and UI reads."""
    counts = refresh_marts(_lake())
    return f"marts refreshed: {counts}"


@asset(deps=[analytical_marts])
def model_training_dataset() -> str:
    """Placeholder: training dataset assembly with feature-set hash lineage."""
    return "model training dataset with feature-set hash (not yet materialized)"


if Definitions is not None:
    defs = Definitions(
        assets=[
            bronze_source_snapshots,
            silver_canonical_tables,
            gold_point_in_time_features,
            analytical_marts,
            model_training_dataset,
        ]
    )
else:
    defs = None
