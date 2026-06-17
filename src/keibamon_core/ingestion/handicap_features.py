"""Build point-in-time fundamental (market-blind) handicap features.

This is the Phase 0 builder for the capstone hypothesis #6 (Benter-style
fundamental + market blend). The features here are deliberately **market-blind**:
no odds, no popularity, no drift, no `devigged_market_prob`. They cover recent
form, speed/pace par, connections (trainer / jockey trailing rates), physical /
entry-time attributes, race context, and folded-in PIT-clean gold signals
(going_handling, training, mining). The market enters only at blend time
(``validate_handicap_model.py`` Phase 2).

PIT pattern
-----------
Trailing aggregates use the ``going_features.py`` LEFT JOIN pattern -- NOT
window functions -- because ``result_available_at`` equals ``as_of_time`` for
the current race, and the ``race_date < t.race_date`` guard is load-bearing
for excluding self-leakage:

    LEFT JOIN race_perf h
      ON h.horse_id = t.horse_id
     AND t.horse_id <> '0000000000'        -- placeholder guard (DATA_TRAPS)
     AND h.race_date < t.race_date          -- strictly earlier day
     AND h.result_available_at <= t.as_of_time   -- PIT

The placeholder guard is critical because ``horse_id='0000000000'`` is shared
by many unrelated runners; joining on it would smear one runner's history into
another's.

Output: gold ``handicap`` table, one row per ``(race_id, horse_id, horse_number)``,
carrying ``as_of_time`` and ``max_source_available_at`` so the existing leakage
guard can verify ``max_source_available_at <= as_of_time`` before model fit.
"""
from __future__ import annotations

import json
from pathlib import Path

from keibamon_core import lake_query
from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths

HANDICAP_FEATURE_SET = "handicap"
PLACEHOLDER_HORSE_ID = "0000000000"

# Columns produced here, used as the model input in validate_handicap_model.py.
# Keep this list auditable: NONE of these are odds/market-derived. The market
# enters only at blend time (Phase 2).
FUNDAMENTAL_FEATURES: tuple[str, ...] = (
    # recent form (horse history)
    "last_finish_pos",
    "last_finish_time_sec",
    "last_last_3f_sec",
    "avg_finish_pos_5",
    "avg_finish_time_sec_5",
    "wins_last_10",
    "starts_last_10",
    "starts_last_365d",
    "days_since_last_race",
    # speed / pace par (horse prior vs bucket median)
    "finish_time_par_delta",
    "last_3f_par_delta",
    # connections (trailing 365-day rates)
    "trainer_winrate_365d",
    "trainer_top3rate_365d",
    "trainer_starts_365d",
    "jockey_winrate_365d",
    "jockey_top3rate_365d",
    "jockey_starts_365d",
    "trainer_jockey_combo_winrate_365d",
    "trainer_jockey_combo_starts_365d",
    "jockey_track_winrate_365d",
    "jockey_track_starts_365d",
    # physical / entry-time
    "body_weight_kg",
    "body_weight_delta_vs_last",
    "carried_weight_kg",
    "gate",
    "age_years",
    # race context
    "field_size",
    "distance_m",
    "surface_turf",
    "going_wetness",
    "weather_code",
    "grade_code_idx",
    "is_filtered_name_match",
    # folded-in PIT-clean gold + raw mining
    "going_perf_delta_z",
    "going_fit_z",
    "training_last_1f_recent",
    "training_last_1f_accel",
    "training_days_since_work",
    "pred_time_seconds",
)


def build_handicap_features(lake: LakePaths) -> int:
    """Materialize per-runner PIT fundamental features to gold ``handicap``.

    Returns the number of rows written. Writes nothing if any required silver
    table is missing.
    """
    races = lake.silver_dataset("jravan_races")
    entries = lake.silver_dataset("jravan_race_entries")
    results = lake.silver_dataset("jravan_race_results")
    if not races.exists() or not entries.exists() or not results.exists():
        return 0

    sql = _feature_sql(
        races=races,
        entries=entries,
        results=results,
        mining=lake.silver_dataset("jravan_mining"),
        going=lake.gold_dataset("going_handling"),
        training=lake.gold_dataset("training"),
    )
    con = lake_query.connect()
    try:
        table = lake_query._to_arrow(con.execute(sql))  # noqa: SLF001 - local compat shim.
    finally:
        con.close()

    records = table.to_pylist()
    if not records:
        return 0
    _assert_no_leakage(records)
    _assert_no_market_features(records)
    write_dataset(records, lake.gold_dataset(HANDICAP_FEATURE_SET))
    return len(records)


