"""publish_form_d1.py -- load the form_starts D1 table from the local marts.

Builds ONE row per completed start (horse_form projection PLUS trainer_id merged
in from jockey_form via a (race_id, horse_number) LEFT JOIN -- horse_form
doesn't carry trainer_id itself; see src/keibamon_core/marts/form.py:297-310).

Two load paths:
  --mode local  (default, Stage 1): write directly to the local miniflare D1
                 sqlite file via Python's sqlite3 module (~5s for 460k rows).
                 The wrangler d1 execute route was tried first but chokes on
                 the 100MB+ SQL file this size of data generates.
  --mode remote (Stage 2 only, gated on verifier sign-off): emit a chunked
                 SQL file and shell out to `wrangler d1 execute --remote`.

Both paths are idempotent (DROP + CREATE + INSERT). NEVER logs Cloudflare
credentials.

Lake resolution: KEIBAMON_DATA_ROOT env var (default: "data"). The horse_form
+ jockey_form marts must exist; this script does NOT rebuild them. Run
``python -m keibamon_core.marts.form`` first if they're stale.

Run:
    python tools/jravan/publish_form_d1.py            # local miniflare
    python tools/jravan/publish_form_d1.py --remote   # prod (Stage 2 only)
"""
from __future__ import annotations

import argparse
import glob
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import duckdb
except ImportError as exc:  # pragma: no cover
    raise SystemExit(
        "duckdb is required: ./venv64/bin/pip install duckdb"
    ) from exc

# Repo-relative imports (run as a script via `python tools/jravan/...`).
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT / "src") not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT / "src"))

from keibamon_core.marts import HORSE_FORM_MART, JOCKEY_FORM_MART  # noqa: E402
from keibamon_core.paths import LakePaths  # noqa: E402


# Match migrations/form/0001_form_starts.sql exactly.
COLUMNS = [
    "horse_name_key", "horse_name", "jockey_id", "trainer_id", "race_id",
    "horse_number", "available_at", "race_date", "racecourse", "surface",
    "distance_m", "distance_band", "going", "going_wetness", "is_wet",
    "grade_label", "field_size", "finish_position", "finish_time_seconds",
    "margin", "last_3f_seconds", "last_3f_rank", "win_odds", "popularity",
    "beat_market", "style_signal",
]

# D1 (sqlite-compatible) table definition. Match migrations/form/0001 exactly.
_TABLE_SQL = """
DROP TABLE IF EXISTS form_starts;
CREATE TABLE form_starts (
  horse_name_key       TEXT,
  horse_name           TEXT,
  jockey_id            TEXT,
  trainer_id           TEXT,
  race_id              TEXT,
  horse_number         INTEGER,
  available_at         TEXT,
  race_date            TEXT,
  racecourse           TEXT,
  surface              TEXT,
  distance_m           INTEGER,
  distance_band        TEXT,
  going                TEXT,
  going_wetness        INTEGER,
  is_wet               INTEGER,
  grade_label          TEXT,
  field_size           INTEGER,
  finish_position      INTEGER,
  finish_time_seconds  REAL,
  margin               TEXT,
  last_3f_seconds      REAL,
  last_3f_rank         INTEGER,
  win_odds             REAL,
  popularity           INTEGER,
  beat_market          INTEGER,
  style_signal         TEXT
);
CREATE INDEX IF NOT EXISTS ix_fs_horse  ON form_starts (horse_name_key, available_at);
CREATE INDEX IF NOT EXISTS ix_fs_jockey ON form_starts (jockey_id, available_at);
CREATE INDEX IF NOT EXISTS ix_fs_race   ON form_starts (race_id);
"""

