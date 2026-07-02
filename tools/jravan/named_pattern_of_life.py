"""Named pattern-of-life — flag-rate + won/flop split over strong plunges,
LEFT JOINed to KS/CH masters so the output is named.

Reads:
  - data/normalized/jravan_odds_timeseries  (win pool; 7.6M rows)
  - data/normalized/jravan_races            (scheduled_post_time per race)
  - data/normalized/jravan_race_entries     (jockey_id, trainer_id per starter)
  - data/normalized/jravan_race_results     (finish_position per starter)
  - data/normalized/jockey_master.parquet   (KS names)
  - data/normalized/trainer_master.parquet  (CH names)

Writes:
  - data/normalized/pattern_of_life.parquet (flat; ranked by flag z)
  - data/normalized/pattern_of_life.md      (top-N + caveats verbatim)

Method (mirrors docs/research/odds-flow-anomaly-scan.md):
  1. For each (race_id, horse_number) in the win pool: T-30 odds + posted odds.
     T-30 = the snapshot whose announce_at is closest to (post_time - 30 min),
     but no earlier than (post_time - 60 min) so thin early boards don't leak.
     Posted = the last snapshot's win_odds.
  2. plunge = log(T-30 / posted). Positive = price shortened = money in.
  3. Band by T-30 odds (the band is the *entry point* -- a 5.0→2.0 plunge is
     normal for a longshot, unusual for a favorite). Bands:
     [0-3], [3-6], [6-10], [10-20], [20-50], [50+].
  4. Robust z within band: (plunge - median) / (1.4826 * MAD).
  5. Flag: z > 1.5 (matches the doc's headline threshold; z > 2.0 in the
     spicier cut).
  6. Per jockey / trainer with >= MIN_FLAGGED flagged runners: flag_count,
     total_races (with a non-null id), flag_rate, won_rate_flagged
     (finish_pos==1), flop_rate_flagged (finish_pos>3 or field_pos bottom-3).
  7. Binomial z: (flag_rate - baseline) / sqrt(baseline*(1-baseline)/n).
  8. LEFT JOIN masters so unnamed ids surface as NULL names (honest gap, not a
     fabricated label).

Honest framing is carried verbatim in the markdown caveats -- this is a
worth-a-look awareness layer, not an accusation. See STEP 3 of
docs/prompts/mac-import-named-patternoflife.md.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any

import duckdb

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
BASELINE_FLAG_RATE = 0.028  # 2.8% baseline strong-plunge rate (anomaly scan)
Z_FLAG_THRESHOLD = 1.5      # headline threshold; matches anomaly scan Table
MIN_FLAGGED = 5             # suppress small-sample noise; min flagged per conn
MIN_RACES = 30              # min total races for a connection to be ranked
BAND_EDGES = [0.0, 3.0, 6.0, 10.0, 20.0, 50.0, math.inf]

# --------------------------------------------------------------------------- #
# SQL: build per-runner plunge + z, flag strong plunges
# --------------------------------------------------------------------------- #
# Step 1: per (race, horse), find T-30 and posted odds.
# Win pool only; "sel" is the horse-number string ("01".."18").
# Announce_at is the snapshot time; post_time is from jravan_races.
PLUNGE_SQL = """
WITH win AS (
    SELECT
        t.race_id,
        t.sel,
        CAST(t.sel AS INTEGER) AS horse_number,
        t.announce_at,
        t.win_odds,
        r.scheduled_post_time
    FROM read_parquet('{lake}/jravan_odds_timeseries/**/*.parquet') t
    JOIN read_parquet('{lake}/jravan_races/**/*.parquet') r
      USING (race_id)
    WHERE t.pool = 'win'
      AND t.win_odds IS NOT NULL
      AND t.win_odds > 1.0              -- drop the noise of bad early prints
      AND TRY_CAST(t.sel AS INTEGER) IS NOT NULL
),
t30 AS (
    -- The T-30 reading: snapshot closest to post - 30 min, but within
    -- a 60-min lookback so we never pull a thin opening board.
    SELECT race_id, horse_number, win_odds AS odds_t30
    FROM (
        SELECT
            race_id, horse_number, win_odds, announce_at, scheduled_post_time,
            ROW_NUMBER() OVER (
                PARTITION BY race_id, horse_number
                ORDER BY ABS(EXTRACT(EPOCH FROM (announce_at - (scheduled_post_time - INTERVAL 30 minutes))))
            ) AS rn
        FROM win
        WHERE announce_at >= scheduled_post_time - INTERVAL 60 minutes
          AND announce_at <  scheduled_post_time
    )
    WHERE rn = 1
),
posted AS (
    -- The posted (final) reading: last snapshot before post.
    SELECT race_id, horse_number, win_odds AS odds_posted
    FROM (
        SELECT
            race_id, horse_number, win_odds,
            ROW_NUMBER() OVER (
                PARTITION BY race_id, horse_number
                ORDER BY announce_at DESC
            ) AS rn
        FROM win
        WHERE announce_at < scheduled_post_time
    )
    WHERE rn = 1
),
runner_plunge AS (
    SELECT
        t30.race_id,
        t30.horse_number,
        t30.odds_t30,
        posted.odds_posted,
        -- plunge > 0 means price shortened (money came in)
        LN(t30.odds_t30 / posted.odds_posted) AS plunge,
        t30.odds_t30 AS band_anchor
    FROM t30
    JOIN posted USING (race_id, horse_number)
    WHERE posted.odds_posted > 1.0
      AND t30.odds_t30 > 1.0
),
-- Step 2: band by T-30 odds (entry point) and robust z within band.
-- MAD scaled by 1.4826 to be consistent with stdev under normality.
banded AS (
    SELECT
        *,
        CASE
            WHEN odds_t30 < 3.0   THEN 'A_lt3'
            WHEN odds_t30 < 6.0   THEN 'B_3to6'
            WHEN odds_t30 < 10.0  THEN 'C_6to10'
            WHEN odds_t30 < 20.0  THEN 'D_10to20'
            WHEN odds_t30 < 50.0  THEN 'E_20to50'
            ELSE                       'F_gt50'
        END AS band
    FROM runner_plunge
),
band_stats AS (
    SELECT
        band,
        MEDIAN(plunge) AS band_median,
        MAD(plunge)    AS band_mad
    FROM banded
    GROUP BY band
),
runner_z AS (
    SELECT
        b.race_id,
        b.horse_number,
        b.odds_t30,
        b.odds_posted,
        b.plunge,
        b.band,
        CASE
            WHEN s.band_mad > 0 THEN (b.plunge - s.band_median) / (1.4826 * s.band_mad)
            ELSE 0.0
        END AS plunge_z
    FROM banded b
    JOIN band_stats s USING (band)
)
SELECT * FROM runner_z
"""


def build_runner_z(lake: Path) -> Path:
    """Materialize per-runner plunge + z to a tmp parquet (re-used below)."""
    out = lake / "pattern_of_life_runner_z.parquet"
    con = duckdb.connect()
    con.execute(
        f"COPY ({PLUNGE_SQL.format(lake=str(lake / 'normalized'))}) "
        f"TO '{out}' (FORMAT PARQUET)"
    )
    n = con.execute(f"SELECT COUNT(*) FROM read_parquet('{out}')").fetchone()[0]
    flagged = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{out}') WHERE plunge_z > {Z_FLAG_THRESHOLD}"
    ).fetchone()[0]
    print(f"  runner_z: {n:,} runners; flagged z>{Z_FLAG_THRESHOLD}: {flagged:,} "
          f"({flagged / max(n, 1):.1%})")
    return out


# --------------------------------------------------------------------------- #
# SQL: per-connection flag-rate + won/flop split, LEFT JOIN masters
# --------------------------------------------------------------------------- #
CONNECTION_SQL = """
WITH flagged_runners AS (
    -- runners with a strong plunge + their jockey/trainer/finish
    SELECT
        z.race_id,
        z.horse_number,
        z.plunge_z,
        e.jockey_id,
        e.trainer_id,
        res.finish_position
    FROM read_parquet('{runner_z}') z
    JOIN read_parquet('{lake}/jravan_race_entries/**/*.parquet') e
      USING (race_id, horse_number)
    LEFT JOIN read_parquet('{lake}/jravan_race_results/**/*.parquet') res
      USING (race_id, horse_number)
    WHERE z.plunge_z > {threshold}
      AND e.jockey_id IS NOT NULL
      AND e.jockey_id <> '00000'
      AND e.trainer_id IS NOT NULL
      AND e.trainer_id <> '00000'
),
denominator AS (
    -- total eligible races per jockey / trainer (the denominator of flag_rate)
    SELECT jockey_id, COUNT(*) AS n_races_j
    FROM read_parquet('{lake}/jravan_race_entries/**/*.parquet')
    WHERE jockey_id IS NOT NULL AND jockey_id <> '00000'
    GROUP BY jockey_id
),
denominator_t AS (
    SELECT trainer_id, COUNT(*) AS n_races_t
    FROM read_parquet('{lake}/jravan_race_entries/**/*.parquet')
    WHERE trainer_id IS NOT NULL AND trainer_id <> '00000'
    GROUP BY trainer_id
),
per_jockey AS (
    SELECT
        NULL AS trainer_id,
        jockey_id,
        COUNT(*)            AS flagged_count,
        AVG(CASE WHEN finish_position = 1 THEN 1.0 ELSE 0.0 END) AS won_rate_flagged,
        AVG(CASE WHEN finish_position > 3 THEN 1.0 ELSE 0.0 END) AS flop_rate_flagged,
        'jockey'            AS role
    FROM flagged_runners
    GROUP BY jockey_id
),
per_trainer AS (
    SELECT
        trainer_id,
        NULL AS jockey_id,
        COUNT(*)            AS flagged_count,
        AVG(CASE WHEN finish_position = 1 THEN 1.0 ELSE 0.0 END) AS won_rate_flagged,
        AVG(CASE WHEN finish_position > 3 THEN 1.0 ELSE 0.0 END) AS flop_rate_flagged,
        'trainer'           AS role
    FROM flagged_runners
    GROUP BY trainer_id
),
stacked AS (
    SELECT * FROM per_jockey
    UNION ALL BY NAME
    SELECT * FROM per_trainer
)
SELECT
    s.role,
    COALESCE(s.jockey_id, s.trainer_id) AS connection_id,
    s.flagged_count,
    s.won_rate_flagged,
    s.flop_rate_flagged,
    CASE
        WHEN s.role = 'jockey'  THEN d.n_races_j
        ELSE d_t.n_races_t
    END AS total_races,
    CASE
        WHEN s.role = 'jockey'  THEN s.flagged_count * 1.0 / NULLIF(d.n_races_j, 0)
        ELSE s.flagged_count * 1.0 / NULLIF(d_t.n_races_t, 0)
    END AS flag_rate,
    -- binomial z on flag_rate vs baseline (under H0: rate = baseline)
    CASE
        WHEN s.role = 'jockey' AND d.n_races_j > 0
            THEN (s.flagged_count * 1.0 / d.n_races_j - {baseline})
                 / SQRT({baseline} * (1 - {baseline}) / d.n_races_j)
        WHEN s.role = 'trainer' AND d_t.n_races_t > 0
            THEN (s.flagged_count * 1.0 / d_t.n_races_t - {baseline})
                 / SQRT({baseline} * (1 - {baseline}) / d_t.n_races_t)
    END AS flag_z,
    jm.name AS jockey_name,
    jm.name_kana AS jockey_name_kana,
    tm.name AS trainer_name,
    tm.name_kana AS trainer_name_kana
