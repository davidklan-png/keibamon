from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from keibamon_core.paths import LakePaths


def ensure_lake_dirs(root: Path = Path("data")) -> None:
    LakePaths(root=root).ensure()


# --- hashing / metadata helpers ---------------------------------------------


def hash_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def hash_file(path: Path) -> str:
    return hash_bytes(path.read_bytes())


def hash_files(paths: list[Path]) -> str:
    """Deterministic combined hash for a set of files (order-independent)."""
    digest = hashlib.sha256()
    for path in sorted(paths, key=lambda p: p.name):
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def write_manifest(directory: Path, manifest: dict[str, Any]) -> Path:
    """Write a JSON manifest describing a dataset snapshot."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "manifest.json"
    _atomic_write_bytes(path, json.dumps(manifest, indent=2, sort_keys=True, default=str).encode("utf-8"))
    return path


def read_manifest(directory: Path) -> dict[str, Any] | None:
    path = directory / "manifest.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


# --- parquet IO ---------------------------------------------------------------


def write_parquet(records: list[dict[str, Any]], path: Path) -> None:
    """Atomically write records to Parquet using pyarrow."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover - exercised when deps are missing
        raise RuntimeError("pyarrow is required to write parquet assets") from exc

    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pylist(records)
    tmp_path = path.with_name(f".{path.name}.tmp")
    pq.write_table(table, tmp_path)
    os.replace(tmp_path, path)


def read_parquet(path: Path) -> list[dict[str, Any]]:
    """Read a Parquet file into a list of dicts. Raises if the file is missing."""
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pyarrow is required to read parquet assets") from exc

    if not path.exists():
        raise FileNotFoundError(f"Parquet asset not found: {path}")
    return pq.read_table(path).to_pylist()


def read_parquet_if_exists(path: Path) -> list[dict[str, Any]]:
    """Read a Parquet file, returning an empty list when it does not exist."""
    if not path.exists():
        return []
    return read_parquet(path)


# --- partitioned datasets -----------------------------------------------------
# Lake convention: silver/gold tables are Hive-partitioned by (year, venue) where
# year is the race year (int) and venue is the JV-Data jyo (racecourse) code
# string -- e.g. <table>/year=1986/venue=06/part-*.parquet. Partition columns are
# pinned on read (year=int32, venue=string) so codes like "06" keep their leading
# zero and alphanumeric foreign codes ("A4") stay strings.
PARTITION_KEYS = ("year", "venue")


def write_dataset(
    records: list[dict[str, Any]], base_dir: Path, partition_cols=PARTITION_KEYS
) -> None:
    """Write records as a Hive-partitioned Parquet dataset. Idempotent: re-running
    replaces the partitions it touches (existing_data_behavior='delete_matching')."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pyarrow is required to write parquet datasets") from exc

    base_dir.mkdir(parents=True, exist_ok=True)
    cols = list(partition_cols)
    # Sort by partition key so each partition is written contiguously -> only a
    # handful of files open at once. Without this, hundreds of year/venue
    # partitions written out of order exhaust the OS file-descriptor limit
    # ("[Errno 24] Too many open files" on macOS, default ulimit -n 256).
    # max_open_files is a belt-and-suspenders cap.
    records = sorted(records, key=lambda r: tuple((r.get(c) is None, r.get(c)) for c in cols))
    table = pa.Table.from_pylist(records)
    pq.write_to_dataset(
        table,
        root_path=str(base_dir),
        partition_cols=cols,
        existing_data_behavior="delete_matching",
        max_open_files=8,
    )


def _partitioning():
    import pyarrow as pa
    import pyarrow.dataset as ds
    return ds.partitioning(
        pa.schema([("year", pa.int32()), ("venue", pa.string())]), flavor="hive"
    )


def read_dataset(base_dir: Path) -> list[dict[str, Any]]:
    """Read a Hive-partitioned dataset back to list[dict], partition columns typed
    per the lake convention. Empty list if the dataset does not exist. (For large
    tables prefer keibamon_core.lake_query, which avoids full materialization.)"""
    try:
        import pyarrow.dataset as ds
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pyarrow is required to read parquet datasets") from exc
    if not Path(base_dir).exists():
        return []
    return ds.dataset(str(base_dir), partitioning=_partitioning(),
                      format="parquet").to_table().to_pylist()


def duckdb_relation(path_glob: str):
    """Return a DuckDB relation for a Parquet glob."""
    try:
        import duckdb
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("duckdb is required for analytical queries") from exc

    return duckdb.sql(f"select * from read_parquet('{path_glob}', union_by_name=true)")


# --- internals ----------------------------------------------------------------


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_bytes(content)
    os.replace(tmp_path, path)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
