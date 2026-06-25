"""generate_parity_fixtures.py -- emit golden fixtures for src/form/parity.test.ts.

For each (entity, as_of) case, this script:
  1. Loads the form marts (synthetic 5-race lake OR the production lake for the
     real-data anchor case).
  2. Runs the SAME PIT SQL the Worker will run (`horse_name_key = ? AND
     available_at < ? ORDER BY available_at DESC`).
  3. Calls Python `build_horse_card` / `build_jockey_card` on the rows.
  4. Dumps both the rows (`<case>.input.json`) and the card (`<case>.golden.json`)
     into src/form/test/fixtures/.

The TS parity test then loads `<case>.input.json`, runs the TS card builder, and
deep-equals against `<case>.golden.json`. Any drift fails CI.

Re-run when form.py changes:
    PYTHONPATH=src ./venv64/bin/python tools/form/generate_parity_fixtures.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "src"))

import duckdb  # noqa: E402

from keibamon_core.lake import write_dataset  # noqa: E402
from keibamon_core.lake_query import connect, src  # noqa: E402
from keibamon_core.marts import (  # noqa: E402
    HORSE_FORM_MART,
    JOCKEY_FORM_MART,
    build_form_marts,
    build_horse_card,
    build_jockey_card,
    normalize_name,
)
from keibamon_core.paths import LakePaths  # noqa: E402

# Same column order as src/form/queries.ts HORSE_FORM_SQL / JOCKEY_FORM_SQL +
# the form_starts DDL. The TS cardBuilder expects these EXACT field names.
COLUMNS = [
    "horse_name_key", "horse_name", "jockey_id", "trainer_id", "race_id",
    "horse_number", "available_at", "race_date", "racecourse", "surface",
    "distance_m", "distance_band", "going", "going_wetness", "is_wet",
    "grade_label", "field_size", "finish_position", "finish_time_seconds",
    "margin", "last_3f_seconds", "last_3f_rank", "win_odds", "popularity",
    "beat_market", "style_signal",
]


# --- Synthetic lake: 5-race fixture (mirrors tests/test_form_api.py) --------

_R0 = "jra-20260520-05-01"
_R1 = "jra-20260601-05-01"
_R2 = "jra-20260608-05-01"
_R3 = "jra-20260628-05-11"  # upcoming G3 target
_R4 = "jra-20260710-05-01"  # future Alpha win -- PIT-excluded
_POST = datetime(2026, 6, 1, 6, 0, tzinfo=timezone.utc)


def _part(rid: str) -> tuple[int, str]:
    p = rid.split("-")
    return int(p[1][:4]), p[2]


def _race(rid: str, post: datetime, *, grade_code: str | None = None,
          dist: int = 2000, wetness: int = 1) -> dict[str, Any]:
    return {
        "race_id": rid, "race_date": post.replace(hour=0, minute=0),
        "racecourse": "Tokyo", "country": "JP", "surface": "turf",
        "distance_m": dist, "scheduled_post_time": post, "race_name": f"r-{rid}",
        "grade_code": grade_code, "last_3f_seconds": 34.0, "weather": "fine",
        "going_turf": "good", "going_dirt": None, "going_wetness": wetness,
        "going": "good", "source_name": "jravan",
        "source_record_id": f"RA:{rid}", "raw_uri": f"b/{rid}",
        "content_hash": f"h-{rid}", "ingested_at": post,
        "published_time": post, "available_at": post,
        "year": _part(rid)[0], "venue": _part(rid)[1],
    }


def _entry(rid: str, no: int, *, name: str, jockey: str, trainer: str = "t1") -> dict[str, Any]:
    return {
        "race_id": rid, "horse_id": "0000000000", "horse_name": name,
        "horse_number": no, "gate": no, "jockey_id": jockey, "trainer_id": trainer,
        "carried_weight_kg": 57, "body_weight_kg": 480, "source_name": "jravan",
        "source_record_id": f"SE:{rid}:{no}", "raw_uri": f"b/{rid}",
        "content_hash": f"he-{rid}-{no}", "ingested_at": _POST,
        "published_time": _POST, "available_at": _POST,
        "year": _part(rid)[0], "venue": _part(rid)[1],
    }


def _result(rid: str, no: int, *, pos: int, pop: int = 1, win_odds: float = 3.0,
            available: datetime = _POST) -> dict[str, Any]:
    return {
        "race_id": rid, "horse_id": "0000000000", "horse_number": no,
        "finish_position": pos, "finish_time_seconds": 95.0, "margin": "1",
        "win_odds": win_odds, "popularity": pop, "last_3f_seconds": 33.5,
        "source_name": "jravan", "source_record_id": f"SE:{rid}:{no}",
        "raw_uri": f"b/{rid}", "content_hash": f"hr-{rid}-{no}",
        "ingested_at": available, "published_time": available,
        "available_at": available,
        "year": _part(rid)[0], "venue": _part(rid)[1],
    }


def _build_synthetic_lake(tmp: Path) -> LakePaths:
    lake = LakePaths(root=tmp / "data")
    lake.ensure()
    races = [
        _race(_R0, datetime(2026, 5, 20, 6, tzinfo=timezone.utc), dist=1600),
        _race(_R1, datetime(2026, 6, 1, 6, tzinfo=timezone.utc), wetness=3),
        _race(_R2, datetime(2026, 6, 8, 6, tzinfo=timezone.utc), dist=2400),
        _race(_R3, datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc), grade_code="C"),
        _race(_R4, datetime(2026, 7, 10, 6, tzinfo=timezone.utc)),
    ]
    entries = [
        _entry(_R0, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry(_R1, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry(_R1, 2, name="Gamma", jockey="j03", trainer="tC"),
        _entry(_R3, 1, name="Alpha", jockey="j02", trainer="tA"),  # upcoming
        _entry(_R4, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry(_R2, 3, name="Beta", jockey="j01", trainer="tB"),
    ]
    results = [
        _result(_R0, 1, pos=2, available=datetime(2026, 5, 20, 6, tzinfo=timezone.utc)),
        _result(_R1, 1, pos=1, available=datetime(2026, 6, 1, 6, tzinfo=timezone.utc)),
        _result(_R1, 2, pos=2, available=datetime(2026, 6, 1, 6, tzinfo=timezone.utc)),
        _result(_R2, 3, pos=3, available=datetime(2026, 6, 8, 6, tzinfo=timezone.utc)),
        _result(_R4, 1, pos=1, available=datetime(2026, 7, 10, 6, tzinfo=timezone.utc)),
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))
    build_form_marts(lake)
    return lake


# --- PIT-filter rows from a form mart, in the EXACT shape form_starts has ---
# (This mirrors what the publisher does — strftime on available_at + race_date,
# CAST is_wet AS INTEGER — so the TS card builder sees the same field types as
# it will in production.)

_PIT_SQL = """
SELECT
  hf.horse_name_key,
  hf.horse_name,
  hf.jockey_id,
  jf.trainer_id,
  hf.race_id,
  hf.horse_number,
  strftime(hf.available_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS available_at,
  strftime(hf.race_date AT TIME ZONE 'UTC', '%Y-%m-%d') AS race_date,
  hf.racecourse,
  hf.surface,
  hf.distance_m,
  hf.distance_band,
  hf.going,
  hf.going_wetness,
  CAST(hf.is_wet AS INTEGER) AS is_wet,
  hf.grade_label,
  hf.field_size,
  hf.finish_position,
  hf.finish_time_seconds,
  hf.margin,
  hf.last_3f_seconds,
  hf.last_3f_rank,
  hf.win_odds,
  hf.popularity,
  hf.beat_market,
  hf.style_signal
FROM read_parquet('{horse_p}') hf
LEFT JOIN (
  SELECT DISTINCT race_id, horse_number, trainer_id
  FROM read_parquet('{jockey_p}')
  WHERE trainer_id IS NOT NULL
) jf ON hf.race_id = jf.race_id AND hf.horse_number = jf.horse_number
WHERE {where} AND hf.available_at < ?
ORDER BY hf.available_at DESC
"""


def _pit_filter_horse(lake: LakePaths, name: str, as_of_iso: str) -> list[dict[str, Any]]:
    key = normalize_name(name)
    if not key:
        return []
    horse_p = lake.mart(HORSE_FORM_MART)
    jockey_p = lake.mart(JOCKEY_FORM_MART)
    if not horse_p.exists():
        return []
    con = duckdb.connect()
    try:
        rows = con.execute(
            _PIT_SQL.format(horse_p=horse_p.as_posix(),
                            jockey_p=jockey_p.as_posix(),
                            where="hf.horse_name_key = ?"),
            [key, as_of_iso],
        ).fetchall()
    finally:
        con.close()
    return [_row_to_obj(r) for r in rows]


def _pit_filter_jockey(lake: LakePaths, jockey_id: str, as_of_iso: str) -> list[dict[str, Any]]:
    horse_p = lake.mart(HORSE_FORM_MART)
    jockey_p = lake.mart(JOCKEY_FORM_MART)
    if not horse_p.exists():
        return []
    con = duckdb.connect()
    try:
        rows = con.execute(
            _PIT_SQL.format(horse_p=horse_p.as_posix(),
                            jockey_p=jockey_p.as_posix(),
                            where="hf.jockey_id = ?"),
            [jockey_id, as_of_iso],
        ).fetchall()
    finally:
        con.close()
    return [_row_to_obj(r) for r in rows]


def _all_synthetic_rows(lake: LakePaths) -> list[dict[str, Any]]:
    """All rows from the synthetic lake (publisher shape), no PIT filter. Used
    by src/form/queries.test.ts to seed an in-process sqlite."""
    horse_p = lake.mart(HORSE_FORM_MART)
    jockey_p = lake.mart(JOCKEY_FORM_MART)
    if not horse_p.exists():
        return []
    con = duckdb.connect()
    try:
        # Same SELECT as the publisher (with the LEFT JOIN for trainer_id).
        rows = con.execute(
            f"""
            SELECT
              hf.horse_name_key, hf.horse_name, hf.jockey_id, jf.trainer_id,
              hf.race_id, hf.horse_number,
              strftime(hf.available_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ')
                AS available_at,
              strftime(hf.race_date AT TIME ZONE 'UTC', '%Y-%m-%d') AS race_date,
              hf.racecourse, hf.surface, hf.distance_m, hf.distance_band,
              hf.going, hf.going_wetness,
              CAST(hf.is_wet AS INTEGER) AS is_wet,
              hf.grade_label, hf.field_size, hf.finish_position,
              hf.finish_time_seconds, hf.margin, hf.last_3f_seconds,
              hf.last_3f_rank, hf.win_odds, hf.popularity, hf.beat_market,
              hf.style_signal
            FROM read_parquet('{horse_p.as_posix()}') hf
            LEFT JOIN (
              SELECT DISTINCT race_id, horse_number, trainer_id
              FROM read_parquet('{jockey_p.as_posix()}')
              WHERE trainer_id IS NOT NULL
            ) jf ON hf.race_id = jf.race_id AND hf.horse_number = jf.horse_number
            ORDER BY hf.horse_name_key, hf.available_at
            """
        ).fetchall()
    finally:
        con.close()
    return [_row_to_obj(r) for r in rows]


def _row_to_obj(row: tuple) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for k, v in zip(COLUMNS, row):
        if isinstance(v, bool):
            obj[k] = 1 if v else 0
        elif hasattr(v, "isoformat"):  # datetime
            obj[k] = v.isoformat()
        else:
            obj[k] = v
    return obj


# --- The Python card builders want the SAME shape they'd see in API use ----
# (horse_form rows from the mart). The publisher applies strftime + CAST; we
# feed the Python card builder the post-publisher shape so TS and Python see
# identical inputs.

def _py_rows_for_card(obj_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The Python card builders tolerate either shape (datetime or string for
    available_at; bool or int for is_wet). Feed them the publisher-shape rows
    directly — they only read fields via .get(), so the type doesn't matter."""
    return obj_rows


def _write_fixture(out_dir: Path, case: str, input_rows: list[dict[str, Any]],
                   golden: dict[str, Any]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{case}.input.json").write_text(
        json.dumps(input_rows, ensure_ascii=False, indent=2),
    )
    (out_dir / f"{case}.golden.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=2),
    )
    print(f"  {case}: {len(input_rows)} rows → {out_dir / f'{case}.input.json'}")


def main() -> int:
    out_dir = _REPO_ROOT / "src" / "form" / "test" / "fixtures"

    # --- Synthetic 5-race lake cases ---------------------------------------
    print("Building synthetic 5-race lake…")
    tmp = Path(tempfile.mkdtemp(prefix="kbm-form-fixture-"))
    try:
        lake = _build_synthetic_lake(tmp)

        # as_of in the synthetic lake's "now" (after R3's post time). PIT-excludes R4.
        G3_AS_OF = "2026-06-28T06:30:00Z"  # = R3 post_time UTC

        cases: list[tuple[str, str, str, str | None]] = [
            # (case_name, kind, entity_id, as_of_raw)
            ("horse_alpha_ok", "horse", "Alpha", G3_AS_OF),
            ("horse_alpha_full", "horse", "Alpha", "2026-12-31T00:00:00Z"),
            ("horse_gamma_ok", "horse", "Gamma", G3_AS_OF),
            ("horse_beta_ok", "horse", "Beta", G3_AS_OF),
            ("horse_unknown_no_history", "horse", "Nobody", G3_AS_OF),
            ("horse_alpha_default_as_of", "horse", "Alpha", None),
            ("jockey_j01", "jockey", "j01", G3_AS_OF),
            ("jockey_j03", "jockey", "j03", G3_AS_OF),
            ("jockey_j02_no_history", "jockey", "j02", G3_AS_OF),
        ]

        # Clear stale fixtures from a prior run.
        if out_dir.exists():
            shutil.rmtree(out_dir)

        for case, kind, entity, as_of_raw in cases:
            as_of_iso = as_of_raw if as_of_raw else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if kind == "horse":
                rows = _pit_filter_horse(lake, entity, as_of_iso)
                golden = build_horse_card(_py_rows_for_card(rows), horse_name=entity, as_of=as_of_raw)
            else:
                rows = _pit_filter_jockey(lake, entity, as_of_iso)
                golden = build_jockey_card(_py_rows_for_card(rows), jockey_id=entity, as_of=as_of_raw)
            _write_fixture(out_dir, case, rows, golden)

        # Dump ALL synthetic lake rows (not PIT-filtered) so src/form/queries.test.ts
        # can seed a better-sqlite3 db and exercise the Worker's SQL strings.
        all_rows = _all_synthetic_rows(lake)
        (out_dir / "all_synthetic_starts.json").write_text(
            json.dumps(all_rows, ensure_ascii=False, indent=2),
        )
        print(f"  all_synthetic_starts: {len(all_rows)} rows")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- Real-data anchor: ダノンデサイル from the production lake -----------
    # Verifier expects 15 / 5 / 10 / 33.3% / 66.7%.
    print("\nLoading real-data anchor from production lake…")
    real_lake_root = os.environ.get("KEIBAMON_DATA_ROOT", "data")
    real_lake = LakePaths(Path(real_lake_root))
    real_horse_p = real_lake.mart(HORSE_FORM_MART)
    if real_horse_p.exists():
        name = "ダノンデサイル"
        # Anchor as_of = a recent date that includes the 15 starts.
        rows = _pit_filter_horse(real_lake, name, "2026-06-25T00:00:00Z")
        golden = build_horse_card(_py_rows_for_card(rows), horse_name=name, as_of=None)
        _write_fixture(out_dir, "real_danon_decile", rows, golden)
        print(
            f"    career: {golden['career']['starts']}/"
            f"{golden['career']['wins']}/{golden['career']['top3']}"
        )
    else:
        print(
            f"  WARNING: production mart not found at {real_horse_p}; skipping "
            "real-data anchor. Re-run after `python -m keibamon_core.marts.form`."
        )

    print(f"\nFixtures written to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