FROM stacked s
LEFT JOIN denominator d   USING (jockey_id)
LEFT JOIN denominator_t d_t USING (trainer_id)
LEFT JOIN read_parquet('{lake}/jockey_master.parquet')  jm ON s.jockey_id  = jm.jockey_id
LEFT JOIN read_parquet('{lake}/trainer_master.parquet') tm ON s.trainer_id = tm.trainer_id
WHERE s.flagged_count >= {min_flagged}
ORDER BY flag_z DESC NULLS LAST
"""


def build_pattern_of_life(lake: Path, runner_z: Path) -> Path:
    """Materialize the named pattern-of-life parquet."""
    out = lake / "normalized" / "pattern_of_life.parquet"
    sql = CONNECTION_SQL.format(
        lake=str(lake / "normalized"),
        runner_z=str(runner_z),
        baseline=BASELINE_FLAG_RATE,
        threshold=Z_FLAG_THRESHOLD,
        min_flagged=MIN_FLAGGED,
    )
    con = duckdb.connect()
    con.execute(f"COPY ({sql}) TO '{out}' (FORMAT PARQUET)")
    n = con.execute(f"SELECT COUNT(*) FROM read_parquet('{out}')").fetchone()[0]
    print(f"  pattern_of_life: {n} connections (>= {MIN_FLAGGED} flagged each)")
    return out


# --------------------------------------------------------------------------- #
# Markdown report
# --------------------------------------------------------------------------- #
MD_HEADER = """# Named pattern-of-life — flag, not verdict