# ----------------------------------------------------------------------------
# Feature SQL
# ----------------------------------------------------------------------------


def _feature_sql(
    *,
    races: Path,
    entries: Path,
    results: Path,
    mining: Path,
    going: Path,
    training: Path,
) -> str:
    race_date_ts = _ts_sql("race_date")
    scheduled_post_ts = _ts_sql("scheduled_post_time")
    race_available_ts = _ts_sql("available_at")
    entry_available_ts = _ts_sql("available_at")
    result_available_ts = _ts_sql("available_at")
    mining_available_ts = _ts_sql("available_at")

    mining_cte = (
        f"SELECT race_id, horse_number, pred_time_seconds, mining_available_at FROM ("
        f"SELECT race_id, horse_number, pred_time_seconds, "
        f"{mining_available_ts} AS mining_available_at, "
        f"ROW_NUMBER() OVER (PARTITION BY race_id, horse_number ORDER BY {mining_available_ts} DESC) AS rn "
        f"FROM {lake_query.src(mining)} "
        f"WHERE model = 'time' AND pred_time_seconds IS NOT NULL"
        f") WHERE rn = 1"
        if mining.exists()
        else """
        SELECT
            NULL::VARCHAR AS race_id,
            NULL::BIGINT AS horse_number,
            NULL::DOUBLE AS pred_time_seconds,
            NULL::TIMESTAMPTZ AS mining_available_at
        WHERE false
        """
    )

    going_cte = (
        f"SELECT race_id, horse_number, going_perf_delta_z, going_fit_z, "
        f"going_max_available_at FROM ("
        f"SELECT race_id, horse_number, going_perf_delta_z, going_fit_z, "
        f"max_source_available_at AS going_max_available_at, "
        f"ROW_NUMBER() OVER (PARTITION BY race_id, horse_number ORDER BY max_source_available_at DESC) AS rn "
        f"FROM {lake_query.src(going)}"
        f") WHERE rn = 1"
        if going.exists()
        else """
        SELECT
            NULL::VARCHAR AS race_id,
            NULL::BIGINT AS horse_number,
            NULL::DOUBLE AS going_perf_delta_z,
            NULL::DOUBLE AS going_fit_z,
            NULL::TIMESTAMPTZ AS going_max_available_at
        WHERE false
        """
    )

    training_cte = (
        f"SELECT race_id, horse_number, training_last_1f_recent, "
        f"training_last_1f_accel, training_days_since_work, "
        f"training_max_available_at FROM ("
        f"SELECT race_id, horse_number, training_last_1f_recent, "
        f"training_last_1f_accel, training_days_since_work, "
        f"max_source_available_at AS training_max_available_at, "
        f"ROW_NUMBER() OVER (PARTITION BY race_id, horse_number ORDER BY max_source_available_at DESC) AS rn "
        f"FROM {lake_query.src(training)}"
        f") WHERE rn = 1"
        if training.exists()
        else """
        SELECT
            NULL::VARCHAR AS race_id,
            NULL::BIGINT AS horse_number,
            NULL::DOUBLE AS training_last_1f_recent,
            NULL::DOUBLE AS training_last_1f_accel,
            NULL::BIGINT AS training_days_since_work,
            NULL::TIMESTAMPTZ AS training_max_available_at
        WHERE false
        """
    )

    # NOTE on `bucket_*_median`: PIT at year granularity -- the median over all
    # prior-year races in the same (course, distance, surface, going) bucket.
    # Year-granularity is an approximation (loses intra-year drift) but is
    # cheap and PIT-correct: data from the target year never enters. The bucket
    # baseline is a slow-moving normalization, not a signal in itself.
    return f"""
WITH
races AS (
    SELECT
        race_id,
        {race_date_ts} AS race_date,
        COALESCE({scheduled_post_ts}, {race_date_ts}) AS as_of_time,
        racecourse,
        surface,
        distance_m,
        grade_code,
        race_name,
        weather,
        going_wetness,
        {race_available_ts} AS race_available_at,
        year,
        venue
    FROM {lake_query.src(races)}
),
entries AS (
    -- Dedup silver entries on (race_id, horse_number) keeping the latest
    -- available_at. The silver entries table has duplicate rows (a known
    -- data-quality issue) -- without dedup the trainer/jockey aggregation
    -- CTEs would double-count starts.
    SELECT race_id, horse_id, horse_number, gate, jockey_id, trainer_id,
           carried_weight_kg, body_weight_kg, entry_available_at
    FROM (
        SELECT
            race_id,
            horse_id,
            horse_number,
            gate,
            jockey_id,
            trainer_id,
            carried_weight_kg,
            body_weight_kg,
            {entry_available_ts} AS entry_available_at,
            ROW_NUMBER() OVER (
                PARTITION BY race_id, horse_number
                ORDER BY {entry_available_ts} DESC NULLS LAST
            ) AS rn
        FROM {lake_query.src(entries)}
    )
    WHERE rn = 1
),
results AS (
    SELECT race_id, horse_id, horse_number, finish_position, finish_time_seconds,
           last_3f_seconds, result_available_at
    FROM (
        SELECT
            race_id,
            horse_id,
            horse_number,
            finish_position,
            finish_time_seconds,
            last_3f_seconds,
            {result_available_ts} AS result_available_at,
            ROW_NUMBER() OVER (
                PARTITION BY race_id, horse_number
                ORDER BY {result_available_ts} DESC NULLS LAST
            ) AS rn
        FROM {lake_query.src(results)}
    )
    WHERE rn = 1
),
race_perf AS (
    -- Performance rows keyed on (race_id, horse_id, horse_number) -- the
    -- placeholder-safe key. Carries the race context needed for bucketing.
    SELECT
        rr.race_id,
        rr.horse_id,
        rr.horse_number,
        ra.race_date,
        ra.racecourse,
        ra.surface,
        ra.distance_m,
        ra.going_wetness,
        ra.year,
        rr.finish_position,
        rr.finish_time_seconds,
        rr.last_3f_seconds,
        rr.result_available_at,
        re.trainer_id,
        re.jockey_id,
        re.body_weight_kg
    FROM results rr
    JOIN races ra USING (race_id)
    LEFT JOIN entries re
      ON re.race_id = rr.race_id
     AND COALESCE(re.horse_number, -1) = COALESCE(rr.horse_number, -1)
     AND re.horse_id = rr.horse_id
),
target AS (
    SELECT
        ra.race_id,
        en.horse_id,
        en.horse_number,
        en.gate,
        en.jockey_id,
        en.trainer_id,
        en.carried_weight_kg,
        en.body_weight_kg,
        ra.race_date,
        ra.as_of_time,
        ra.racecourse,
        ra.surface,
        ra.distance_m,
        ra.grade_code,
        ra.race_name,
        ra.weather,
        ra.going_wetness,
        ra.race_available_at,
        en.entry_available_at,
        ra.year,
        ra.venue
    FROM races ra
    JOIN entries en USING (race_id)
    WHERE ra.race_available_at <= ra.as_of_time
      AND en.entry_available_at <= ra.as_of_time
),
-- PIT recent-form join: each target's prior races for the same horse,
-- ranked by race_date DESC. The race_date < t.race_date AND
-- result_available_at <= t.as_of_time guards are load-bearing.
horse_prior AS (
    SELECT
        t.race_id AS target_race_id,
        t.horse_id AS horse_id,
        t.horse_number AS horse_number,
        t.race_date AS target_race_date,
        t.as_of_time AS as_of_time,
        t.racecourse AS target_racecourse,
        t.surface AS target_surface,
        t.distance_m AS target_distance_m,
        t.going_wetness AS target_going_wetness,
        h.race_date AS prior_race_date,
        h.racecourse AS prior_racecourse,
        h.surface AS prior_surface,
        h.distance_m AS prior_distance_m,
        h.going_wetness AS prior_going_wetness,
        h.finish_position AS prior_finish_position,
        h.finish_time_seconds AS prior_finish_time_seconds,
        h.last_3f_seconds AS prior_last_3f_seconds,
        h.body_weight_kg AS prior_body_weight_kg,
        h.result_available_at AS prior_result_available_at,
        ROW_NUMBER() OVER (
            PARTITION BY t.race_id, t.horse_id, t.horse_number
            ORDER BY h.race_date DESC NULLS LAST, h.race_id DESC
        ) AS rn_prior
    FROM target t
    LEFT JOIN race_perf h
      ON h.horse_id = t.horse_id
     AND t.horse_id <> '{PLACEHOLDER_HORSE_ID}'
     AND h.race_date < t.race_date
     AND h.result_available_at <= t.as_of_time
),
horse_recent AS (
    SELECT
        target_race_id AS race_id,
        horse_id,
        horse_number,
        MAX(CASE WHEN rn_prior = 1 THEN prior_finish_position END)
            AS last_finish_pos,
        MAX(CASE WHEN rn_prior = 1 THEN prior_finish_time_seconds END)
            AS last_finish_time_sec,
        MAX(CASE WHEN rn_prior = 1 THEN prior_last_3f_seconds END)
            AS last_last_3f_sec,
        MAX(CASE WHEN rn_prior = 1 THEN
            DATE_DIFF('day', CAST(prior_race_date AS DATE), CAST(target_race_date AS DATE))
        END) AS days_since_last_race,
        AVG(CASE WHEN rn_prior <= 5 THEN prior_finish_position END)
            AS avg_finish_pos_5,
        AVG(CASE WHEN rn_prior <= 5 THEN prior_finish_time_seconds END)
            AS avg_finish_time_sec_5,
        SUM(CASE WHEN rn_prior <= 10 AND prior_finish_position = 1 THEN 1 ELSE 0 END)
            AS wins_last_10,
        SUM(CASE WHEN rn_prior <= 10 THEN 1 ELSE 0 END)
            AS starts_last_10,
        SUM(CASE WHEN prior_race_date >= target_race_date - INTERVAL '365 days'
                  AND prior_finish_position IS NOT NULL THEN 1 ELSE 0 END)
            AS starts_last_365d,
        -- Horse's bucket-matched prior races: avg finish_time / last_3f, used
        -- for the par-delta below. Same PIT guards as the rest of horse_prior.
        AVG(CASE
            WHEN prior_racecourse = target_racecourse
             AND prior_surface = target_surface
             AND prior_distance_m = target_distance_m
             AND COALESCE(prior_going_wetness, -1) = COALESCE(target_going_wetness, -1)
            THEN prior_finish_time_seconds
        END) AS horse_bucket_avg_finish_time,
        AVG(CASE
            WHEN prior_racecourse = target_racecourse
             AND prior_surface = target_surface
             AND prior_distance_m = target_distance_m
             AND COALESCE(prior_going_wetness, -1) = COALESCE(target_going_wetness, -1)
            THEN prior_last_3f_seconds
        END) AS horse_bucket_avg_last_3f,
        MAX(CASE WHEN rn_prior = 1 THEN prior_body_weight_kg END) AS last_body_weight_kg,
        MAX(prior_result_available_at) AS max_history_available_at
    FROM horse_prior
    GROUP BY target_race_id, horse_id, horse_number
),
-- PIT bucket medians at year granularity. For each (year Y, course, distance,
-- surface, going) tuple, the median finish_time / last_3f over all prior-year
-- races (year < Y) in that bucket. Cheap (one pass) and PIT-correct: a target
-- race in year Y only sees medians built from races run in years strictly
-- before Y.
bucket_median AS (
    SELECT
        t.year AS target_year,
        t.racecourse AS racecourse,
        t.surface AS surface,
        t.distance_m AS distance_m,
        t.going_wetness AS going_wetness,
        median(h.finish_time_seconds) AS bucket_finish_time_median,
        median(h.last_3f_seconds) AS bucket_last_3f_median
    FROM (
        SELECT DISTINCT
            year, racecourse, surface, distance_m, going_wetness
        FROM target
    ) t
    JOIN race_perf h
      ON h.racecourse = t.racecourse
     AND h.surface = t.surface
     AND h.distance_m = t.distance_m
     AND COALESCE(h.going_wetness, -1) = COALESCE(t.going_wetness, -1)
     AND h.year < t.year
     AND h.finish_time_seconds IS NOT NULL
    GROUP BY t.year, t.racecourse, t.surface, t.distance_m, t.going_wetness
),
-- Trainer trailing 365-day rates. JOIN on trainer_id; no placeholder guard
-- (trainer_id is its own key). Outcome observed at result_available_at.
trainer_hist AS (
    SELECT
        t.race_id AS race_id,
        t.horse_id AS horse_id,
        t.horse_number AS horse_number,
        SUM(CASE WHEN h.finish_position IS NOT NULL THEN 1 ELSE 0 END) AS trainer_starts_365d,
        SUM(CASE WHEN h.finish_position = 1 THEN 1 ELSE 0 END) AS trainer_wins_365d,
        SUM(CASE WHEN h.finish_position <= 3 THEN 1 ELSE 0 END) AS trainer_top3_365d,
        MAX(h.result_available_at) AS max_trainer_available_at
    FROM target t
    LEFT JOIN race_perf h
      ON h.trainer_id = t.trainer_id
     AND t.trainer_id IS NOT NULL AND t.trainer_id <> ''
     AND h.trainer_id IS NOT NULL AND h.trainer_id <> ''
     AND h.race_date < t.race_date
     AND h.race_date >= t.race_date - INTERVAL '365 days'
     AND h.result_available_at <= t.as_of_time
    GROUP BY t.race_id, t.horse_id, t.horse_number
),
jockey_hist AS (
    SELECT
        t.race_id AS race_id,
        t.horse_id AS horse_id,
        t.horse_number AS horse_number,
        SUM(CASE WHEN h.finish_position IS NOT NULL THEN 1 ELSE 0 END) AS jockey_starts_365d,
        SUM(CASE WHEN h.finish_position = 1 THEN 1 ELSE 0 END) AS jockey_wins_365d,
        SUM(CASE WHEN h.finish_position <= 3 THEN 1 ELSE 0 END) AS jockey_top3_365d,
        MAX(h.result_available_at) AS max_jockey_available_at
    FROM target t
    LEFT JOIN race_perf h
      ON h.jockey_id = t.jockey_id
     AND t.jockey_id IS NOT NULL AND t.jockey_id <> ''
     AND h.jockey_id IS NOT NULL AND h.jockey_id <> ''
     AND h.race_date < t.race_date
     AND h.race_date >= t.race_date - INTERVAL '365 days'
     AND h.result_available_at <= t.as_of_time
    GROUP BY t.race_id, t.horse_id, t.horse_number
),
trainer_jockey_combo AS (
    SELECT
        t.race_id AS race_id,
        t.horse_id AS horse_id,
        t.horse_number AS horse_number,
        SUM(CASE WHEN h.finish_position IS NOT NULL THEN 1 ELSE 0 END) AS combo_starts_365d,
        SUM(CASE WHEN h.finish_position = 1 THEN 1 ELSE 0 END) AS combo_wins_365d,
        MAX(h.result_available_at) AS max_combo_available_at
    FROM target t
    LEFT JOIN race_perf h
      ON h.trainer_id = t.trainer_id
     AND h.jockey_id = t.jockey_id
     AND t.trainer_id IS NOT NULL AND t.trainer_id <> ''
     AND t.jockey_id IS NOT NULL AND t.jockey_id <> ''
     AND h.trainer_id IS NOT NULL AND h.trainer_id <> ''
     AND h.jockey_id IS NOT NULL AND h.jockey_id <> ''
     AND h.race_date < t.race_date
     AND h.race_date >= t.race_date - INTERVAL '365 days'
     AND h.result_available_at <= t.as_of_time
    GROUP BY t.race_id, t.horse_id, t.horse_number
),
jockey_track_hist AS (
    SELECT
        t.race_id AS race_id,
        t.horse_id AS horse_id,
        t.horse_number AS horse_number,
        SUM(CASE WHEN h.finish_position IS NOT NULL THEN 1 ELSE 0 END) AS jockey_track_starts_365d,
        SUM(CASE WHEN h.finish_position = 1 THEN 1 ELSE 0 END) AS jockey_track_wins_365d,
        MAX(h.result_available_at) AS max_jockey_track_available_at
    FROM target t
    LEFT JOIN race_perf h
      ON h.jockey_id = t.jockey_id
     AND h.racecourse = t.racecourse
     AND t.jockey_id IS NOT NULL AND t.jockey_id <> ''
     AND h.jockey_id IS NOT NULL AND h.jockey_id <> ''
     AND h.racecourse IS NOT NULL AND h.racecourse <> ''
     AND h.race_date < t.race_date
     AND h.race_date >= t.race_date - INTERVAL '365 days'
     AND h.result_available_at <= t.as_of_time
    GROUP BY t.race_id, t.horse_id, t.horse_number
),
mining AS ({mining_cte}),
going AS ({going_cte}),
training AS ({training_cte}),
field_size_cte AS (
    SELECT race_id, COUNT(*) AS field_size
    FROM target
    GROUP BY race_id
),
base AS (
    SELECT
        t.race_id,
        t.horse_id,
        t.horse_number,
        t.gate,
        t.jockey_id,
        t.trainer_id,
        t.carried_weight_kg,
        t.body_weight_kg,
        t.race_date,
        t.as_of_time,
        t.racecourse,
        t.surface,
        t.distance_m,
        t.grade_code,
        t.race_name,
        t.weather,
        t.going_wetness,
        t.race_available_at,
        t.entry_available_at,
        t.year,
        t.venue,
        hr.last_finish_pos,
        hr.last_finish_time_sec,
        hr.last_last_3f_sec,
        hr.avg_finish_pos_5,
        hr.avg_finish_time_sec_5,
        hr.wins_last_10,
        hr.starts_last_10,
        hr.starts_last_365d,
        hr.days_since_last_race,
        CASE
            WHEN bm.bucket_finish_time_median IS NOT NULL
             AND hr.horse_bucket_avg_finish_time IS NOT NULL
            THEN hr.horse_bucket_avg_finish_time - bm.bucket_finish_time_median
        END AS finish_time_par_delta,
        CASE
            WHEN bm.bucket_last_3f_median IS NOT NULL
             AND hr.horse_bucket_avg_last_3f IS NOT NULL
            THEN hr.horse_bucket_avg_last_3f - bm.bucket_last_3f_median
        END AS last_3f_par_delta,
        CASE
            WHEN th.trainer_starts_365d IS NULL OR th.trainer_starts_365d = 0 THEN NULL
            ELSE CAST(th.trainer_wins_365d AS DOUBLE) / th.trainer_starts_365d
        END AS trainer_winrate_365d,
        CASE
            WHEN th.trainer_starts_365d IS NULL OR th.trainer_starts_365d = 0 THEN NULL
            ELSE CAST(th.trainer_top3_365d AS DOUBLE) / th.trainer_starts_365d
        END AS trainer_top3rate_365d,
        COALESCE(th.trainer_starts_365d, 0) AS trainer_starts_365d,
        CASE
            WHEN jh.jockey_starts_365d IS NULL OR jh.jockey_starts_365d = 0 THEN NULL
            ELSE CAST(jh.jockey_wins_365d AS DOUBLE) / jh.jockey_starts_365d
        END AS jockey_winrate_365d,
        CASE
            WHEN jh.jockey_starts_365d IS NULL OR jh.jockey_starts_365d = 0 THEN NULL
            ELSE CAST(jh.jockey_top3_365d AS DOUBLE) / jh.jockey_starts_365d
        END AS jockey_top3rate_365d,
        COALESCE(jh.jockey_starts_365d, 0) AS jockey_starts_365d,
        CASE
            WHEN tc.combo_starts_365d IS NULL OR tc.combo_starts_365d = 0 THEN NULL
            ELSE CAST(tc.combo_wins_365d AS DOUBLE) / tc.combo_starts_365d
        END AS trainer_jockey_combo_winrate_365d,
        COALESCE(tc.combo_starts_365d, 0) AS trainer_jockey_combo_starts_365d,
        CASE
            WHEN jt.jockey_track_starts_365d IS NULL OR jt.jockey_track_starts_365d = 0 THEN NULL
            ELSE CAST(jt.jockey_track_wins_365d AS DOUBLE) / jt.jockey_track_starts_365d
        END AS jockey_track_winrate_365d,
        COALESCE(jt.jockey_track_starts_365d, 0) AS jockey_track_starts_365d,
        CASE
            WHEN hr.last_body_weight_kg IS NULL THEN NULL
            WHEN t.body_weight_kg IS NULL THEN NULL
            ELSE t.body_weight_kg - hr.last_body_weight_kg
        END AS body_weight_delta_vs_last,
        GREATEST(
            t.race_available_at,
            t.entry_available_at,
            COALESCE(hr.max_history_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
            COALESCE(th.max_trainer_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
            COALESCE(jh.max_jockey_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
            COALESCE(tc.max_combo_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
            COALESCE(jt.max_jockey_track_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00')
        ) AS max_source_available_at,
        hr.max_history_available_at,
        th.max_trainer_available_at,
        jh.max_jockey_available_at,
        tc.max_combo_available_at,
        jt.max_jockey_track_available_at
    FROM target t
    LEFT JOIN horse_recent hr
      ON hr.race_id = t.race_id
     AND hr.horse_id = t.horse_id
     AND COALESCE(hr.horse_number, -1) = COALESCE(t.horse_number, -1)
    LEFT JOIN bucket_median bm
      ON bm.target_year = t.year
     AND bm.racecourse = t.racecourse
     AND bm.surface = t.surface
     AND bm.distance_m = t.distance_m
     AND COALESCE(bm.going_wetness, -1) = COALESCE(t.going_wetness, -1)
    LEFT JOIN trainer_hist th
      ON th.race_id = t.race_id
     AND th.horse_id = t.horse_id
     AND COALESCE(th.horse_number, -1) = COALESCE(t.horse_number, -1)
    LEFT JOIN jockey_hist jh
      ON jh.race_id = t.race_id
     AND jh.horse_id = t.horse_id
     AND COALESCE(jh.horse_number, -1) = COALESCE(t.horse_number, -1)
    LEFT JOIN trainer_jockey_combo tc
      ON tc.race_id = t.race_id
     AND tc.horse_id = t.horse_id
     AND COALESCE(tc.horse_number, -1) = COALESCE(t.horse_number, -1)
    LEFT JOIN jockey_track_hist jt
      ON jt.race_id = t.race_id
     AND jt.horse_id = t.horse_id
     AND COALESCE(jt.horse_number, -1) = COALESCE(t.horse_number, -1)
),
folded AS (
    SELECT
        b.*,
        -- horse_id is the JRA ketto-num: YYYYRRRRRR where YYYY is the birth year
        -- and RRRRRR is a registration sequence (NOT a date -- positions 5-10
        -- are not month/day). Age in whole years at the race date.
        CASE
            WHEN substring(b.horse_id, 1, 4) ~ '^\\d{{4}}$'
                THEN EXTRACT(YEAR FROM b.race_date) - CAST(substring(b.horse_id, 1, 4) AS INTEGER)
        END AS age_years,
        CASE WHEN b.surface = 'turf' THEN 1 ELSE 0 END AS surface_turf,
        COALESCE(fs.field_size, 0) AS field_size,
        -- weather_code / going_wetness / grade_code_idx: best-effort integer
        -- encodings of the raw VARCHAR/flag columns. NULL-safe.
        CASE
            WHEN b.weather IS NULL THEN NULL
            WHEN regexp_matches(CAST(b.weather AS VARCHAR), '^\\d+$')
                THEN CAST(b.weather AS INTEGER)
            ELSE 0
        END AS weather_code,
        CASE
            WHEN b.grade_code IS NULL THEN 0
            WHEN regexp_matches(CAST(b.grade_code AS VARCHAR), '^\\d+$')
                THEN CAST(b.grade_code AS INTEGER)
            WHEN b.grade_code IN ('G1', 'g1') THEN 5
            WHEN b.grade_code IN ('G2', 'g2') THEN 4
            WHEN b.grade_code IN ('G3', 'g3') THEN 3
            WHEN b.grade_code IN ('OP', 'op', 'L') THEN 2
            ELSE 1
        END AS grade_code_idx,
        CASE
            WHEN b.race_name IS NOT NULL AND (
                regexp_matches(CAST(b.race_name AS VARCHAR), '(?i)(grade|g[123]|stakes|cup|記念|賞|sprint|derby|hope|hanshin|nakayama|tokyo|chukyo)')
            ) THEN 1 ELSE 0
        END AS is_filtered_name_match,
        m.pred_time_seconds,
        g.going_perf_delta_z,
        g.going_fit_z,
        tr.training_last_1f_recent,
        tr.training_last_1f_accel,
        tr.training_days_since_work,
        m.mining_available_at,
        g.going_max_available_at,
        tr.training_max_available_at
    FROM base b
    LEFT JOIN field_size_cte fs ON fs.race_id = b.race_id
    LEFT JOIN mining m
      ON m.race_id = b.race_id
     AND m.horse_number = b.horse_number
    LEFT JOIN going g
      ON g.race_id = b.race_id
     AND g.horse_number = b.horse_number
    LEFT JOIN training tr
      ON tr.race_id = b.race_id
     AND tr.horse_number = b.horse_number
)
SELECT
    f.race_id,
    f.horse_id,
    f.horse_number,
    f.as_of_time,
    GREATEST(
        f.max_source_available_at,
        COALESCE(f.mining_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
        COALESCE(f.going_max_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
        COALESCE(f.training_max_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00')
    ) AS max_source_available_at,
    f.race_date,
    f.racecourse,
    f.surface,
    f.distance_m,
    f.weather,
    f.grade_code,
    f.going_wetness,
    f.field_size,
    f.gate,
    f.carried_weight_kg,
    f.body_weight_kg,
    f.age_years,
    f.surface_turf,
    f.weather_code,
    f.grade_code_idx,
    f.is_filtered_name_match,
    f.last_finish_pos,
    f.last_finish_time_sec,
    f.last_last_3f_sec,
    f.avg_finish_pos_5,
    f.avg_finish_time_sec_5,
    f.wins_last_10,
    f.starts_last_10,
    f.starts_last_365d,
    f.days_since_last_race,
    f.finish_time_par_delta,
    f.last_3f_par_delta,
    f.trainer_winrate_365d,
    f.trainer_top3rate_365d,
    f.trainer_starts_365d,
    f.jockey_winrate_365d,
    f.jockey_top3rate_365d,
    f.jockey_starts_365d,
    f.trainer_jockey_combo_winrate_365d,
    f.trainer_jockey_combo_starts_365d,
    f.jockey_track_winrate_365d,
    f.jockey_track_starts_365d,
    f.body_weight_delta_vs_last,
    f.pred_time_seconds,
    f.going_perf_delta_z,
    f.going_fit_z,
    f.training_last_1f_recent,
    f.training_last_1f_accel,
    f.training_days_since_work,
    f.year,
    f.venue
FROM folded f
ORDER BY f.race_id, f.horse_number NULLS LAST, f.horse_id
"""


