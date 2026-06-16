"""Calibrated market baseline (Model 0).

The raw win market is first de-vigged within race. A favorite-longshot beta
calibration is then fit walk-forward: for each race, beta is chosen from prior
settled races only, never from the race being scored or future outcomes.

Why these three steps are non-negotiable
----------------------------------------
1. **De-vigging** (within-race normalization by sum of implied probs): the
   raw 1/odds probabilities sum to >1 because of the track takeout. Any model
   that compares itself to "the market" without removing the vig is comparing
   to an overconfident baseline -- a meaningless bar.
2. **Walk-forward only**: a global beta fitted over the whole sample (future
   outcomes included) leaks winner information into the calibration of past
   races -- the exact flavor of leakage that flatters backtests.
3. **Result-gated history**: the beta is rebuilt only from races whose
   ``result_available_at`` is at or before the race being scored. This is a
   stricter condition than "race_date <= race_date" -- it accounts for the
   delay between the race running and the official result being available.

The grid search minimizes in-sample log-loss on the calibration window itself.
This is empirical-Bayes shrinkage, not a held-out evaluation -- the per-race
calibrated probability is the model's belief given everything known pre-race,
and the validation harness judges it on later races the fit has never seen.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Iterable

from keibamon_core import lake_query
from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths

MARKET_BASELINE_FEATURE_SET = "market_baseline"


@dataclass(frozen=True)
class MarketObservation:
    devigged_prob: float
    won: bool


def build_market_probs(
    lake: LakePaths,
    *,
    min_calibration_races: int = 20,
    calibration_window: int = 1000,
    refit_every: int = 250,
) -> int:
    """Write calibrated market probabilities to gold ``market_baseline``.

    Each gold row carries the columns honest evaluation needs:
    ``raw_implied_prob``, ``devigged_market_prob``, ``market_beta``,
    ``calibrated_market_prob``, ``as_of_time``, ``max_source_available_at``
    (where ``max_source_available_at <= as_of_time`` is asserted before any
    row is written).
    """
    required = (
        lake.silver_dataset("jravan_races"),
        lake.silver_dataset("jravan_race_entries"),
        lake.silver_dataset("jravan_race_results"),
        lake.silver_dataset("jravan_win_place_odds"),
    )
    if not all(path.exists() for path in required):
        return 0

    history: list[list[MarketObservation]] = []
    pending: list[tuple[object, list[MarketObservation]]] = []
    history_max_available = None
    beta = 1.0
    last_fit_n = 0
    records: list[dict] = []

    for _, rows in lake_query.iter_groups(_market_sql(lake), key="race_id"):
        as_of_time = rows[0]["as_of_time"]
        newly_available = [p for p in pending if p[0] <= as_of_time]
        pending = [p for p in pending if p[0] > as_of_time]
        for available_at, observations in newly_available:
            history.append(observations)
            history_max_available = (
                available_at
                if history_max_available is None
                else max(history_max_available, available_at)
            )

        if len(history) < min_calibration_races:
            beta = 1.0
        elif last_fit_n < min_calibration_races or len(history) - last_fit_n >= refit_every:
            beta = fit_beta(
                history,
                min_races=min_calibration_races,
                max_races=calibration_window,
            )
            last_fit_n = len(history)
        calibrated = calibrate_probs(
            {int(r["horse_number"]): float(r["devigged_market_prob"]) for r in rows},
            beta,
        )
        calibration_available = history_max_available

        for row in rows:
            max_source = row["max_source_available_at"]
            if calibration_available is not None:
                max_source = max(max_source, calibration_available)
            records.append(
                {
                    "race_id": row["race_id"],
                    "horse_id": row["horse_id"],
                    "horse_number": row["horse_number"],
                    "as_of_time": row["as_of_time"],
                    "max_source_available_at": max_source,
                    "win_odds": row["win_odds"],
                    "raw_implied_prob": row["raw_implied_prob"],
                    "devigged_market_prob": row["devigged_market_prob"],
                    "market_beta": beta,
                    "calibrated_market_prob": calibrated[int(row["horse_number"])],
                    "finish_position": row["finish_position"],
                    "year": row["year"],
                    "venue": row["venue"],
                }
            )

        observations = [
            MarketObservation(float(r["devigged_market_prob"]), r["finish_position"] == 1)
            for r in rows
            if r["finish_position"] is not None
        ]
        result_available = max(
            (r["result_available_at"] for r in rows if r["result_available_at"] is not None),
            default=None,
        )
        if observations and result_available is not None:
            pending.append((result_available, observations))

    if not records:
        return 0
    _assert_no_leakage(records)
    write_dataset(records, lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))
    return len(records)


def main() -> None:
    """CLI entry: build the market_baseline gold dataset and print row count.

    Used directly (``python -m keibamon_core.ingestion.market_baseline``) and
    called by ``tools/validate_market_baseline.py`` when the gold is missing.
    """
    lake = LakePaths()
    count = build_market_probs(lake)
    print(json.dumps({"market_baseline_rows": count}, indent=2))


def fit_beta(
    history: list[list[MarketObservation]],
    *,
    min_races: int = 20,
    max_races: int = 1000,
) -> float:
    if len(history) < min_races:
        return 1.0
    history = history[-max_races:]
    grid = [round(0.25 + i * 0.05, 2) for i in range(56)]  # 0.25 .. 3.00
    return min(grid, key=lambda beta: _log_loss(history, beta))


def calibrate_probs(probs: dict[int, float], beta: float) -> dict[int, float]:
    powered = {k: max(v, 1e-12) ** beta for k, v in probs.items()}
    denom = sum(powered.values())
    return {k: v / denom for k, v in powered.items()}


def _log_loss(history: list[list[MarketObservation]], beta: float) -> float:
    losses = []
    for race in history:
        probs = calibrate_probs({i: obs.devigged_prob for i, obs in enumerate(race)}, beta)
        winner = next((i for i, obs in enumerate(race) if obs.won), None)
        if winner is not None:
            losses.append(-math.log(max(probs[winner], 1e-12)))
    return sum(losses) / len(losses) if losses else float("inf")


@dataclass(frozen=True)
class CalibrationQuality:
    """Out-of-sample probability quality of Model 0 vs the raw de-vigged market.

    ``calibrated_market_prob`` is built with a walk-forward beta fit only from
    prior settled races; ``devigged_market_prob`` is the within-race de-vig.
    Both are PIT gold columns, so a calibrated log-loss below devigged is genuine
    out-of-sample evidence the favorite-longshot correction earns its keep. If
    not, the calibration step is complexity without benefit and Model 0 should
    drop to plain de-vigged probabilities.
    """

    races: int               # races contributing a winner to the log-loss
    runners: int             # runner-rows contributing to the Brier
    calibrated_log_loss: float
    devigged_log_loss: float
    calibrated_brier: float  # mean per-runner (p - y)^2 (lower is better)
    devigged_brier: float

    @property
    def log_loss_delta(self) -> float:
        """calibrated - devigged. Negative means calibration improves the loss."""
        return self.calibrated_log_loss - self.devigged_log_loss

    @property
    def brier_delta(self) -> float:
        return self.calibrated_brier - self.devigged_brier


def calibration_quality(rows: Iterable[dict]) -> "CalibrationQuality | None":
    """OOS probability quality of Model 0 over gold rows.

    ``rows`` are dicts carrying ``calibrated_market_prob``, ``devigged_market_prob``
    and ``finish_position`` (the PIT gold columns). Returns None when no row has a
    known winner (log-loss undefined). Brier is the mean per-runner squared error;
    because calibrated and devigged are scored on the same rows, the field-size
    factor cancels in the comparison.
    """
    cal_ll = dev_ll = 0.0
    cal_brier = dev_brier = 0.0
    winners = 0
    runners = 0
    for r in rows:
        cp = r.get("calibrated_market_prob")
        dp = r.get("devigged_market_prob")
        if cp is None or dp is None:
            continue
        runners += 1
        won = r.get("finish_position") == 1
        cal_brier += (cp - (1.0 if won else 0.0)) ** 2
        dev_brier += (dp - (1.0 if won else 0.0)) ** 2
        if won:
            cal_ll += -math.log(max(cp, 1e-12))
            dev_ll += -math.log(max(dp, 1e-12))
            winners += 1
    if winners == 0:
        return None
    return CalibrationQuality(
        races=winners,
        runners=runners,
        calibrated_log_loss=cal_ll / winners,
        devigged_log_loss=dev_ll / winners,
        calibrated_brier=cal_brier / runners,
        devigged_brier=dev_brier / runners,
    )


@dataclass(frozen=True)
class BinCalibration:
    """One probability-bin slice of the OOS calibration comparison.

    Bucketed by ``devigged_market_prob`` (the raw market statement) so the
    favorite-longshot tail can be inspected directly: ``observed`` vs
    ``mean_devigged`` shows the raw bias, ``mean_calibrated`` shows where the
    beta moved the probability, and the two Brier values show who is closer to
    realized outcomes in that slice.
    """

    lo: float
    hi: float
    n: int
    mean_devigged: float
    mean_calibrated: float
    observed: float
    devigged_brier: float
    calibrated_brier: float

    @property
    def cal_helps_brier(self) -> bool:
        """True when calibrated is closer to observed (lower Brier) in this bin."""
        return self.calibrated_brier < self.devigged_brier


def calibration_by_prob_bin(
    rows: Iterable[dict], bins: list[tuple[float, float]]
) -> list[BinCalibration]:
    """Slice the OOS calibration comparison into probability bins.

    The aggregate ``calibration_quality`` is dominated by favorites and by the
    dense 0.0-0.4 bins -- exactly where the JRA win market is already calibrated
    and where favorite-longshot bias is not. The bias classically lives in the
    longshot tail (very low implied prob), which contributes almost nothing to
    aggregate log-loss because longshots rarely win. This slices finely at the
    low end (pass e.g. ``[(0,0.01),(0.01,0.02),(0.02,0.05),(0.05,0.1),...]``) so
    the tail can be read directly. Bins with no rows return NaN stats with n=0.
    """
    acc = {
        b: {"n": 0, "sum_dev": 0.0, "sum_cal": 0.0, "wins": 0,
            "dev_brier": 0.0, "cal_brier": 0.0}
        for b in bins
    }

    def find_bin(p: float):
        for b in bins:
            if b[0] < p <= b[1]:
                return b
        return None

    for r in rows:
        dp = r.get("devigged_market_prob")
        cp = r.get("calibrated_market_prob")
        if dp is None or cp is None:
            continue
        b = find_bin(dp)
        if b is None:
            continue
        won = r.get("finish_position") == 1
        y = 1.0 if won else 0.0
        a = acc[b]
        a["n"] += 1
        a["sum_dev"] += dp
        a["sum_cal"] += cp
        a["wins"] += 1 if won else 0
        a["dev_brier"] += (dp - y) ** 2
        a["cal_brier"] += (cp - y) ** 2

    nan = float("nan")
    out: list[BinCalibration] = []
    for b in bins:
        a = acc[b]
        n = a["n"]
        if n == 0:
            out.append(BinCalibration(b[0], b[1], 0, nan, nan, nan, nan, nan))
        else:
            out.append(
                BinCalibration(
                    lo=b[0], hi=b[1], n=n,
                    mean_devigged=a["sum_dev"] / n,
                    mean_calibrated=a["sum_cal"] / n,
                    observed=a["wins"] / n,
                    devigged_brier=a["dev_brier"] / n,
                    calibrated_brier=a["cal_brier"] / n,
                )
            )
    return out


def _market_sql(lake: LakePaths) -> str:
    race_date_ts = _ts_sql("race_date")
    post_ts = _ts_sql("scheduled_post_time")
    race_available_ts = _ts_sql("available_at")
    entry_available_ts = _ts_sql("available_at")
    result_available_ts = _ts_sql("available_at")
    odds_available_ts = _ts_sql("available_at")
    return f"""
