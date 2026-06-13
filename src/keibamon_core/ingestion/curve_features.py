"""Build point-in-time odds-curve features.

The features describe what the market had done by a real pre-post decision
time. Closing odds and payouts are deliberately left for validation/settlement;
they are not feature inputs because they are unknown at bet time.
"""
from __future__ import annotations

import json

from keibamon_core import lake_query
from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths

CURVE_FEATURE_SET = "odds_curve"
DEFAULT_DECISION_MINUTES = (30, 10, 2)


def build_curve_features(
    lake: LakePaths,
    decision_minutes: tuple[int, ...] = DEFAULT_DECISION_MINUTES,
) -> int:
    """Materialize PIT odds-curve features per ``(race, runner, decision time)``."""
    races = lake.silver_dataset("jravan_races")
    entries = lake.silver_dataset("jravan_race_entries")
    odds = lake.silver_dataset("jravan_odds_timeseries")
    if not races.exists() or not entries.exists() or not odds.exists():
        return 0

    sql = _feature_sql(lake, decision_minutes)
    con = lake_query.connect()
    try:
        table = lake_query._to_arrow(con.execute(sql))  # noqa: SLF001
    finally:
        con.close()

    records = table.to_pylist()
    if not records:
        return 0
    _assert_no_leakage(records)
    write_dataset(records, lake.gold_dataset(CURVE_FEATURE_SET))
    return len(records)


