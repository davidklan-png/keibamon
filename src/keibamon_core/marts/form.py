"""Horse + jockey form/context mart builder (Milestone 4 lookup).

Recreational form to shape intuition -- NOT an edge claim or tip. See the
package docstring (``keibamon_core.marts``) for the full rationale and the
``app_plan.md`` Guardrails.

What this builds
----------------
Two single-Parquet marts under ``data/marts/``, each ONE ROW PER COMPLETED
START so the read path can point-in-time filter on ``available_at``:

- ``horse_form.parquet``  -- keyed by ``horse_name_key`` (normalized horse
  name; ``horse_id`` is NEVER used as the horse key -- the
  ``'0000000000'`` placeholder trap, see ``adapters.jravan.DATA_TRAPS``).
- ``jockey_form.parquet`` -- keyed by ``jockey_id`` (silver entries already
  carry it; 696 distinct).

Joins are on ``(race_id, horse_number)`` -- the only unique key when horse_id
is the placeholder. Entries are de-duplicated to one row per
``(race_id, horse_number)`` (prefer the JV-Link ``jravan`` source over the
netkeiba scrape so a cross-validated race does not double-count a start).

Point-in-time
-------------
``available_at`` on every row is the start's own event time (post_time if
known else race_date -- see ``jravan_silver._event_at``), NOT the bulk
download time. The API reads these with ``available_at < as_of`` so the target
race and anything after it are excluded; the builder itself is PIT-agnostic
because the filter is applied at read time against any arbitrary target race.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from keibamon_core.adapters.jravan import grade_label
from keibamon_core.lake import write_parquet
from keibamon_core.lake_query import connect, src
from keibamon_core.paths import LakePaths

HORSE_FORM_MART = "horse_form"
JOCKEY_FORM_MART = "jockey_form"

# Distance bands (meters). Coarse, documented, descriptive only -- NOT a
# handicapping claim. JRA races span ~1000m (sprint) to ~3600m (staying).
_DIST_BANDS = ((1400, "sprint"), (1800, "mile"), (2200, "intermediate"))


def normalize_name(name: str | None) -> str | None:
    """Stable horse-name key for joining form to a live runner.

    The live snapshot runner carries a horse NAME but no ``horse_id`` (and
    ``horse_id`` is unsafe anyway -- the ``'0000000000'`` placeholder is
    non-unique). Normalize so display variants of the same name collapse:
    NFKC (full-width -> half-width kana/digits), then trim, then drop ALL
    whitespace. Both the mart builder and the API normalize the same way, so a
    live ``name`` matches its ``horse_name_key``.
    """
    if name is None:
        return None
    nfkc = unicodedata.normalize("NFKC", str(name))
    return re.sub(r"\s+", "", nfkc).strip() or None


def distance_band(distance_m: int | None) -> str | None:
    """Coarse distance bucket (descriptive). <1400 sprint, <1800 mile,
    <2200 intermediate, else staying. None when distance unknown."""
    if distance_m is None:
        return None
    for upper, label in _DIST_BANDS:
        if distance_m < upper:
            return label
    return "staying"


def style_signal(
    finish_position: int | None,
    last_3f_rank: int | None,
    field_size: int | None,
) -> str | None:
    """Running-style PROXY from finish vs closing speed.

    Heuristic (documented, labelled a proxy NOT a fact -- there is no running
    position data in silver, only finish + last-3F):

    - ``deep_closer``   : closed fastest (last-3F top 3 in the field) but
                          finished outside the top 3 -- a deep, late charge.
    - ``presser``       : closed fast AND ran top 3 -- on the pace enough to
                          capitalize.
    - ``speed``         : did NOT close fast yet finished top 2 -- likely
                          prominent early (forward).
    - ``pace_following``: everything else (midpack results).

    ``field_size`` only gates the "top 3 in field" cutoff for very small
    fields (<=5 runners use top 2). Returns None when finish is unknown.
    """
    if finish_position is None or finish_position <= 0:
        return None
    if last_3f_rank is None:
        return "unknown"
    top_n = 2 if (field_size is not None and field_size <= 5) else 3
    closed_fast = last_3f_rank <= top_n
    top3 = finish_position <= 3
    if closed_fast and not top3:
        return "deep_closer"
    if closed_fast and top3:
        return "presser"
    if not closed_fast and finish_position <= 2:
        return "speed"
    return "pace_following"


# Source-preference rank for entry de-dup: JV-Link ('jravan') wins over the
# netkeiba scrape so a cross-validated race counts each start once.
_SRC_RANK = "CASE e.source_name WHEN 'jravan' THEN 0 ELSE 1 END"


def _silver_path(lake: LakePaths, table: str) -> Path | None:
    """Resolve a Hive-partitioned jravan_* silver dataset, else its legacy
    single-file table. None when neither exists (empty lake -> empty marts)."""
    ds = lake.silver_dataset(f"jravan_{table}")
    if ds.exists():
        return ds
    single = lake.silver_table(table)
    return single if single.exists() else None


# One row per completed start: results joined to (de-duplicated) entries for
# the horse's name/jockey/trainer, and to races for context. Windows add
# field_size and the within-race last-3F rank the style proxy uses.
_BASE_STARTS_SQL = """
WITH dedup_entries AS (
  SELECT * FROM (
    SELECT e.*,
           ROW_NUMBER() OVER (
             PARTITION BY e.race_id, e.horse_number
             ORDER BY {src_rank}
           ) AS _ern
    FROM {entries} e
  ) WHERE _ern = 1
),
field AS (
  SELECT race_id, COUNT(*) AS field_size
  FROM dedup_entries GROUP BY race_id
)
SELECT
  r.race_id            AS race_id,
  r.horse_number       AS horse_number,
  r.horse_id           AS horse_id,
  r.finish_position    AS finish_position,
  r.finish_time_seconds AS finish_time_seconds,
  r.margin             AS margin,
  r.win_odds           AS win_odds,
  r.popularity         AS popularity,
  r.last_3f_seconds    AS last_3f_seconds,
  r.available_at       AS available_at,
  e.horse_name         AS horse_name,
  e.jockey_id          AS jockey_id,
  e.trainer_id         AS trainer_id,
  ra.race_date         AS race_date,
  ra.racecourse        AS racecourse,
  ra.surface           AS surface,
  ra.distance_m        AS distance_m,
  ra.grade_code        AS grade_code,
  ra.going             AS going,
  ra.going_wetness     AS going_wetness,
  f.field_size         AS field_size,
  RANK() OVER (
    PARTITION BY r.race_id
    ORDER BY r.last_3f_seconds NULLS LAST
  )                    AS last_3f_rank