WITH
races AS (
    SELECT
        race_id,
        COALESCE({post_ts}, {race_date_ts}) AS as_of_time,
        {race_available_ts} AS race_available_at,
        year,
        venue
    FROM {lake_query.src(lake.silver_dataset("jravan_races"))}
),
entries AS (
    SELECT
        race_id,
        horse_id,
        horse_number,
        {entry_available_ts} AS entry_available_at
    FROM {lake_query.src(lake.silver_dataset("jravan_race_entries"))}
),
results AS (
    SELECT
        race_id,
        horse_id,
        finish_position,
        {result_available_ts} AS result_available_at
    FROM {lake_query.src(lake.silver_dataset("jravan_race_results"))}
),
target AS (
    SELECT
        ra.*,
        en.horse_id,
        en.horse_number,
        en.entry_available_at,
        rr.finish_position,
        rr.result_available_at
    FROM races ra
    JOIN entries en USING (race_id)
    LEFT JOIN results rr
      ON rr.race_id = en.race_id
     AND rr.horse_id = en.horse_id
    WHERE ra.race_available_at <= ra.as_of_time
      AND en.entry_available_at <= ra.as_of_time
),
odds AS (
    SELECT
        race_id,
        CAST(combo AS INTEGER) AS horse_number,
        odds AS win_odds,
        1.0 / odds AS raw_implied_prob,
        {odds_available_ts} AS odds_available_at
    FROM {lake_query.src(lake.silver_dataset("jravan_win_place_odds"))}
    WHERE bet_type = 'win'
      AND odds IS NOT NULL
      AND odds > 0
),
latest AS (
    SELECT *
    FROM (
        SELECT
            t.*,
            o.win_odds,
            o.raw_implied_prob,
            o.odds_available_at,
            ROW_NUMBER() OVER (
                PARTITION BY t.race_id, t.horse_number
                ORDER BY o.odds_available_at DESC NULLS LAST
            ) AS rn
        FROM target t
        JOIN odds o
          ON o.race_id = t.race_id
         AND o.horse_number = t.horse_number
         AND o.odds_available_at <= t.as_of_time
    )
    WHERE rn = 1
),
devigged AS (
    SELECT
        *,
        raw_implied_prob / NULLIF(SUM(raw_implied_prob) OVER (PARTITION BY race_id), 0)
            AS devigged_market_prob,
        GREATEST(race_available_at, entry_available_at, odds_available_at)
            AS max_source_available_at
    FROM latest
)
SELECT
    race_id,
    horse_id,
    horse_number,
    as_of_time,
    max_source_available_at,
    win_odds,
    raw_implied_prob,
    devigged_market_prob,
    finish_position,
    result_available_at,
    year,
    venue
FROM devigged
ORDER BY as_of_time, race_id, horse_number
"""


def _ts_sql(expr: str) -> str:
    as_text = f"CAST({expr} AS VARCHAR)"
    return f"""(
        CASE
            WHEN {expr} IS NULL THEN NULL
            WHEN regexp_matches({as_text}, '^\\d{{14}}$')
                THEN strptime({as_text}, '%Y%m%d%H%M%S')::TIMESTAMPTZ
            WHEN regexp_matches({as_text}, '^\\d{{8}}$')
                THEN strptime({as_text}, '%Y%m%d')::TIMESTAMPTZ
            ELSE CAST({expr} AS TIMESTAMPTZ)
        END
    )"""


def _assert_no_leakage(records: list[dict]) -> None:
    leaked = [
        (r["race_id"], r["horse_id"], r["max_source_available_at"], r["as_of_time"])
        for r in records
        if r["max_source_available_at"] and r["max_source_available_at"] > r["as_of_time"]
    ]
    if leaked:
        race_id, horse_id, available_at, as_of_time = leaked[0]
        raise ValueError(
            "market baseline leakage: "
            f"{race_id}/{horse_id} used {available_at!r} after as_of_time {as_of_time!r}"
        )


if __name__ == "__main__":
    main()
