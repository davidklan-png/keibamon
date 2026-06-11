"""export_delta.py -- ship new bronze snapshots to the USB-C airlock (Windows PC).

    set KEIBAMON_LAKE=D:\\keibamon\\data
    python tools\\jravan\\export_delta.py --to E:\\keibamon-xfer

Copies snapshot dirs not yet exported into <airlock>\\incoming\\<snapshot_id>\\.
Each snapshot already carries _snapshot.json with per-file sha256. Idempotent:
re-running ships nothing new (tracked in raw/jravan/_exported.log).
"""
from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path

LAKE = Path(os.environ.get("KEIBAMON_LAKE", "data"))
BRONZE = LAKE / "raw" / "jravan"
EXPORTED_LOG = BRONZE / "_exported.log"


def exported_ids() -> set[str]:
    return set(EXPORTED_LOG.read_text(encoding="utf-8").split()) if EXPORTED_LOG.exists() else set()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--to", required=True, help="airlock root, e.g. E:\\keibamon-xfer")
    args = ap.parse_args()

    done = exported_ids()
    snaps = sorted(p for p in BRONZE.iterdir()
                   if p.is_dir() and (p / "_snapshot.json").exists() and p.name not in done)
    if not snaps:
        print("nothing to export"); return

    incoming = Path(args.to) / "incoming"
    shipped = []
    for snap in snaps:
        dst = incoming / snap.name
        # robocopy is faster/resumable for big trees: robocopy snap dst /E /J
        shutil.copytree(snap, dst, dirs_exist_ok=True)
        shipped.append(snap.name)
        print(f"shipped snapshot {snap.name}")

    with EXPORTED_LOG.open("a", encoding="utf-8") as fh:
        for sid in shipped:
            fh.write(sid + "\n")
    print(f"exported {len(shipped)} snapshot(s) -> {incoming}")


if __name__ == "__main__":
    main()
