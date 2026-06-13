"""Build point-in-time going-handling features from JRA-VAN silver tables.

The core signal is deliberately field-relative: raw race times move with track
speed, so history is normalized inside each race before any wet-vs-firm delta is
estimated. All rolling history is computed in DuckDB over Parquet datasets; the
Python side only validates and writes the resulting gold table.
"""
from __future__ import annotations

import json
from pathlib import Path

from keibamon_core import lake_query
from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths

GOING_FEATURE_SET = "going_handling"
PLACEHOLDER_HORSE_ID = "0000000000"


def build_going_features(lake: LakePaths) -> int:
    """Materialize per-runner PIT going-handling features.

    Output rows are keyed by ``(race_id, horse_id, horse_number)`` and carry
    ``as_of_time`` plus ``max_source_available_at`` so the existing leakage guard
    can verify that every upstream input was available at decision time.
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
        odds=lake.silver_dataset("jravan_win_place_odds"),
        pedigree=lake.silver_dataset("jravan_horse_pedigree"),
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
    write_dataset(records, lake.gold_dataset(GOING_FEATURE_SET))
    return len(records)


def _feature_sql(
    *,
    races: Path,
    entries: Path,
    results: Path,
    odds: Path,
    pedigree: Path,
) -> str:
    race_date_ts = _ts_sql("race_date")
    scheduled_post_ts = _ts_sql("scheduled_post_time")
    race_available_ts = _ts_sql("available_at")
    entry_available_ts = _ts_sql("available_at")
    result_available_ts = _ts_sql("available_at")
    odds_available_ts = _ts_sql("available_at")
    odds_cte = (
        f"SELECT * FROM {lake_query.src(odds)}"
        if odds.exists()
        else """
        SELECT
            NULL::VARCHAR AS race_id,
            NULL::VARCHAR AS bet_type,
            NULL::VARCHAR AS combo,
            NULL::DOUBLE AS odds,
            NULL::TIMESTAMPTZ AS available_at
        WHERE false
        """
    )
    pedigree_cte = (
        f"SELECT horse_id, sire_id FROM {lake_query.src(pedigree)}"
        if pedigree.exists()
        else """
        SELECT NULL::VARCHAR AS horse_id, NULL::VARCHAR AS sire_id
        WHERE false
        """
    )

    # Finish percentile is the going-neutral performance metric:
    # winner ~= 1, tail ~= 0, independent of how slow the surface made the race.
    return f"""
