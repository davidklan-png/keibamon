from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from keibamon_core.backtest.predictors import Predictor
from keibamon_core.features.point_in_time import LeakageError
from keibamon_core.ingestion.gold import GOLD_FEATURE_SET
from keibamon_core.ingestion.marts import MART_RACES
from keibamon_core.lake import hash_file, read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths

MART_BACKTEST_RUNS = "backtest_runs"
MART_BACKTEST_PREDICTIONS = "backtest_predictions"


@dataclass(frozen=True)
class BacktestReport:
    run_id: str
    predictor_name: str
    feature_set_hash: str
    executed_at: datetime
    races_evaluated: int
    races_skipped: int
    win_hit_rate: float | None
    top_pick_top3_rate: float | None
    mean_reciprocal_rank: float | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "predictor_name": self.predictor_name,
            "feature_set_hash": self.feature_set_hash,
            "executed_at": self.executed_at,
            "races_evaluated": self.races_evaluated,
            "races_skipped": self.races_skipped,
            "win_hit_rate": self.win_hit_rate,
            "top_pick_top3_rate": self.top_pick_top3_rate,
            "mean_reciprocal_rank": self.mean_reciprocal_rank,
        }


def rank_horses(scores: dict[str, float]) -> list[str]:
    """Rank horse ids by descending score with a deterministic tiebreak."""
    return [horse_id for horse_id, _ in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))]


def run_backtest(
    lake: LakePaths,
    predictor: Predictor,
    start: datetime | None = None,
    end: datetime | None = None,
) -> BacktestReport:
    """Walk finished races in chronological order and score the predictor.

    The walk-forward property is inherited from the gold layer: every
    feature row was built strictly from data available at the race's
    ``as_of_time``. The engine re-asserts that invariant before any row
    reaches a predictor and raises :class:`LeakageError` on violation, so a
    corrupted or hand-edited feature file can never produce a flattering
    backtest.

    Results (finish positions) are used only *after* scoring, as ground
    truth. ROI / odds-based metrics are deliberately absent until odds
    ingestion lands; current metrics are ranking quality only.
    """
    races = read_parquet_if_exists(lake.mart(MART_RACES))
    features = read_parquet_if_exists(lake.gold_features(GOLD_FEATURE_SET))
    results = read_parquet_if_exists(lake.silver_table("race_results"))

    features_by_race: dict[str, list[dict[str, Any]]] = {}
    for row in features:
        features_by_race.setdefault(row["race_id"], []).append(row)

    finish_by_race: dict[str, dict[str, int]] = {}
    for result in results:
        if result.get("finish_position") is not None:
            finish_by_race.setdefault(result["race_id"], {})[result["horse_id"]] = result[
                "finish_position"
            ]

    evaluated = 0
    skipped = 0
    win_hits = 0
    top3_hits = 0
    reciprocal_ranks: list[float] = []
    prediction_records: list[dict[str, Any]] = []

    feature_path = lake.gold_features(GOLD_FEATURE_SET)
    feature_set_hash = hash_file(feature_path) if feature_path.exists() else "missing"
    run_id = hashlib.sha256(f"{predictor.name}:{feature_set_hash}".encode("utf-8")).hexdigest()[:12]
    executed_at = datetime.now(timezone.utc)

    for race in sorted(races, key=lambda r: (r["race_date"], r["race_id"])):
        race_id = race["race_id"]
        as_of_time = _as_utc(race.get("scheduled_post_time") or race["race_date"])
        if start is not None and as_of_time < start:
            continue
        if end is not None and as_of_time > end:
            continue

        rows = features_by_race.get(race_id, [])
        finishes = finish_by_race.get(race_id, {})
        winner = next((h for h, pos in finishes.items() if pos == 1), None)
        if not race.get("results_available") or not rows or winner is None:
            skipped += 1
            continue

        _assert_no_leakage(race_id, as_of_time, rows)

        scores = predictor.score_race(race, sorted(rows, key=lambda r: r["horse_id"]))
        ranking = rank_horses(scores)
        predicted_rank = {horse_id: rank + 1 for rank, horse_id in enumerate(ranking)}

        top_pick = ranking[0]
        evaluated += 1
        win_hits += 1 if top_pick == winner else 0
        top3_hits += 1 if finishes.get(top_pick, 99) <= 3 else 0
        reciprocal_ranks.append(1.0 / predicted_rank[winner])

        for horse_id in ranking:
            prediction_records.append(
                {
                    "run_id": run_id,
                    "predictor_name": predictor.name,
                    "race_id": race_id,
                    "horse_id": horse_id,
                    "as_of_time": as_of_time,
                    "score": scores[horse_id],
                    "predicted_rank": predicted_rank[horse_id],
                    "finish_position": finishes.get(horse_id),
                    "won": finishes.get(horse_id) == 1,
                    "top3": finishes.get(horse_id, 99) <= 3,
                }
            )

    report = BacktestReport(
        run_id=run_id,
        predictor_name=predictor.name,
        feature_set_hash=feature_set_hash,
        executed_at=executed_at,
        races_evaluated=evaluated,
        races_skipped=skipped,
        win_hit_rate=round(win_hits / evaluated, 4) if evaluated else None,
        top_pick_top3_rate=round(top3_hits / evaluated, 4) if evaluated else None,
        mean_reciprocal_rank=(
            round(sum(reciprocal_ranks) / len(reciprocal_ranks), 4) if reciprocal_ranks else None
        ),
    )

    _persist_run(lake, report, prediction_records)
    return report


def _assert_no_leakage(race_id: str, as_of_time: datetime, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        row_as_of = _as_utc(row["as_of_time"])
        max_available = _as_utc(row["max_source_available_at"])
        if row_as_of > as_of_time or max_available > row_as_of:
            raise LeakageError(
                f"Backtest aborted: feature row {race_id}/{row['horse_id']} uses data "
                f"beyond as_of_time ({max_available} > {row_as_of} or {row_as_of} > {as_of_time})"
            )


def _persist_run(
    lake: LakePaths, report: BacktestReport, prediction_records: list[dict[str, Any]]
) -> None:
    """Upsert this run into the backtest marts (same run_id overwrites itself)."""
    runs = [
        r
        for r in read_parquet_if_exists(lake.mart(MART_BACKTEST_RUNS))
        if r["run_id"] != report.run_id
    ]
    runs.append(report.to_dict())
    runs.sort(key=lambda r: (r["executed_at"], r["run_id"]))
    write_parquet(runs, lake.mart(MART_BACKTEST_RUNS))

    predictions = [
        p
        for p in read_parquet_if_exists(lake.mart(MART_BACKTEST_PREDICTIONS))
        if p["run_id"] != report.run_id
    ]
    predictions.extend(prediction_records)
    predictions.sort(key=lambda p: (p["run_id"], p["race_id"], p["predicted_rank"]))
    write_parquet(predictions, lake.mart(MART_BACKTEST_PREDICTIONS))


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