# Chunked INSERTs for the remote (wrangler) path only. Each batch becomes ONE
# INSERT statement with N value tuples; D1 rejects individual statements that
# cross SQLITE_TOOBIG (~1MB). At batch=1000 with our 26 cols, some batches
# tripped the limit. batch=100 keeps each statement well under the cap while
# still amortizing the per-statement overhead (4,604 statements total).
REMOTE_BATCH_SIZE = 100


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--mode",
        choices=["local", "remote"],
        default="local",
        help="Target: 'local' (miniflare, Stage 1 default — direct sqlite "
             "write) or 'remote' (production D1, Stage 2 only — gated on "
             "verifier sign-off).",
    )
    ap.add_argument(
        "--lake-root",
        default=os.environ.get("KEIBAMON_DATA_ROOT", "data"),
        help="Lake root (default: KEIBAMON_DATA_ROOT or 'data').",
    )
    ap.add_argument(
        "--database",
        default="keibamon_form",
        help="Wrangler D1 database_name (must match wrangler.jsonc). "
             "Local mode uses this to find the miniflare sqlite.",
    )
    ap.add_argument(
        "--sql-out",
        default=None,
        help="Remote mode: where to write the generated SQL (default: a temp "
             "file). Useful for inspecting chunked INSERTs before loading.",
    )
    return ap.parse_args()


def read_rows(horse_p: Path, jockey_p: Path) -> list[tuple]:
    """Read horse_form + LEFT JOIN jockey_form for trainer_id, sorted by
    (horse_name_key, available_at) for stable output. Returns canonicalized
    tuples with TEXT formatted as ISO UTC strings (matches src/form/asOf.ts
    `formatUtcIso`) and `is_wet` cast to INTEGER 0/1."""
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""
            SELECT
              hf.horse_name_key,
              hf.horse_name,
              hf.jockey_id,
              jf.trainer_id,
              hf.race_id,
              hf.horse_number,
              strftime(hf.available_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ')
                AS available_at,
              strftime(hf.race_date AT TIME ZONE 'UTC', '%Y-%m-%d')
                AS race_date,
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
            FROM read_parquet('{horse_p.as_posix()}') hf
            LEFT JOIN (
              SELECT DISTINCT race_id, horse_number, trainer_id
              FROM read_parquet('{jockey_p.as_posix()}')
              WHERE trainer_id IS NOT NULL
            ) jf
              ON hf.race_id = jf.race_id
             AND hf.horse_number = jf.horse_number
            ORDER BY hf.horse_name_key, hf.available_at
            """
        ).fetchall()
    finally:
        con.close()
    return rows


def sql_value(v) -> str:
    """Render a Python value as a SQL literal (TEXT/INTEGER/REAL/NULL)."""
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        # `repr` gives the shortest round-trip representation for floats.
        return repr(v)
    # str (or anything else) — escape single quotes.
    escaped = str(v).replace("'", "''")
    return f"'{escaped}'"


def write_sql_file(rows: list[tuple], out_path: Path) -> None:
    """Emit DROP + CREATE + chunked INSERT statements to out_path (remote mode)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(_TABLE_SQL)
        f.write("\n")
        col_list = ", ".join(COLUMNS)
        for batch_start in range(0, len(rows), REMOTE_BATCH_SIZE):
            batch = rows[batch_start:batch_start + REMOTE_BATCH_SIZE]
            f.write(f"INSERT INTO form_starts ({col_list}) VALUES\n")
            for i, row in enumerate(batch):
                vals = ", ".join(sql_value(v) for v in row)
                f.write(f"  ({vals})")
                f.write(",\n" if i < len(batch) - 1 else ";\n")


def find_or_create_local_sqlite(database: str) -> Path:
    """Locate (or materialize) the local miniflare D1 sqlite for `database`.

    Miniflare names each D1 sqlite file by hashing the database_id. The hash is
    opaque to us, and on a fresh checkout there may be multiple candidate
    sqlite files (keibamon-live + keibamon_form + the miniflare metadata db).
    To unambiguously identify which file backs `keibamon_form`, we create a
    uniquely-named marker table via wrangler, then scan all candidate files
    for that marker.
    """
    state_dir = _REPO_ROOT / ".wrangler" / "state" / "v3" / "d1" / "miniflare-D1DatabaseObject"
    state_dir.mkdir(parents=True, exist_ok=True)

    # First, check if any existing sqlite already has `form_starts` from a
    # prior publisher run — that's unambiguously ours. No marker needed.
    for c in glob.glob(str(state_dir / "*.sqlite")):
        if Path(c).name == "metadata.sqlite":
            continue
        try:
            con = sqlite3.connect(f"file:{c}?mode=ro", uri=True)
            try:
                row = con.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_starts'"
                ).fetchone()
                if row:
                    return Path(c)
            finally:
                con.close()
        except sqlite3.DatabaseError:
            continue

    # No prior run. Create a marker table via wrangler; this also materializes
    # the sqlite file if it's the very first run on this checkout.
    import time
    marker = f"_kbm_form_marker_{int(time.time())}"
    print(f"Materializing local D1 sqlite for {database} (marker={marker})…")
    subprocess.run(
        [
            "npx", "wrangler", "d1", "execute", database,
            "--local", "--command", f"CREATE TABLE IF NOT EXISTS {marker} (k TEXT);",
        ],
        check=True,
        cwd=_REPO_ROOT,
        capture_output=True,
    )

    # Scan for the marker.
    for c in glob.glob(str(state_dir / "*.sqlite")):
        if Path(c).name == "metadata.sqlite":
            continue
        try:
            con = sqlite3.connect(f"file:{c}?mode=ro", uri=True)
            try:
                row = con.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                    (marker,),
                ).fetchone()
                if row:
                    # Drop the marker — we just wanted to identify the file.
                    con.close()
                    con = sqlite3.connect(c)
                    con.execute(f"DROP TABLE IF EXISTS {marker}")
                    con.commit()
                    con.close()
                    return Path(c)
            finally:
                con.close()
        except sqlite3.DatabaseError:
            continue

    raise RuntimeError(
        f"Could not locate miniflare sqlite for {database} under {state_dir}"
    )