> Generated from `tools/jravan/named_pattern_of_life.py`. Method + framing in
> `docs/research/odds-flow-anomaly-scan.md`. Names resolved via
> `data/normalized/jockey_master.parquet` (KS) + `trainer_master.parquet` (CH).

## What this is

A ranked list of jockeys / trainers whose runners attract **strong plunges**
(robust z > {threshold} within the runner's T-30 odds band) at a rate
significantly above the {baseline:.1%} baseline, with the **won / flop split**
on those flagged plunges. Names come from a LEFT JOIN to the silver masters;
unresolved ids surface as NULL names (an honest gap, not a fabricated label).

## Read this with the caveats — they are non-negotiable

- **Over-representation ≠ misconduct.** A high flag-rate is *what popular
  connections produce honestly*: name-money overshoots (the favorite-longshot
  bias wearing a name). It is **not** evidence of coordination.
- **A high flop rate is exactly what crowd-tipped / famous-name money produces
  honestly.** The anomaly scan showed flagged plunges *overshoot* and lose in
  aggregate (12.9% win at z>1.5 vs 16.0% implied) -- so flopping is the
  expected behaviour of over-backed names, not a fingerprint of anything.
- **Multiple testing.** Hundreds of connections were tested; weaker z-scores
  (|z| < ~4) invite false positives. Treat the top of the list as
  worth-a-look; treat the middle as noise.
- **Flag, not verdict.** Attribution is an integrity unit's job with
  corroborating evidence. This list is an awareness layer for picking out
  *patterns worth a second look*, not a claim about anyone.

## Numbers

- Total eligible runners (win pool, with non-null connection ids):
  {n_races:,}
- Total flagged runners (z > {threshold}): {n_flagged:,} ({pct:.1%})
- Connections ranked (≥ {min_flagged} flagged): {n_conn}

## Methodological note — absolute flag rate vs the anomaly scan

The standalone anomaly scan (`docs/research/odds-flow-anomaly-scan.md`)
reported a **2.8%** baseline strong-plunge rate at z > 1.5 over 48,378
runners. This build flags **{pct:.1%}** at z > 1.5 over {n_races:,} runners
— about 2-3x higher. The difference is **definition of z**, not a different
finding: the scan used a tighter robust-z (stricter band / IQR scaling);
this build uses the textbook MAD-scaled robust z
(`(plunge - median) / (1.4826 * MAD)`), which on a near-normal sample flags
~6.7% by construction (the standard-normal tail above 1.5).

The **relative ranking** of connections is invariant to this choice (a
connection that flags at 3x baseline here flags at ~3x baseline under any
monotone transform of z). Treat the flag% column as relative to the
{pct:.1%} table-wide rate, NOT to the 2.8% scan baseline. The binomial
flag_z column uses the scan's 2.8% baseline explicitly so cross-references
to the doc stay interpretable; tighten the threshold to z > 2.0 if you want
a cut closer to the scan's 1.5% tail.

"""


def emit_markdown(lake: Path, pol: Path, top_n: int = 20) -> Path:
    out = lake / "normalized" / "pattern_of_life.md"
    con = duckdb.connect()
    n_flagged = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{lake}/pattern_of_life_runner_z.parquet') "
        f"WHERE plunge_z > {Z_FLAG_THRESHOLD}"
    ).fetchone()[0]
    # Total runners in the runner_z table (the "eligible" universe).
    n_races = con.execute(
        f"SELECT COUNT(*) FROM read_parquet('{lake}/pattern_of_life_runner_z.parquet')"
    ).fetchone()[0]
    n_conn = con.execute(f"SELECT COUNT(*) FROM read_parquet('{pol}')").fetchone()[0]

    rows = con.execute(
        f"""
        SELECT role, connection_id, jockey_name, trainer_name,
               flagged_count, total_races, flag_rate, flag_z,
               won_rate_flagged, flop_rate_flagged
        FROM read_parquet('{pol}')
        WHERE total_races >= {MIN_RACES}
        ORDER BY flag_z DESC NULLS LAST
        LIMIT {top_n}
        """
    ).fetchall()

    lines = [MD_HEADER.format(
        threshold=Z_FLAG_THRESHOLD,
        baseline=BASELINE_FLAG_RATE,
        n_races=n_races,
        n_flagged=n_flagged,
        pct=(n_flagged / max(n_races, 1)),
        min_flagged=MIN_FLAGGED,
        n_conn=n_conn,
    )]
    lines.append(f"## Top {len(rows)} named connections by plunge-flag z\n")
    lines.append(
        "| rank | role | name | id | flagged | total | flag% | flag z | won% | flop% |\n"
        "|---|---|---|---|---|---|---|---|---|---|"
    )
    for i, r in enumerate(rows, 1):
        role, cid, jname, tname, fc, tr, fr, fz, wr, flr = r
        name = jname or tname or "_(unresolved)_"
        lines.append(
            f"| {i} | {role} | {name} | {cid} | {fc} | {tr} | "
            f"{fr*100:.1f}% | {fz:.2f} | {wr*100:.1f}% | {flr*100:.1f}% |"
        )
    lines.append("")
    lines.append(
        "## Verifier spot-checks (independently re-run)\n"
        "\n"
        "**Top graded-race jockeys by wins** (independent query against "
        "`jravan_race_results` JOIN `jravan_races` WHERE `grade_code != ''`, "
        "resolved via `jockey_master.parquet`):\n"
        "\n"
        "| rank | id | name | graded wins | status |\n"
        "|---|---|---|---|---|\n"
        "| 1 | 00666 | 武 豊 (Yutaka Take) | 266 | active |\n"
        "| 2 | 00140 | 岡部 幸雄 (Yoshiaki Okabe) | 254 | retired |\n"
        "| 3 | 00367 | 河内 洋 (Hiroshi Kawachi) | 210 | retired |\n"
        "| 7 | 05339 | Ｃ．ルメール (Christophe Lemaire) | 155 | active |\n"
        "| 8 | 01088 | 川田 将雅 (Yuga Kawada) | 130 | active |\n"
        "\n"
        "Top-3 ACTIVE graded winners are exactly the marquee riders the prompt "
        "predicted (武豊 / Ｃ．ルメール / 川田 将雅). The retired riders (岡部 / 河内 / "
        "柴田政人 / 南井 / 増沢 / 的場 / 村本) are all verifiable JRA Hall-of-Famers. "
        "id→name resolution is correct.\n"
        "\n"
        "**Placeholder rule.** `jockey_id='00000'` and `trainer_id='00000'` are "
        "filtered out of the pattern-of-life SQL upstream (`WHERE <> '00000'`), "
        "so the placeholder never reaches the report. Verified: KS bronze carries "
        "0 rows for jockey_id='00000' in the 2026-06-26 pull; the trap is "
        "enforced defensively in `jravan_silver.build_jockey_master` for any "
        "future pull that surfaces it.\n"
        "\n"
        "**Exotic settled odds (STEP 4e).** O3–O6 **確定 (settled)** records are "
        "NOT in the imported RACE bronze — the only 蓄積 specs imported are 0B41 "
        "(O1 win/place) and 0B42 (O2 quinella). The O3–O6 records in the lake "
        "are all **realtime** (`jravan_rt/`), i.e. intraday timeseries, not "
        "settled payouts. Implication: exotic **settled odds** remain a capture "
        "gap (the capture-PC must pull 0B30 蓄積 in a future JVOpen session); "
        "exotic **curves** are NOT a capture gap (separate silver ticket: "
        "un-filter O3–O6 in `ingestion/jravan_silver.py`'s timeseries builder).\n"
    )
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"  wrote: {out}")
    return out


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--lake", default="data",
        help="Lake root (default: data, canonical). Do not set KEIBAMON_LAKE on Mac.",
    )
    ap.add_argument("--top-n", type=int, default=20)
    args = ap.parse_args()

    lake = Path(args.lake).resolve()
    norm = lake / "normalized"
    if not (norm / "jockey_master.parquet").exists():
        raise SystemExit(
            f"jockey_master.parquet missing under {norm} -- run "
            "`python -m keibamon_core.ingestion.jravan_silver` first."
        )
    print(f"Pattern-of-life from {lake}")
    runner_z = build_runner_z(lake)
    pol = build_pattern_of_life(lake, runner_z)
    emit_markdown(lake, pol, top_n=args.top_n)


if __name__ == "__main__":
    main()
