"""Build point-in-time training-time features from the jravan_training silver table.

Sharp JRA bettors weight final-furlong gallop times (坂路/ウッドチップ調教). This
module joins per-horse training works — available strictly before each race's
post time — to race entries, producing per-(race, horse) features: most-recent
last-1F, acceleration vs the prior work, best recent work, days since, volume.

PIT correctness is non-negotiable: only works with ``available_at <= race
as_of_time`` are used. ``max_source_available_at`` is emitted for the leakage
guard (``_assert_no_leakage``).
"""
from __future__ import annotations

import json
from pathlib import Path

from keibamon_core import lake_query
from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths

TRAINING_FEATURE_SET = "training"
PLACEHOLDER_HORSE_ID = "0000000000"


def build_training_features(lake: LakePaths) -> int:
    """Materialize per-runner PIT training-time features.

    Output rows are keyed by ``(race_id, horse_id, horse_number)`` and carry
    ``as_of_time`` plus ``max_source_available_at`` for the leakage guard.
    Horses with no training works in the 30-day window get NULL features
    (correct — no recent training signal).
    """
    races = lake.silver_dataset("jravan_races")
    entries = lake.silver_dataset("jravan_race_entries")
    training = lake.silver_dataset("jravan_training")
    if not races.exists() or not entries.exists() or not training.exists():
        return 0

    sql = _feature_sql(races=races, entries=entries, training=training)
    con = lake_query.connect()
    try:
        table = lake_query._to_arrow(con.execute(sql))  # noqa: SLF001 - local compat shim
    finally:
        con.close()

    records = table.to_pylist()
    if not records:
        return 0
    _assert_no_leakage(records)
    write_dataset(records, lake.gold_dataset(TRAINING_FEATURE_SET))
    return len(records)


def _feature_sql(*, races: Path, entries: Path, training: Path) -> str:
    race_date_ts = _ts_sql("race_date")
    scheduled_post_ts = _ts_sql("scheduled_post_time")
    race_available_ts = _ts_sql("available_at")
    entry_available_ts = _ts_sql("available_at")
    training_available_ts = _ts_sql("available_at")
    return f"""
WITH
races AS (
    SELECT
        race_id,
        {race_date_ts} AS race_date,
        COALESCE({scheduled_post_ts}, {race_date_ts}) AS as_of_time,
        {race_available_ts} AS race_available_at,
        year, venue
    FROM {lake_query.src(races)}
),
entries AS (
    SELECT
        race_id,
        horse_id,
        horse_number,
        {entry_available_ts} AS entry_available_at
    FROM {lake_query.src(entries)}
),
target AS (
    SELECT
        ra.race_id,
        en.horse_id,
        en.horse_number,
        ra.race_date,
        ra.as_of_time,
        ra.race_available_at,
        en.entry_available_at,
        ra.year,
        ra.venue
    FROM races ra
    JOIN entries en USING (race_id)
    WHERE ra.race_available_at <= ra.as_of_time
      AND en.entry_available_at <= ra.as_of_time
      AND en.horse_id <> '{PLACEHOLDER_HORSE_ID}'
),
-- PIT-validated training works within the 30-day window before each race.
works AS (
    SELECT
        t.race_id,
        t.horse_id,
        t.horse_number,
        t.as_of_time,
        t.race_date,
        t.year,
        t.venue,
        tr.last_1f,
        tr.course_type,
        tr.center,
        tr.training_date,
        {training_available_ts} AS training_available_at,
        DATE_DIFF(
            'day',
            CAST(tr.training_date AS DATE),
            CAST({race_date_ts} AS DATE)
        ) AS days_before_race,
        ROW_NUMBER() OVER (
            PARTITION BY t.race_id, t.horse_id
            ORDER BY {training_available_ts} DESC NULLS LAST
        ) AS rn_recent
    FROM target t
    JOIN {lake_query.src(training)} tr
      ON tr.horse_id = t.horse_id
     AND {training_available_ts} <= t.as_of_time
     AND {training_available_ts} >= t.as_of_time - INTERVAL '30 days'
     AND tr.last_1f IS NOT NULL
),
aggregated AS (
    SELECT
        race_id,
        horse_id,
        horse_number,
        as_of_time,
        race_date,
        year,
        venue,
        MAX(CASE WHEN rn_recent = 1 THEN last_1f END)
            AS training_last_1f_recent,
        MAX(CASE WHEN rn_recent = 1 THEN course_type END)
            AS training_course_type,
        MAX(CASE WHEN rn_recent = 1 THEN days_before_race END)
            AS training_days_since_work,
        MAX(CASE WHEN rn_recent = 2 THEN last_1f END)
            AS training_last_1f_prior,
        MIN(last_1f) AS training_last_1f_best_30d,
        COUNT(*) AS training_works_count_30d,
        MAX(training_available_at) AS max_training_available_at
    FROM works
    GROUP BY race_id, horse_id, horse_number, as_of_time, race_date, year, venue
)
SELECT
    t.race_id,
    t.horse_id,
    t.horse_number,
    t.as_of_time,
    GREATEST(
        t.race_available_at,
        t.entry_available_at,
        COALESCE(a.max_training_available_at, TIMESTAMPTZ '1900-01-01 00:00:00+00')
    ) AS max_source_available_at,
    t.race_date,
    a.training_last_1f_recent,
    a.training_last_1f_prior,
    CASE
        WHEN a.training_last_1f_recent IS NOT NULL
         AND a.training_last_1f_prior IS NOT NULL
        THEN a.training_last_1f_recent - a.training_last_1f_prior
    END AS training_last_1f_accel,
    a.training_last_1f_best_30d,
    a.training_days_since_work,
    a.training_course_type,
    COALESCE(a.training_works_count_30d, 0) AS training_works_count_30d,
    t.year,
    t.venue
FROM target t
LEFT JOIN aggregated a
  ON a.race_id = t.race_id
 AND a.horse_id = t.horse_id
 AND COALESCE(a.horse_number, -1) = COALESCE(t.horse_number, -1)
ORDER BY t.race_id, t.horse_number NULLS LAST, t.horse_id
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
        if r.get("max_source_available_at") and r["max_source_available_at"] > r["as_of_time"]
    ]
    if leaked:
        race_id, horse_id, available_at, as_of_time = leaked[0]
        raise ValueError(
            "training feature leakage: "
            f"{race_id}/{horse_id} used {available_at!r} after as_of_time {as_of_time!r}"
        )


if __name__ == "__main__":
    print(json.dumps({TRAINING_FEATURE_SET: build_training_features(LakePaths())}, indent=2))