def _feature_sql(lake: LakePaths, decision_minutes: tuple[int, ...]) -> str:
    decisions = ", ".join(f"({int(m)})" for m in decision_minutes)
    race_date_ts = _ts_sql("race_date")
    post_ts = _ts_sql("scheduled_post_time")
    race_available_ts = _ts_sql("available_at")
    entry_available_ts = _ts_sql("available_at")
    odds_available_ts = _ts_sql("available_at")
    return f"""
WITH
decision_minutes(minutes_to_post) AS (VALUES {decisions}),
races AS (
    SELECT
        race_id,
        {race_date_ts} AS race_date,
        {post_ts} AS scheduled_post_time,
        {race_available_ts} AS race_available_at,
        year,
        venue
    FROM {lake_query.src(lake.silver_dataset("jravan_races"))}
    WHERE scheduled_post_time IS NOT NULL
),
entries AS (
    SELECT
        race_id,
        horse_id,
        horse_number,
        {entry_available_ts} AS entry_available_at
    FROM {lake_query.src(lake.silver_dataset("jravan_race_entries"))}
),
target AS (
    SELECT
        ra.race_id,
        en.horse_id,
        en.horse_number,
        dm.minutes_to_post AS decision_minutes_to_post,
        ra.scheduled_post_time - dm.minutes_to_post * INTERVAL '1 minute' AS as_of_time,
        ra.scheduled_post_time,
        ra.race_available_at,
        en.entry_available_at,
        ra.year,
        ra.venue
    FROM races ra
    JOIN entries en USING (race_id)
    CROSS JOIN decision_minutes dm
    WHERE ra.race_available_at <= ra.scheduled_post_time - dm.minutes_to_post * INTERVAL '1 minute'
      AND en.entry_available_at <= ra.scheduled_post_time - dm.minutes_to_post * INTERVAL '1 minute'
),
win_odds AS (
    SELECT
        race_id,
        sel,
        CAST(sel AS INTEGER) AS horse_number,
        {odds_available_ts} AS available_at,
        win_odds,
        popularity
    FROM {lake_query.src(lake.silver_dataset("jravan_odds_timeseries"))}
    WHERE pool = 'win'
      AND win_odds IS NOT NULL
      AND win_odds > 0
),
snapshot_base AS (
    SELECT
        *,
        (1.0 / win_odds) AS raw_prob,
        SUM(1.0 / win_odds) OVER (PARTITION BY race_id, available_at) AS overround,
        RANK() OVER (PARTITION BY race_id, available_at ORDER BY win_odds ASC, horse_number) AS odds_rank
    FROM win_odds
),
snapshot_market AS (
    SELECT
        *,
        raw_prob / NULLIF(overround, 0) AS devigged_prob,
        -SUM(
            (raw_prob / NULLIF(overround, 0))
            * LN(GREATEST(raw_prob / NULLIF(overround, 0), 1e-12))
        ) OVER (PARTITION BY race_id, available_at) AS market_entropy
    FROM snapshot_base
),
joined AS (
    SELECT
        t.*,
        s.available_at,
        s.win_odds,
        s.devigged_prob,
        s.market_entropy,
        s.odds_rank,
        LN(s.win_odds) AS log_odds,
        ROW_NUMBER() OVER (
            PARTITION BY t.race_id, t.horse_id, t.horse_number, t.decision_minutes_to_post
            ORDER BY s.available_at ASC NULLS LAST
        ) AS rn_asc,
        ROW_NUMBER() OVER (
            PARTITION BY t.race_id, t.horse_id, t.horse_number, t.decision_minutes_to_post
            ORDER BY s.available_at DESC NULLS LAST
        ) AS rn_desc
    FROM target t
    LEFT JOIN snapshot_market s
      ON s.race_id = t.race_id
     AND s.horse_number = t.horse_number
     AND s.available_at <= t.as_of_time
),
pivoted AS (
    SELECT
        race_id,
        horse_id,
        horse_number,
        decision_minutes_to_post,
        as_of_time,
        scheduled_post_time,
        race_available_at,
        entry_available_at,
        year,
        venue,
        MAX(CASE WHEN rn_asc = 1 THEN win_odds END) AS open_win_odds,
        MAX(CASE WHEN rn_asc = 1 THEN odds_rank END) AS open_odds_rank,
        MAX(CASE WHEN rn_desc = 1 THEN win_odds END) AS win_odds_at_t,
        MAX(CASE WHEN rn_desc = 1 THEN devigged_prob END) AS devigged_prob_at_t,
        MAX(CASE WHEN rn_desc = 1 THEN odds_rank END) AS odds_rank_at_t,
        MAX(CASE WHEN rn_desc = 1 THEN market_entropy END) AS market_entropy_at_t,
        MAX(CASE WHEN rn_desc = 1 THEN available_at END) AS latest_available_at,
        MAX(CASE WHEN rn_desc = 1 THEN log_odds END) AS latest_log_odds,
        MAX(CASE WHEN rn_desc = 1 THEN epoch(available_at) END) AS latest_epoch,
        MAX(CASE WHEN rn_desc = 2 THEN log_odds END) AS prev_log_odds,
        MAX(CASE WHEN rn_desc = 2 THEN epoch(available_at) END) AS prev_epoch,
        MAX(CASE WHEN rn_desc = 3 THEN log_odds END) AS third_log_odds,
        MAX(CASE WHEN rn_desc = 3 THEN epoch(available_at) END) AS third_epoch,
        STDDEV_SAMP(log_odds) AS odds_volatility,
        COUNT(win_odds) AS odds_snapshots_used
    FROM joined
    GROUP BY
        race_id, horse_id, horse_number, decision_minutes_to_post, as_of_time,
        scheduled_post_time, race_available_at, entry_available_at, year, venue
),
features AS (
    SELECT
        *,
        LN(win_odds_at_t / NULLIF(open_win_odds, 0)) AS drift_open_to_t,
        open_odds_rank - odds_rank_at_t AS odds_rank_change,
        CASE
            WHEN latest_epoch IS NOT NULL AND prev_epoch IS NOT NULL AND latest_epoch > prev_epoch
                THEN (latest_log_odds - prev_log_odds) / ((latest_epoch - prev_epoch) / 60.0)
            ELSE NULL
        END AS recent_velocity,
        CASE
            WHEN latest_epoch IS NOT NULL AND prev_epoch IS NOT NULL AND third_epoch IS NOT NULL
             AND latest_epoch > prev_epoch AND prev_epoch > third_epoch
                THEN
                    ((latest_log_odds - prev_log_odds) / ((latest_epoch - prev_epoch) / 60.0))
                    - ((prev_log_odds - third_log_odds) / ((prev_epoch - third_epoch) / 60.0))
            ELSE NULL
        END AS recent_acceleration
    FROM pivoted
)
SELECT
    race_id,
    horse_id,
    horse_number,
    decision_minutes_to_post,
    as_of_time,
    GREATEST(
        race_available_at,
        entry_available_at,
        COALESCE(latest_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00')
    ) AS max_source_available_at,
    scheduled_post_time,
    open_win_odds,
    win_odds_at_t,
    devigged_prob_at_t,
    drift_open_to_t,
    recent_velocity,
    recent_acceleration,
    odds_volatility,
    market_entropy_at_t,
    open_odds_rank,
    odds_rank_at_t,
    odds_rank_change,
    odds_snapshots_used,
    decision_minutes_to_post AS time_to_post_minutes,
    year,
    venue
FROM features
ORDER BY race_id, decision_minutes_to_post DESC, horse_number
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
            "odds-curve feature leakage: "
            f"{race_id}/{horse_id} used {available_at!r} after as_of_time {as_of_time!r}"
        )


if __name__ == "__main__":
    print(json.dumps({"odds_curve": build_curve_features(LakePaths())}, indent=2))