WITH
races AS (
    SELECT
        race_id,
        {race_date_ts} AS race_date,
        COALESCE(
            {scheduled_post_ts},
            {race_date_ts}
        ) AS as_of_time,
        surface,
        distance_m,
        going_wetness,
        going,
        weather,
        {race_available_ts} AS race_available_at,
        year,
        venue
    FROM {lake_query.src(races)}
),
entries AS (
    SELECT
        race_id,
        horse_id,
        horse_number,
        gate,
        jockey_id,
        trainer_id,
        carried_weight_kg,
        {entry_available_ts} AS entry_available_at
    FROM {lake_query.src(entries)}
),
results AS (
    SELECT
        race_id,
        horse_id,
        finish_position,
        finish_time_seconds,
        {result_available_ts} AS result_available_at
    FROM {lake_query.src(results)}
),
pedigree AS ({pedigree_cte}),
odds AS ({odds_cte}),
race_perf AS (
    SELECT
        rr.race_id,
        rr.horse_id,
        ra.race_date,
        ra.surface,
        ra.going_wetness,
        rr.finish_position,
        rr.result_available_at,
        CASE
            WHEN rr.finish_position IS NULL THEN NULL
            WHEN COUNT(rr.finish_position) OVER (PARTITION BY rr.race_id) <= 1 THEN 1.0
            ELSE
                1.0 - (
                    CAST(rr.finish_position - 1 AS DOUBLE)
                    / NULLIF(COUNT(rr.finish_position) OVER (PARTITION BY rr.race_id) - 1, 0)
                )
        END AS going_neutral_perf
    FROM results rr
    JOIN races ra USING (race_id)
    WHERE ra.surface IN ('turf', 'dirt')
      AND ra.going_wetness IS NOT NULL
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
        ra.race_date,
        ra.as_of_time,
        ra.surface,
        ra.distance_m,
        ra.going_wetness,
        ra.going,
        ra.weather,
        ra.race_available_at,
        en.entry_available_at,
        ra.year,
        ra.venue
    FROM races ra
    JOIN entries en USING (race_id)
    WHERE ra.surface IN ('turf', 'dirt')
      AND ra.going_wetness IS NOT NULL
      AND ra.race_available_at <= ra.as_of_time
      AND en.entry_available_at <= ra.as_of_time
),
horse_hist AS (
    SELECT
        t.race_id,
        t.horse_id,
        t.horse_number,
        COUNT(h.going_neutral_perf) AS prior_going_runs,
        SUM(CASE WHEN abs(h.going_wetness - t.going_wetness) <= 1 THEN 1 ELSE 0 END)
            AS going_runs_similar,
        AVG(CASE WHEN h.going_wetness >= 3 THEN h.going_neutral_perf END) AS wet_perf,
        AVG(CASE WHEN h.going_wetness <= 2 THEN h.going_neutral_perf END) AS firm_perf,
        AVG(h.going_neutral_perf) AS all_perf,
        SUM(CASE WHEN h.going_wetness >= 3 THEN 1 ELSE 0 END) AS wet_runs,
        SUM(CASE WHEN h.going_wetness <= 2 THEN 1 ELSE 0 END) AS firm_runs,
        SUM(
            CASE
                WHEN abs(h.going_wetness - t.going_wetness) <= 1
                 AND h.finish_position = 1 THEN 1
                ELSE 0
            END
        ) AS similar_wins,
        SUM(
            CASE
                WHEN abs(h.going_wetness - t.going_wetness) <= 1
                 AND h.finish_position <= 3 THEN 1
                ELSE 0
            END
        ) AS similar_top3,
        MAX(h.result_available_at) AS max_history_available_at
    FROM target t
    LEFT JOIN race_perf h
      ON h.horse_id = t.horse_id
     AND t.horse_id <> '{PLACEHOLDER_HORSE_ID}'
     AND h.surface = t.surface
     AND h.race_date < t.race_date
     AND h.result_available_at <= t.as_of_time
    GROUP BY t.race_id, t.horse_id, t.horse_number
),
sire_hist AS (
    SELECT
        t.race_id,
        t.horse_id,
        t.horse_number,
        AVG(CASE WHEN h.going_wetness >= 3 THEN h.going_neutral_perf END)
          - AVG(CASE WHEN h.going_wetness <= 2 THEN h.going_neutral_perf END)
          AS sire_going_affinity,
        COUNT(h.going_neutral_perf) AS sire_going_runs,
        MAX(h.result_available_at) AS max_sire_available_at
    FROM target t
    LEFT JOIN pedigree tp
      ON tp.horse_id = t.horse_id
    LEFT JOIN pedigree hp
      ON hp.sire_id = tp.sire_id
     AND hp.horse_id <> t.horse_id
    LEFT JOIN race_perf h
      ON h.horse_id = hp.horse_id
     AND h.surface = t.surface
     AND h.race_date < t.race_date
     AND h.result_available_at <= t.as_of_time
    GROUP BY t.race_id, t.horse_id, t.horse_number
),
latest_win_odds AS (
    SELECT race_id, combo, odds, available_at
    FROM (
        SELECT
            race_id,
            combo,
            odds,
            {odds_available_ts} AS available_at,
            ROW_NUMBER() OVER (
                PARTITION BY race_id, combo
                ORDER BY {odds_available_ts} DESC NULLS LAST
            ) AS rn
        FROM odds
        WHERE bet_type = 'win'
          AND odds IS NOT NULL
    )
    WHERE rn = 1
),
base AS (
    SELECT
        t.*,
        hh.prior_going_runs,
        hh.going_runs_similar,
        hh.wet_runs,
        hh.firm_runs,
        COALESCE(sh.sire_going_affinity, 0.0) AS sire_going_affinity,
        COALESCE(sh.sire_going_runs, 0) AS sire_going_runs,
        CASE
            WHEN hh.wet_perf IS NOT NULL AND hh.firm_perf IS NOT NULL
                THEN hh.wet_perf - hh.firm_perf
            ELSE 0.0
        END AS raw_going_delta,
        CASE
            WHEN COALESCE(hh.wet_runs, 0) + COALESCE(hh.firm_runs, 0) = 0
                THEN COALESCE(sh.sire_going_affinity, 0.0) * 0.25
            ELSE (
                (
                    CASE
                        WHEN hh.wet_perf IS NOT NULL AND hh.firm_perf IS NOT NULL
                            THEN hh.wet_perf - hh.firm_perf
                        ELSE 0.0
                    END
                    * (COALESCE(hh.wet_runs, 0) + COALESCE(hh.firm_runs, 0))
                ) + COALESCE(sh.sire_going_affinity, 0.0) * 2.0
            ) / (COALESCE(hh.wet_runs, 0) + COALESCE(hh.firm_runs, 0) + 6.0)
        END AS going_perf_delta,
        CASE
            WHEN COALESCE(hh.going_runs_similar, 0) = 0 THEN NULL
            ELSE (COALESCE(hh.similar_wins, 0) + 0.5) / (hh.going_runs_similar + 2.0)
        END AS going_winrate,
        CASE
            WHEN COALESCE(hh.going_runs_similar, 0) = 0 THEN NULL
            ELSE (COALESCE(hh.similar_top3, 0) + 1.5) / (hh.going_runs_similar + 3.0)
        END AS going_top3rate,
        hh.max_history_available_at,
        sh.max_sire_available_at,
        owo.odds AS win_odds,
        CASE WHEN owo.odds IS NOT NULL AND owo.odds > 0 THEN 1.0 / owo.odds END
            AS raw_implied_prob,
        owo.available_at AS odds_available_at
    FROM target t
    LEFT JOIN horse_hist hh
      ON hh.race_id = t.race_id
     AND hh.horse_id = t.horse_id
     AND COALESCE(hh.horse_number, -1) = COALESCE(t.horse_number, -1)
    LEFT JOIN sire_hist sh
      ON sh.race_id = t.race_id
     AND sh.horse_id = t.horse_id
     AND COALESCE(sh.horse_number, -1) = COALESCE(t.horse_number, -1)
    LEFT JOIN latest_win_odds owo
      ON owo.race_id = t.race_id
     AND CAST(owo.combo AS INTEGER) = t.horse_number
     AND (owo.available_at IS NULL OR owo.available_at <= t.as_of_time)
),
scored AS (
    SELECT
        *,
        going_perf_delta * ((going_wetness - 2.0) / 2.0) AS going_fit,
        raw_implied_prob / NULLIF(SUM(raw_implied_prob) OVER (PARTITION BY race_id), 0)
            AS market_implied_prob,
        ROW_NUMBER() OVER (
            PARTITION BY race_id
            ORDER BY raw_implied_prob DESC NULLS LAST, horse_number
        ) AS market_rank
    FROM base
),
within_race AS (
    SELECT
        *,
        CASE
            WHEN STDDEV_SAMP(going_fit) OVER (PARTITION BY race_id) IS NULL
              OR STDDEV_SAMP(going_fit) OVER (PARTITION BY race_id) = 0 THEN 0.0
            ELSE (going_fit - AVG(going_fit) OVER (PARTITION BY race_id))
               / STDDEV_SAMP(going_fit) OVER (PARTITION BY race_id)
        END AS going_fit_z,
        CASE
            WHEN STDDEV_SAMP(going_perf_delta) OVER (PARTITION BY race_id) IS NULL
              OR STDDEV_SAMP(going_perf_delta) OVER (PARTITION BY race_id) = 0 THEN 0.0
            ELSE (going_perf_delta - AVG(going_perf_delta) OVER (PARTITION BY race_id))
               / STDDEV_SAMP(going_perf_delta) OVER (PARTITION BY race_id)
        END AS going_perf_delta_z,
        ROW_NUMBER() OVER (
            PARTITION BY race_id
            ORDER BY going_fit DESC NULLS LAST, horse_number
        ) AS going_fit_rank,
        COUNT(*) OVER (PARTITION BY race_id) AS field_size
    FROM scored
)
SELECT
    race_id,
    horse_id,
    horse_number,
    as_of_time,
    GREATEST(
        race_available_at,
        entry_available_at,
        COALESCE(max_history_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
        COALESCE(max_sire_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00'),
        COALESCE(odds_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00')
    ) AS max_source_available_at,
    surface,
    distance_m,
    going_wetness,
    going,
    weather,
    gate,
    carried_weight_kg,
    field_size,
    COALESCE(prior_going_runs, 0) AS prior_going_runs,
    COALESCE(going_runs_similar, 0) AS going_runs_similar,
    COALESCE(wet_runs, 0) AS going_wet_runs,
    COALESCE(firm_runs, 0) AS going_firm_runs,
    raw_going_delta,
    going_perf_delta,
    going_perf_delta_z,
    going_fit,
    going_fit_z,
    going_fit_rank,
    going_winrate,
    going_top3rate,
    sire_going_affinity,
    sire_going_runs,
    win_odds,
    market_implied_prob,
    CASE
        WHEN field_size <= 1 OR market_rank IS NULL THEN NULL
        ELSE 1.0 - ((market_rank - 1.0) / (field_size - 1.0))
    END AS market_implied_rank,
    going_fit_z - COALESCE(
        CASE
            WHEN field_size <= 1 OR market_rank IS NULL THEN NULL
            ELSE 1.0 - ((market_rank - 1.0) / (field_size - 1.0))
        END,
        0.0
    ) AS going_market_disagreement,
    going_fit * (distance_m / 1600.0) AS going_distance_interaction,
    going_fit * COALESCE(gate, horse_number) AS going_draw_interaction,
    horse_id = '{PLACEHOLDER_HORSE_ID}' OR COALESCE(prior_going_runs, 0) = 0
        AS missing_going_history,
    year,
    venue
FROM within_race
ORDER BY race_id, horse_number NULLS LAST, horse_id
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


def _assert_no_leakage(records: list[dict]) -> None:
    leaked = [
        (r["race_id"], r["horse_id"], r["max_source_available_at"], r["as_of_time"])
        for r in records
        if r["max_source_available_at"] and r["max_source_available_at"] > r["as_of_time"]
    ]
    if leaked:
        race_id, horse_id, available_at, as_of_time = leaked[0]
        raise ValueError(
            "going feature leakage: "
            f"{race_id}/{horse_id} used {available_at!r} after as_of_time {as_of_time!r}"
        )


if __name__ == "__main__":
    print(json.dumps({"going_handling": build_going_features(LakePaths())}, indent=2))
