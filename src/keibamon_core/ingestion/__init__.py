"""Ingestion pipeline: CSV source -> bronze -> silver -> gold -> marts."""

from typing import TYPE_CHECKING

from keibamon_core.ingestion.gold import GOLD_FEATURE_SET, build_gold_features
from keibamon_core.ingestion.marts import MART_RACE_ENTRIES, MART_RACES, refresh_marts
from keibamon_core.ingestion.runner import ImportReport, import_csv_source
from keibamon_core.ingestion.silver import SILVER_TABLES, build_silver_tables
from keibamon_core.ingestion.snapshot import BronzeSnapshot, latest_csv_snapshot_dir, snapshot_csv_source

if TYPE_CHECKING:
    from keibamon_core.ingestion.curve_features import CURVE_FEATURE_SET, build_curve_features
    from keibamon_core.ingestion.going_features import GOING_FEATURE_SET, build_going_features
    from keibamon_core.ingestion.market_baseline import (
        MARKET_BASELINE_FEATURE_SET,
        build_market_probs,
    )
    from keibamon_core.ingestion.training_features import TRAINING_FEATURE_SET, build_training_features

__all__ = [
    "BronzeSnapshot",
    "CURVE_FEATURE_SET",
    "GOLD_FEATURE_SET",
    "GOING_FEATURE_SET",
    "MARKET_BASELINE_FEATURE_SET",
    "TRAINING_FEATURE_SET",
    "ImportReport",
    "MART_RACES",
    "MART_RACE_ENTRIES",
    "SILVER_TABLES",
    "build_gold_features",
    "build_curve_features",
    "build_going_features",
    "build_market_probs",
    "build_training_features",
    "build_silver_tables",
    "import_csv_source",
    "latest_csv_snapshot_dir",
    "refresh_marts",
    "snapshot_csv_source",
]


def __getattr__(name: str):
    if name in {"CURVE_FEATURE_SET", "build_curve_features"}:
        from keibamon_core.ingestion import curve_features

        return getattr(curve_features, name)
    if name in {"GOING_FEATURE_SET", "build_going_features"}:
        from keibamon_core.ingestion import going_features

        return getattr(going_features, name)
    if name in {"MARKET_BASELINE_FEATURE_SET", "build_market_probs"}:
        from keibamon_core.ingestion import market_baseline

        return getattr(market_baseline, name)
    if name in {"TRAINING_FEATURE_SET", "build_training_features"}:
        from keibamon_core.ingestion import training_features

        return getattr(training_features, name)
    raise AttributeError(name)