FROM {results} r
LEFT JOIN dedup_entries e
  ON e.race_id = r.race_id AND e.horse_number = r.horse_number
LEFT JOIN {races} ra ON ra.race_id = r.race_id
LEFT JOIN field f ON f.race_id = r.race_id
WHERE r.finish_position IS NOT NULL
"""


def _to_bool(v: Any) -> bool | None:
    return None if v is None else bool(v)


def _build_rows(lake: LakePaths) -> list[dict[str, Any]]:
    """Run the silver join + windows in DuckDB and return enriched start rows.

    Identity/derivation that DuckDB cannot do (NFKC name normalization, the
    spec-derived grade label, the style proxy, distance band) is applied in
    Python here. Returns [] when the silver lake is empty.
    """
    results_p = _silver_path(lake, "race_results")
    entries_p = _silver_path(lake, "race_entries")
    races_p = _silver_path(lake, "races")
    if not results_p or not entries_p or not races_p:
        return []

    con = connect()
    try:
        sql = _BASE_STARTS_SQL.format(
            entries=src(entries_p), results=src(results_p), races=src(races_p),
            src_rank=_SRC_RANK,
        )
        result = con.execute(sql)
        to_arrow = getattr(result, "to_arrow_table", None) or result.fetch_arrow_table
        rows = to_arrow().to_pylist()
    finally:
        con.close()

    out: list[dict[str, Any]] = []
    for r in rows:
        finish = r.get("finish_position")
        pop = r.get("popularity")
        wetness = r.get("going_wetness")
        out.append(
            {
                "horse_name_key": normalize_name(r.get("horse_name")),
                "horse_name": r.get("horse_name"),
                "race_id": r.get("race_id"),
                "horse_number": r.get("horse_number"),
                "available_at": r.get("available_at"),
                "race_date": r.get("race_date"),
                "racecourse": r.get("racecourse"),
                "surface": r.get("surface"),
                "distance_m": r.get("distance_m"),
                "distance_band": distance_band(r.get("distance_m")),
                "going": r.get("going"),
                "going_wetness": wetness,
                "is_wet": (wetness is not None and wetness >= 3),
                "grade_label": grade_label(r.get("grade_code")),
                "field_size": r.get("field_size"),
                "finish_position": finish,
                "finish_time_seconds": r.get("finish_time_seconds"),
                "margin": r.get("margin"),
                "last_3f_seconds": r.get("last_3f_seconds"),
                "last_3f_rank": r.get("last_3f_rank"),
                "win_odds": r.get("win_odds"),
                "popularity": pop,
                "beat_market": (pop - finish if pop is not None and finish else None),
                "style_signal": style_signal(
                    finish, r.get("last_3f_rank"), r.get("field_size")
                ),
                "jockey_id": r.get("jockey_id"),
                "trainer_id": r.get("trainer_id"),
            }
        )
    return out


def build_form_marts(lake: LakePaths) -> dict[str, int]:
    """Materialize ``horse_form.parquet`` and ``jockey_form.parquet``.

    Both marts are projections of one completed-start row set (joined results +
    entries + races). ``horse_form`` keeps every completed start so a horse's
    whole career is PIT-filterable; ``jockey_form`` keeps the subset with a
    real ``jockey_id``. Row counts returned for the CLI / handback.
    """
    lake.ensure()
    rows = _build_rows(lake)

    horse_rows: list[dict[str, Any]] = []
    jockey_rows: list[dict[str, Any]] = []
    for r in rows:
        # horse_form: one row per completed start (horse_name_key may be None
        # when the entry join missed -- those rows are never name-matched).
        horse_rows.append(
            {
                k: r[k]
                for k in (
                    "horse_name_key", "horse_name", "race_id", "horse_number",
                    "available_at", "race_date", "racecourse", "surface",
                    "distance_m", "distance_band", "going", "going_wetness",
                    "is_wet", "grade_label", "field_size", "finish_position",
                    "finish_time_seconds", "margin", "last_3f_seconds",
                    "last_3f_rank", "win_odds", "popularity", "beat_market",
                    "style_signal", "jockey_id",
                )
            }
        )
        # jockey_form: only starts with a real jockey_id (silver entries carry
        # it; 696 distinct). Carries horse/trainer ids for combo counts.
        if r.get("jockey_id"):
            finish = r.get("finish_position")
            jockey_rows.append(
                {
                    "jockey_id": r["jockey_id"],
                    "race_id": r["race_id"],
                    "horse_number": r["horse_number"],
                    "horse_name": r["horse_name"],
                    "horse_name_key": r["horse_name_key"],
                    "trainer_id": r["trainer_id"],
                    "available_at": r["available_at"],
                    "race_date": r["race_date"],
                    "racecourse": r["racecourse"],
                    "surface": r["surface"],
                    "distance_m": r["distance_m"],
                    "distance_band": r["distance_band"],
                    "grade_label": r["grade_label"],
                    "field_size": r["field_size"],
                    "finish_position": finish,
                    "finish_time_seconds": r["finish_time_seconds"],
                    "margin": r["margin"],
                    "win_odds": r["win_odds"],
                    "popularity": r["popularity"],
                    "win_flag": _to_bool(finish == 1),
                    "top3_flag": _to_bool(finish is not None and finish <= 3),
                }
            )

    horse_rows.sort(
        key=lambda x: (x["horse_name_key"] or "", x["available_at"] or _EPOCH)
    )
    jockey_rows.sort(
        key=lambda x: (x["jockey_id"] or "", x["available_at"] or _EPOCH)
    )

    write_parquet(horse_rows, lake.mart(HORSE_FORM_MART))
    write_parquet(jockey_rows, lake.mart(JOCKEY_FORM_MART))
    return {HORSE_FORM_MART: len(horse_rows), JOCKEY_FORM_MART: len(jockey_rows)}


_EPOCH = datetime.min.replace(tzinfo=timezone.utc)


# --- card builders (pure; rows already PIT-filtered + sorted desc by caller) ---
#
# These are CONTEXT for a race panel, not a forecast. Copy stays descriptive
# (win% / splits / a market-vs-result note) and every card is built only from
# rows the read path admitted with ``available_at < as_of``.


def _pct(n: int, d: int) -> float | None:
    return round(n / d, 3) if d else None


def _split(rows: list[dict[str, Any]]) -> dict[str, Any]:
    starts = len(rows)
    wins = sum(1 for r in rows if r.get("finish_position") == 1)
    top3 = sum(1 for r in rows if r.get("finish_position") and r["finish_position"] <= 3)
    return {
        "starts": starts,
        "wins": wins,
        "top3": top3,
        "win_pct": _pct(wins, starts),
        "top3_pct": _pct(top3, starts),
    }


def _by_key(rows: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        k = r.get(key)
        if k is None:
            continue
        buckets.setdefault(str(k), []).append(r)
    return {k: _split(v) for k, v in buckets.items()}


_RECENT_FINISH_KEYS = (
    "available_at", "race_date", "racecourse", "surface", "distance_m",
    "going", "grade_label", "field_size", "finish_position", "margin",
    "last_3f_seconds", "win_odds", "popularity", "style_signal",
)


def build_horse_card(
    rows: list[dict[str, Any]], *, horse_name: str | None, as_of: str | None
) -> dict[str, Any]:
    """Build the rich horse-context card from PIT-filtered start rows.

    ``rows`` are this horse's prior starts (``available_at < as_of``), already
    sorted newest-first by the caller. Empty -> ``no_history`` (never an error
    and never a tip).
    """
    if not rows:
        return {"status": "no_history", "horse_name": horse_name, "as_of": as_of}

    career = _split(rows)
    recent = [{k: r.get(k) for k in _RECENT_FINISH_KEYS} for r in rows[:8]]
    style_profile: dict[str, int] = {}
    for r in rows[:10]:
        s = r.get("style_signal") or "unknown"
        style_profile[s] = style_profile.get(s, 0) + 1

    # Market-vs-result, purely descriptive: positive beat_market = outran odds.
    beats = [r["beat_market"] for r in rows if r.get("beat_market") is not None]
    avg_beat = round(sum(beats) / len(beats), 2) if beats else None
    note = None
    if avg_beat is not None:
        if avg_beat > 0.5:
            note = "tends to outrun odds"
        elif avg_beat < -0.5:
            note = "tends to run to odds"

    return {
        "status": "ok",
        "horse_name": horse_name or rows[0].get("horse_name"),
        "as_of": as_of,
        "context_note": "Form context, not betting advice.",
        "career": career,
        "recent_finishes": recent,
        "by_surface": _by_key(rows, "surface"),
        "by_distance_band": _by_key(rows, "distance_band"),
        "by_wet": {
            "wet": _split([r for r in rows if r.get("is_wet")]),
            "dry": _split([r for r in rows if not r.get("is_wet")]),
        },
        "style_profile": style_profile,
        "style_note": "Running style is a rough proxy from finish + closing split.",
        "market_vs_result": {"avg_beat_market": avg_beat, "note": note},
    }


def build_jockey_card(
    rows: list[dict[str, Any]], *, jockey_id: str | None, as_of: str | None
) -> dict[str, Any]:
    """Build the jockey-context card from PIT-filtered start rows.

    Empty -> ``no_history``. Combo counts are descriptive only.
    """
    if not rows:
        return {"status": "no_history", "jockey_id": jockey_id, "as_of": as_of}

    career = _split(rows)
    by_course = _by_key(rows, "racecourse")

    recent = [
        {
            k: r.get(k)
            for k in (
                "available_at", "race_date", "racecourse", "horse_name",
                "finish_position", "win_odds", "popularity", "grade_label",
            )
        }
        for r in rows[:10]
    ]

    # Combos -- descriptive counts (no win% claims beyond raw starts/wins).
    def _top_combos(key: str, name_key: str | None, limit: int) -> list[dict[str, Any]]:
        buckets: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            k = r.get(key)
            if not k:
                continue
            buckets.setdefault(str(k), []).append(r)
        out = []
        for k, group in buckets.items():
            entry = {
                key: k,
                "starts": len(group),
                "wins": sum(1 for g in group if g.get("finish_position") == 1),
            }
            if name_key and group[0].get(name_key):
                entry[name_key] = group[0][name_key]
            out.append(entry)
        out.sort(key=lambda x: x["starts"], reverse=True)
        return out[:limit]

    return {
        "status": "ok",
        "jockey_id": jockey_id,
        "as_of": as_of,
        "context_note": "Jockey context, not betting advice.",
        "career": career,
        "by_course": by_course,
        "recent": recent,
        "combos": {
            "by_horse": _top_combos("horse_name_key", "horse_name", 5),
            "by_trainer": _top_combos("trainer_id", None, 5),
        },
    }


if __name__ == "__main__":  # manual: python -m keibamon_core.marts.form
    import json

    counts = build_form_marts(LakePaths())
    print(json.dumps(counts, indent=2))
