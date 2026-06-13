"""Validate going-handling features on off-going races.

The report is intentionally market-first: a going feature is only useful if it
adds out-of-sample signal beyond the win market and the raw going code.
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion.going_features import GOING_FEATURE_SET
from keibamon_core.paths import LakePaths


@dataclass(frozen=True)
class ValidationResult:
    races: int
    runners: int
    baseline_log_loss: float
    enhanced_log_loss: float
    bucket_stakes: int
    bucket_roi: float
    bucket_hit_rate: float


def main() -> None:
    lake = LakePaths()
    if not lake.gold_dataset(GOING_FEATURE_SET).exists():
        print("No going_handling gold dataset found. Run build_going_features(lake) first.")
        return

    rows = _load_rows(lake)
    if len({r["race_id"] for r in rows}) < 20:
        print(
            "Insufficient off-going validation sample: "
            f"{len({r['race_id'] for r in rows})} races / {len(rows)} runners. "
            "Need enough races for era-aware train/test splits."
        )
        return

    result = validate(rows)
    print("Going-handling validation on off-going races")
    print(f"Races: {result.races:,} | runners: {result.runners:,}")
    print(f"Baseline log-loss (market + raw going): {result.baseline_log_loss:.5f}")
    print(f"Enhanced log-loss (+ going_fit_z/disagreement): {result.enhanced_log_loss:.5f}")
    print(f"Delta: {result.enhanced_log_loss - result.baseline_log_loss:+.5f}")
    print(
        "Top disagreement bucket: "
        f"stakes={result.bucket_stakes:,}, ROI={result.bucket_roi:.3f}, "
        f"hit_rate={result.bucket_hit_rate:.3f}"
    )


def validate(rows: list[dict]) -> ValidationResult:
    import numpy as np
    import pandas as pd
    from sklearn.linear_model import LogisticRegression

    df = pd.DataFrame(rows).copy()
    df["era"] = np.where(df["year"] >= 2023, "modern_dense", "historical_sparse")
    test_races: set[str] = set()
    for _, era_df in df[["race_id", "race_date", "era"]].drop_duplicates().groupby("era"):
        ordered = era_df.sort_values(["race_date", "race_id"])
        cut = max(1, int(math.floor(len(ordered) * 0.7)))
        test_races.update(ordered.iloc[cut:]["race_id"])
    df["is_test"] = df["race_id"].isin(test_races)
    train = df[~df["is_test"]]
    test = df[df["is_test"]]
    if train["winner"].nunique() < 2 or test.empty:
        raise ValueError("validation split has insufficient winner/non-winner variation")

    baseline_cols = ["market_log_prob", "going_wetness"]
    enhanced_cols = baseline_cols + ["going_fit_z", "going_market_disagreement"]
    baseline = _fit_probs(train, test, baseline_cols, LogisticRegression)
    enhanced = _fit_probs(train, test, enhanced_cols, LogisticRegression)

    test = test.copy()
    test["baseline_prob"] = baseline
    test["enhanced_prob"] = enhanced
    baseline_ll = _race_log_loss(test, "baseline_prob")
    enhanced_ll = _race_log_loss(test, "enhanced_prob")

    threshold = test["going_market_disagreement"].quantile(0.75)
    bucket = test[test["going_market_disagreement"] >= threshold]
    stakes = len(bucket)
    returns = (
        bucket["winner"].astype(float)
        * bucket["win_odds"].fillna(0.0).astype(float)
    ).sum()
    roi = (returns - stakes) / stakes if stakes else 0.0
    hit_rate = float(bucket["winner"].mean()) if stakes else 0.0

    return ValidationResult(
        races=int(test["race_id"].nunique()),
        runners=len(test),
        baseline_log_loss=baseline_ll,
        enhanced_log_loss=enhanced_ll,
        bucket_stakes=stakes,
        bucket_roi=roi,
        bucket_hit_rate=hit_rate,
    )


def _fit_probs(train, test, cols, logistic_regression):
    import numpy as np

    model = logistic_regression(max_iter=1000, class_weight="balanced")
    model.fit(train[cols].to_numpy(), train["winner"].to_numpy())
    raw = model.predict_proba(test[cols].to_numpy())[:, 1]
    clipped = np.clip(raw, 1e-6, 1.0)
    denom = test.assign(_p=clipped).groupby("race_id")["_p"].transform("sum").to_numpy()
    return clipped / np.clip(denom, 1e-6, None)


def _race_log_loss(df, prob_col: str) -> float:
    import numpy as np

    winners = df[df["winner"] == 1]
    return float(-np.log(np.clip(winners[prob_col].to_numpy(), 1e-12, 1.0)).mean())


def _load_rows(lake: LakePaths) -> list[dict]:
    sql = f"""
    SELECT
        gf.race_id,
        gf.horse_id,
        gf.horse_number,
        gf.as_of_time,
        gf.going_wetness,
        gf.going_fit_z,
        gf.going_market_disagreement,
        COALESCE(gf.market_implied_prob, 1.0 / NULLIF(gf.field_size, 0)) AS market_prob,
        LOG(GREATEST(COALESCE(gf.market_implied_prob, 1.0 / NULLIF(gf.field_size, 0)), 1e-6))
            AS market_log_prob,
        gf.win_odds,
        gf.year,
        rr.finish_position = 1 AS winner,
        ra.race_date
    FROM {lake_query.src(lake.gold_dataset(GOING_FEATURE_SET))} gf
    JOIN {lake_query.src(lake.silver_dataset("jravan_race_results"))} rr
      ON rr.race_id = gf.race_id
     AND rr.horse_id = gf.horse_id
    JOIN {lake_query.src(lake.silver_dataset("jravan_races"))} ra
      ON ra.race_id = gf.race_id
    WHERE gf.going_wetness >= 3
      AND rr.finish_position IS NOT NULL
      AND gf.going_fit_z IS NOT NULL
    """
    table = lake_query.query(sql)
    return table.to_pylist()


if __name__ == "__main__":
    main()