def _ts_sql(expr: str) -> str:
    """DuckDB expression that accepts typed, ISO, and compact JRA timestamps."""
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


# ----------------------------------------------------------------------------
# Leakage / market-blind guards
# ----------------------------------------------------------------------------

_MARKET_DERIVED_COLUMNS = {
    "win_odds",
    "place_odds",
    "raw_implied_prob",
    "devigged_market_prob",
    "calibrated_market_prob",
    "market_beta",
    "market_implied_prob",
    "market_implied_rank",
    "popularity",
    "odds_drift",
    "odds_velocity",
    "market_rank",
    "market_log_prob",
}


def _assert_no_leakage(records: list[dict]) -> None:
    """Mirror ``market_baseline._assert_no_leakage``: every row's
    ``max_source_available_at`` must be ``<= as_of_time``."""
    leaked = [
        (r["race_id"], r["horse_id"], r["max_source_available_at"], r["as_of_time"])
        for r in records
        if r.get("max_source_available_at") and r["as_of_time"]
        and r["max_source_available_at"] > r["as_of_time"]
    ]
    if leaked:
        race_id, horse_id, available_at, as_of_time = leaked[0]
        raise ValueError(
            "handicap feature leakage: "
            f"{race_id}/{horse_id} used {available_at!r} after as_of_time {as_of_time!r}"
        )


def _assert_no_market_features(records: list[dict]) -> None:
    """Audit guard: the gold must not carry odds/market-derived columns.

    The fundamental model is market-blind by design. If a future refactor adds
    any column from ``_MARKET_DERIVED_COLUMNS`` to the write, raise before the
    gold is polluted.
    """
    if not records:
        return
    cols = set(records[0].keys())
    violators = cols & _MARKET_DERIVED_COLUMNS
    if violators:
        raise ValueError(
            "handicap feature set must be market-blind; found market-derived "
            f"columns: {sorted(violators)}"
        )


if __name__ == "__main__":
    print(json.dumps({HANDICAP_FEATURE_SET: build_handicap_features(LakePaths())}, indent=2))
