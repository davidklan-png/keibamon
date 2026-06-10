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
