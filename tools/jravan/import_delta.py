"""import_delta.py -- merge USB-C airlock snapshots into the Mac bronze (keibamon).

    KEIBAMON_LAKE=~/keibamon/data python tools/jravan/import_delta.py --from /Volumes/KEIBA/keibamon-xfer

For each incoming/<snapshot_id>: verify every file's sha256 against _snapshot.json,
copy new snapshots into <lake>/raw/jravan/, advance per-spec watermarks, archive
consumed snapshots. Idempotent and safe to re-run / resume.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
from pathlib import Path

LAKE = Path(os.path.expanduser(os.environ.get("KEIBAMON_LAKE", "data")))
BRONZE = LAKE / "raw" / "jravan"
STATE = BRONZE / "_state.json"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state() -> dict:
    return json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"watermarks": {}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True,
                    help="airlock root, e.g. /Volumes/KEIBA/keibamon-xfer")
    args = ap.parse_args()

    incoming = Path(args.src) / "incoming"
    if not incoming.exists():
        print("no incoming/ on drive -- nothing to import"); return

    state = load_state()
    BRONZE.mkdir(parents=True, exist_ok=True)
    imported = skipped = 0

    for snap in sorted(p for p in incoming.iterdir() if p.is_dir()):
        meta_path = snap / "_snapshot.json"
        if not meta_path.exists():
            print(f"WARN {snap.name}: no _snapshot.json, skipping"); continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        dest = BRONZE / snap.name

        if dest.exists():
            skipped += 1
        else:
            for f in meta["files"]:
                src_file = snap / f["file"]
                got = sha256(src_file)
                if got != f["sha256"]:
                    raise RuntimeError(f"sha256 mismatch {snap.name}/{f['file']}: {got} != {f['sha256']}")
            shutil.copytree(snap, dest)
            for f in meta["files"]:
                spec, wm = f["spec"], f.get("watermark_to", "00000000000000")
                if wm > state["watermarks"].get(spec, "00000000000000"):
                    state["watermarks"][spec] = wm
            imported += 1
            print(f"imported snapshot {snap.name} ({len(meta['files'])} files)")

        archive = Path(args.src) / "archive"
        archive.mkdir(exist_ok=True)
        shutil.move(str(snap), str(archive / f"{snap.name}-{dt.datetime.now():%Y%m%dT%H%M%S}"))

    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"done: {imported} imported, {skipped} already present")


if __name__ == "__main__":
    main()
