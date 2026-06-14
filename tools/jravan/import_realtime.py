"""import_realtime.py -- land the JV-Link realtime (0B30) export into bronze.

The realtime capture the PC writes to the USB has a different shape than the bulk
airlock: a nested tree with no manifest --

    incoming/realtime/<YYYYMMDD>/<race_key>/<ts>.ndjson.gz   (one file per snapshot)

so `import_delta.py` (which wants flat, manifest-bearing snapshots) skips it. This
importer normalizes that tree into the bronze the silver builder already reads:

    <lake>/raw/jravan_rt/rt-<YYYYMMDD>/<RECORD_ID>.rt-<YYYYMMDD>.ndjson.gz

Each line is one wrapped JV-Data record (the `raw` field is a standard O1/O2 odds
record the existing parser handles). Records are grouped by record_id and
de-duplicated by content_hash, so re-running is idempotent and safe. The USB is
read-only here -- nothing on the drive is moved or deleted.

    KEIBAMON_LAKE=~/keibamon-data python tools/jravan/import_realtime.py \
        --from /Volumes/KEIBA/keibamon-xfer

Then build silver as usual; the realtime source feeds jravan_odds_timeseries.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
from collections import defaultdict
from pathlib import Path

def _lake_root() -> Path:
    return Path(os.path.expanduser(os.environ.get("KEIBAMON_LAKE", "data")))


def _iter_usb_records(realtime_root: Path):
    """Every wrapped record under the realtime tree, any nesting depth."""
    for gz in sorted(realtime_root.rglob("*.ndjson.gz")):
        try:
            with gzip.open(gz, "rt", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        yield json.loads(line)
        except (OSError, EOFError, json.JSONDecodeError) as exc:  # noqa: BLE001
            print(f"  WARN unreadable {gz.name}: {exc!r}")


def _load_existing(snap_dir: Path) -> dict[str, set[str]]:
    """content_hashes already in bronze, per record_id (for idempotent re-runs)."""
    have: dict[str, set[str]] = defaultdict(set)
    if not snap_dir.is_dir():
        return have
    for gz in snap_dir.glob("*.ndjson.gz"):
        rid = gz.name.split(".", 1)[0]
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    have[rid].add(json.loads(line).get("content_hash"))
    return have


def run_import(src: Path, lake_root: Path, *, dry_run: bool = False) -> dict:
    """Normalize the realtime tree under ``src`` into bronze at ``lake_root``.

    Returns a summary dict. Idempotent: re-running merges by content_hash.
    """
    rt_bronze = lake_root / "raw" / "jravan_rt"
    # accept either the xfer root or a path already inside the realtime tree
    candidates = [src / "incoming" / "realtime", src / "realtime", src]
    realtime_root = next((c for c in candidates if c.is_dir()), None)
    if realtime_root is None:
        print(f"no realtime tree found under {src} (looked for incoming/realtime, realtime)")
        return {"written": 0, "skipped": 0, "dates": []}

    # group by date -> record_id -> {content_hash: line-dict}
    by_date: dict[str, dict[str, dict[str, dict]]] = defaultdict(lambda: defaultdict(dict))
    total = 0
    for rec in _iter_usb_records(realtime_root):
        rid = rec.get("record_id")
        ch = rec.get("content_hash")
        key = rec.get("race_key") or rec.get("raw_uri") or ""
        date = key[:8] if len(key) >= 8 and key[:8].isdigit() else "unknown"
        if not rid or not ch:
            continue
        by_date[date][rid][ch] = rec
        total += 1

    if not by_date:
        print(f"read {total} records but none usable (missing record_id/content_hash)")
        return {"written": 0, "skipped": 0, "dates": []}

    print(f"read {total} realtime records from {realtime_root}")
    written = skipped = 0
    for date in sorted(by_date):
        snap_id = f"rt-{date}"
        snap_dir = rt_bronze / snap_id
        existing = _load_existing(snap_dir)
        for rid in sorted(by_date[date]):
            recs = by_date[date][rid]
            new = {ch: r for ch, r in recs.items() if ch not in existing.get(rid, set())}
            skipped += len(recs) - len(new)
            kinds = sorted({r["record_type"] for r in recs.values() if r.get("record_type")})
            print(f"  {snap_id}/{rid}: {len(recs)} records ({len(new)} new) pools={kinds}")
            if dry_run:
                continue
            snap_dir.mkdir(parents=True, exist_ok=True)
            # merge existing bronze + USB, dedupe by content_hash, rewrite the file
            merged: dict[str, dict] = {}
            out_path = snap_dir / f"{rid}.{snap_id}.ndjson.gz"
            if out_path.exists():
                with gzip.open(out_path, "rt", encoding="utf-8") as fh:
                    for line in fh:
                        line = line.strip()
                        if line:
                            d = json.loads(line)
                            merged[d.get("content_hash")] = d
            for ch, r in sorted(recs.items()):
                merged[ch] = r
            with gzip.open(out_path, "wt", encoding="utf-8") as fh:
                for r in merged.values():
                    fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            written += len(new)

    verb = "would write" if dry_run else "wrote"
    print(f"done: {verb} {written} new records to {rt_bronze} ({skipped} already present)")
    if not dry_run:
        print("next: rebuild silver -> jravan_odds_timeseries now includes the realtime curves.")
    return {"written": written, "skipped": skipped, "dates": sorted(by_date)}


def main() -> None:
    ap = argparse.ArgumentParser(description="Import JV-Link realtime export into bronze.")
    ap.add_argument("--from", dest="src", required=True,
                    help="airlock root (…/keibamon-xfer) or a realtime/ dir")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    run_import(Path(args.src), _lake_root(), dry_run=args.dry_run)


if __name__ == "__main__":
    main()
