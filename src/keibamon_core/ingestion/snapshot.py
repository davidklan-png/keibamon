from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from keibamon_core.lake import hash_file, hash_files, write_manifest
from keibamon_core.paths import LakePaths

CSV_SOURCE_NAME = "csv"
REQUIRED_FILES = ("races.csv", "entries.csv")
OPTIONAL_FILES = ("results.csv", "odds.csv")
LATEST_POINTER = "latest.json"


@dataclass(frozen=True)
class BronzeSnapshot:
    snapshot_id: str
    directory: Path
    files: tuple[str, ...]
    manifest: dict[str, Any] = field(default_factory=dict)


def snapshot_csv_source(csv_root: Path, lake: LakePaths) -> BronzeSnapshot:
    """Copy source CSV files into an immutable bronze snapshot with a manifest.

    The snapshot id is derived from the file contents, so re-importing
    identical data is idempotent and never duplicates bronze storage.
    """
    csv_root = Path(csv_root)
    if not csv_root.is_dir():
        raise FileNotFoundError(f"CSV source directory not found: {csv_root}")

    missing = [name for name in REQUIRED_FILES if not (csv_root / name).is_file()]
    if missing:
        raise FileNotFoundError(f"CSV source at {csv_root} is missing required files: {missing}")

    files = [csv_root / name for name in REQUIRED_FILES]
    files += [csv_root / name for name in OPTIONAL_FILES if (csv_root / name).is_file()]

    snapshot_id = hash_files(files)[:16]
    directory = lake.bronze_snapshot_dir(CSV_SOURCE_NAME, snapshot_id)
    directory.mkdir(parents=True, exist_ok=True)

    file_entries: dict[str, Any] = {}
    for source_file in files:
        target = directory / source_file.name
        if not target.exists():
            shutil.copy2(source_file, target)
        file_entries[source_file.name] = {
            "content_hash": hash_file(target),
            "size_bytes": target.stat().st_size,
        }

    manifest = {
        "source_name": CSV_SOURCE_NAME,
        "snapshot_id": snapshot_id,
        "source_uri": str(csv_root.resolve()),
        "ingested_at": datetime.now(timezone.utc).isoformat(),
        "files": file_entries,
    }
    write_manifest(directory, manifest)
    _write_latest_pointer(lake, snapshot_id)

    return BronzeSnapshot(
        snapshot_id=snapshot_id,
        directory=directory,
        files=tuple(sorted(file_entries)),
        manifest=manifest,
    )


def latest_csv_snapshot_dir(lake: LakePaths) -> Path | None:
    """Resolve the most recently ingested bronze CSV snapshot directory."""
    pointer = lake.bronze_source_dir(CSV_SOURCE_NAME) / LATEST_POINTER
    if pointer.exists():
        snapshot_id = json.loads(pointer.read_text(encoding="utf-8"))["snapshot_id"]
        directory = lake.bronze_snapshot_dir(CSV_SOURCE_NAME, snapshot_id)
        if directory.is_dir():
            return directory
    return None


def _write_latest_pointer(lake: LakePaths, snapshot_id: str) -> None:
    pointer = lake.bronze_source_dir(CSV_SOURCE_NAME) / LATEST_POINTER
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(
        json.dumps(
            {"snapshot_id": snapshot_id, "updated_at": datetime.now(timezone.utc).isoformat()},
            indent=2,
        ),
        encoding="utf-8",
    )