def load_local(rows: list[tuple], sqlite_path: Path) -> None:
    """Direct sqlite3 write to the local miniflare file (~5s for 460k rows)."""
    print(f"Writing to {sqlite_path}…")
    con = sqlite3.connect(str(sqlite_path))
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.executescript(_TABLE_SQL)
        col_list = ", ".join(COLUMNS)
        placeholders = ", ".join(["?"] * len(COLUMNS))
        sql = f"INSERT INTO form_starts ({col_list}) VALUES ({placeholders})"
        con.executemany(sql, rows)
        con.commit()
        count = con.execute("SELECT COUNT(*) FROM form_starts").fetchone()[0]
        dups = con.execute(
            "SELECT COUNT(*) FROM ("
            " SELECT horse_name_key, race_id, COUNT(*) c FROM form_starts "
            " GROUP BY 1,2 HAVING c>1)"
        ).fetchone()[0]
        print(f"  rows: {count:,}")
        print(f"  dup (horse_name_key, race_id) groups: {dups} (expected 0)")
    finally:
        con.close()


def load_remote(rows: list[tuple], database: str, sql_out: Path | None) -> None:
    """Stage 2 only: chunked SQL file + wrangler d1 execute --remote."""
    sql_path = (
        Path(sql_out)
        if sql_out
        else Path(tempfile.gettempdir()) / "keibamon_form_starts.sql"
    )
    write_sql_file(rows, sql_path)
    print(f"SQL written: {sql_path} ({sql_path.stat().st_size:,} bytes)")
    cmd = [
        "npx", "wrangler", "d1", "execute", database,
        "--remote", "--file", str(sql_path),
    ]
    print(f"Running: {' '.join(cmd)}")
    subprocess.run(cmd, check=True, cwd=_REPO_ROOT)


def main() -> int:
    args = parse_args()
    lake = LakePaths(Path(args.lake_root))
    horse_p = lake.mart(HORSE_FORM_MART)
    jockey_p = lake.mart(JOCKEY_FORM_MART)
    if not horse_p.exists():
        print(f"ERROR: horse_form mart not found at {horse_p}", file=sys.stderr)
        print(
            "Rebuild it first: PYTHONPATH=src ./venv64/bin/python "
            "-m keibamon_core.marts.form",
            file=sys.stderr,
        )
        return 2
    if not jockey_p.exists():
        print(f"ERROR: jockey_form mart not found at {jockey_p}", file=sys.stderr)
        return 2

    print(f"Reading marts from {lake.root}…")
    rows = read_rows(horse_p, jockey_p)
    print(f"  rows: {len(rows):,}")

    if args.mode == "local":
        sqlite_path = find_or_create_local_sqlite(args.database)
        load_local(rows, sqlite_path)
        print(f"\nLoaded {len(rows):,} rows into {sqlite_path} (local).")
    else:
        load_remote(rows, args.database, Path(args.sql_out) if args.sql_out else None)
        print(f"\nLoaded {len(rows):,} rows into {args.database} (remote).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
