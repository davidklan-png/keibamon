# Keibamon

Keibamon is a local-first data and ML platform for Japanese horse-racing
research, backtesting, and race analysis.

The project is data-first. The app and API read curated analytical assets; data
ingestion, validation, feature generation, and model training live in the data
platform.

## Architecture

- `raw/bronze`: immutable source snapshots with source metadata.
- `normalized/silver`: canonical tables for races, entries, results, odds,
  body weight, travel, weather, news, and notes.
- `features/gold`: point-in-time feature rows keyed by race, horse, and
  `as_of_time`.
- `marts`: DuckDB-ready analyst views for research, backtesting, API, and UI.

Core tools:

- Parquet for durable local storage.
- DuckDB for analytical SQL.
- Polars for lazy feature engineering.
- Dagster for software-defined assets.
- Pandera for dataframe validation.
- MLflow for experiment and model lineage.
- FastAPI for the service layer.
- React and TypeScript for the analyzer UI.

## Repository Layout

```text
backend/                 FastAPI application
frontend/                React analyzer shell
src/keibamon_core/       Source adapters, schemas, feature builders, lake IO
src/keibamon_orchestration/ Dagster asset definitions
tests/                   Core invariants and feature tests
data/                    Local data lake, ignored except placeholders
docs/                    Design notes and operating docs
```

## Quick Start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## Local Ingestion Example

Import CSV source data (`races.csv`, `entries.csv`, and optionally
`results.csv`) into the local lake, either in code:

```python
from pathlib import Path

from keibamon_core.ingestion import import_csv_source
from keibamon_core.paths import DEFAULT_LAKE

report = import_csv_source(Path("tests/fixtures/csv"), DEFAULT_LAKE)
print(report.to_dict())
```

or through the API (`make api`, then):

```bash
curl -X POST http://127.0.0.1:8000/api/imports/csv \
  -H "Content-Type: application/json" \
  -d '{"path": "tests/fixtures/csv"}'

curl http://127.0.0.1:8000/api/races
curl http://127.0.0.1:8000/api/races/r-2026-0503-hanshin-11
```

One import runs the full pipeline: an immutable bronze snapshot with a content
hash manifest (`data/raw/csv/<snapshot_id>/`), silver Parquet tables
(`data/normalized/`), point-in-time validated gold features
(`data/features/`), and DuckDB-readable marts (`data/marts/`) served by the
API. The lake root defaults to `data/` and can be redirected with
`KEIBAMON_DATA_ROOT`; Dagster assets read the CSV source location from
`KEIBAMON_CSV_SOURCE_ROOT`.

## Odds Time-Series Capture

Odds are stored as point-in-time snapshots (`race_id`, `horse_number`,
odds, official `available_at`), never as a single value — the
announcement-to-post curve cannot be backfilled later. Capture for a race
day:

```bash
python3 -m keibamon_core.polling \
  --race-id r-2026-0614-hanshin-11 \
  --netkeiba-race-id 202609030411 \
  --post-time 2026-06-14T15:40:00+09:00
```

Each poll archives the raw payload to `data/raw/odds_netkeiba/` (bronze)
and appends deduplicated rows to `data/normalized/odds_snapshots.parquet`
(silver). Cadence tightens from 15 minutes to 1 minute approaching post
time and stops 10 minutes after. Historical odds can also be imported via
an optional `odds.csv` alongside `races.csv`. Gold features derive
`win_odds`, `win_odds_open`, and `win_odds_drift_pct` from snapshots
available before post time only, and `MarketBaselinePredictor` turns the
captured odds into the market baseline every model must beat. See
`examples/takarazuka_kinen_2026/` for a complete race-day runbook.

Polling is deliberately low-rate and single-endpoint; do not shorten the
intervals. JRA-VAN DataLab remains the licensed upgrade path for bulk
historical odds.

## Backtesting

After importing data, replay finished races walk-forward and score a
predictor against actual results:

```python
from keibamon_core.backtest import CareerWinRatePredictor, run_backtest
from keibamon_core.paths import DEFAULT_LAKE

report = run_backtest(DEFAULT_LAKE, CareerWinRatePredictor())
print(report.to_dict())
```

Rules of the harness:

- Predictors only ever see gold feature rows, and the engine re-asserts
  `available_at <= as_of_time` on every row before scoring. A violation
  aborts the run with `LeakageError` rather than producing a flattering
  result.
- Runs are deterministic and content-addressed: the `run_id` is derived from
  the predictor name plus the gold feature file hash, so re-running on
  unchanged data overwrites the same run instead of duplicating history.
- Per-race predictions land in `data/marts/backtest_predictions.parquet` and
  run summaries in `data/marts/backtest_runs.parquet`, both DuckDB-readable.
- Metrics are ranking quality only (win hit rate, top-3 rate, mean
  reciprocal rank). ROI metrics are intentionally deferred until odds are
  ingested as a point-in-time series.
- `CareerWinRatePredictor` is the baseline floor every model must beat;
  `UniformPredictor` is the no-signal sanity check.

The frontend can be run independently:

```bash
cd frontend
npm install
npm run dev
```

## Data Rules

- Raw source payloads are immutable.
- Every source record keeps `source_name`, `raw_uri`, `content_hash`,
  `ingested_at`, `published_time`, and `available_at`.
- ML features must satisfy `available_at <= prediction_as_of_time`.
- Subjective psychology or temperament signals must be stored as annotations
  with evidence and confidence. They are never treated as facts without
  provenance.
- Real-money betting automation is out of scope for v1.

