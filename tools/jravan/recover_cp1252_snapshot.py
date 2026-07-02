#!/usr/bin/env python3
"""
recover_cp1252_snapshot.py -- undo cp1252-as-cp932 mojibake in a quarantined
bronze snapshot, writing a NEW derived snapshot dir alongside the canonical
bronze.

Background
----------
When the capture PC's Windows ANSI codepage (ACP) is not 932, JV-Link's BSTR
conversion routes Shift-JIS bytes through cp1252, and the bronze records arrive
as UTF-8 with two visible artifacts:

  - cp1252 high chars (U+0152 Œ, U+0192 ƒ, U+2014 —, ... -- 27 total mapped by
    Microsoft's published cp1252 table)
  - C1 orphan control chars (U+0081, U+008D, U+008F, U+0090, U+009D -- the five
    bytes in 0x80-0x9F that cp1252 leaves undefined)

``adapters/jravan.recover_raw_bytes`` inverts the cp1252 high chars; the C1
orphans are their own codepoint as a byte. Concatenated and decoded as cp932
strict, the original Japanese text is restored losslessly (the "c1 == hits"
invariant -- 100% of mojibake lines carry C1 orphans, so the cp932 lead-byte
structure survives).

This script NEVER touches the source. It writes a new derived snapshot dir
(source name + 'R' suffix by convention) into the canonical bronze, with a
``provenance`` block in _snapshot.json naming the source + method. ASCII-only
records (HR payouts, O1-O6 odds, all-numeric fields) come out byte-identical:
UTF-8 of ASCII chars is invariant under both cp1252 and cp932 decode paths.

Hard gates (any failure rolls back the dest entirely):

  (a) Records without canary chars pass through byte-identical to source (the
      record IS the original -- ASCII chars are invariant under cp1252 vs cp932,
      and real Japanese chars would have produced canary artifacts if they'd
      been mis-decoded).
  (b) Zero canary chars (U+0192, U+0081, U+008D, U+008F, U+0090, U+009D) in
      any recovered record's raw_text.
  (c) Every record WITH canary chars must recover via ``recover_raw_bytes``
      + cp932 strict decode (raises ValueError on unmapped codepoints,
      UnicodeDecodeError on invalid sequences).

When to use this vs. wait for re-capture
----------------------------------------
Recovery is lossless (per the c1==hits invariant) but it's still DERIVED data.
Prefer re-capture from a Japanese-ACP PC when:

  - JG/SE/RA/HR/O1-O6 are all re-pullable historical data (they are, via JVOpen
    from the appropriate fromtime)
  - The PC visit is soon enough to not block analysis

Use recovery when:

  - rt-* realtime odds (unrepeatable) are involved AND were captured under the
    bad ACP, OR
  - the weekend's data is needed before the next PC visit

When a clean PC re-capture eventually lands, quarantine the R-derived snapshots
in its favor (never delete bronze):

  mv data/raw/jravan/<snap>R data/_quarantine/<snap>R.superseded

Usage
-----
    PYTHONPATH=src python tools/jravan/recover_cp1252_snapshot.py \\
        --source data/_quarantine/20260630T214859.bad-encoding \\
        --dest   data/raw/jravan/20260630T214859R
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path

# adapters/jravan is the canonical recovery implementation -- mirror it, never
# duplicate the cp1252 map.
from keibamon_core.adapters.jravan import recover_raw_bytes  # noqa: E402

# Cheap detection canary (same set the write_snapshot guard uses). Any record
# containing one of these chars was captured under the wrong ACP.
CANARY = frozenset("\u0192\u0081\u008d\u008f\u0090\u009d")


def _has_canary(text: str) -> bool:
    return bool(CANARY & set(text))


def _recover_text(raw_text: str) -> str:
    """Invert cp1252 decode + decode the recovered bytes as cp932 strict.

    Raises ValueError on unmapped codepoints (via ``recover_raw_bytes``) and
    UnicodeDecodeError on bytes that aren't valid cp932. Either is a gate
    failure -- a valid cp932 round-trip should always succeed for real JV-Data.
    """
    raw_bytes = recover_raw_bytes(raw_text)
    return raw_bytes.decode("cp932")


def _process_record(rec: dict) -> tuple[dict, str]:
    """Recover one record. Returns (new_rec, status).

    status is one of:
      'passthrough' -- no canary chars; record copied unchanged. This covers
                       both ASCII-only records (UTF-8 of ASCII is invariant
                       under cp1252 vs cp932, so the source IS the original)
                       AND records that arrived with already-correct Japanese
                       (e.g. JG declarations in the masters snapshot, which
                       came via a different capture path).
      'recovered'   -- had canary chars; raw_text changed by recovery.
      'FAIL_*'      -- a gate tripped; caller should abort.
    """
    src_raw = rec.get("raw", "")
    if not _has_canary(src_raw):
        # No canary => record did not route through the cp1252-as-cp932 path
        # (ASCII chars survive both codecs identically; real Japanese chars
        # would have produced canary artifacts if they'd been mis-decoded).
        # Copy through untouched. Trivially byte-identical to source.
        return rec, "passthrough"

    # Has canary => recover. _recover_text raises on unmapped codepoints or
    # invalid cp932 byte sequences -- either is a real failure.
    try:
        recovered = _recover_text(src_raw)
    except (ValueError, UnicodeDecodeError) as exc:
        return rec, f"FAIL_DECODE:{exc!r}"
    if _has_canary(recovered):
        return rec, "FAIL_CANARY_IN_OUTPUT"

    new_hash = hashlib.sha256(recovered.encode("utf-8")).hexdigest()
    new_rec = dict(rec)
    new_rec["raw"] = recovered
    # Re-derive content-addressed metadata from the recovered bytes so the
    # record stays self-consistent (the source_record_id prefix already
    # carries the record_id; only the hash half changes).
    rid_prefix = rec.get("record_id", "")
    new_rec["content_hash"] = new_hash
    new_rec["source_record_id"] = f"{rid_prefix}:{new_hash[:16]}"
    return new_rec, "recovered"


def _rollback(dest: Path, reason: str) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    sys.exit(f"FATAL: recovery gate failed -- {reason}. dest {dest} removed.")


def run(source: Path, dest: Path) -> None:
    if dest.exists():
        sys.exit(f"FATAL: dest {dest} already exists -- refusing to overwrite.")
    src_manifest = source / "_snapshot.json"
    if not src_manifest.exists():
        sys.exit(f"FATAL: source {source} has no _snapshot.json.")
    src_meta = json.loads(src_manifest.read_text(encoding="utf-8"))

    dest.mkdir(parents=True, exist_ok=False)
    recovered_at = dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
    new_files_meta: list[dict] = []

    for fmeta in src_meta["files"]:
        fname = fmeta["file"]
        src_gz = source / fname
        if not src_gz.exists():
            print(f"WARN missing {src_gz} -- skipping")
            continue
        out_gz = dest / fname

        counts = {"passthrough": 0, "recovered": 0, "failed": 0}
        first_failures: list[str] = []
        out_canary = 0

        with gzip.open(src_gz, "rt", encoding="utf-8") as fin, \
             gzip.open(out_gz, "wt", encoding="utf-8") as fout:
            for ln, line in enumerate(fin):
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                new_rec, status = _process_record(rec)
                if status.startswith("FAIL"):
                    counts["failed"] += 1
                    if len(first_failures) < 5:
                        first_failures.append(
                            f"  line {ln} rid={rec.get('record_id')}: {status}"
                        )
                    # Hard gate: abort on first failure. The caller rolls back
                    # the entire dest so partial output never reaches bronze.
                    print(f"FAIL on {fname} line {ln}: {status}")
                    for f in first_failures:
                        print(f)
                    _rollback(dest, f"{fname} decode failures: {counts['failed']}")
                fout.write(json.dumps(new_rec, ensure_ascii=False) + "\n")
                if status == "passthrough":
                    counts["passthrough"] += 1
                else:
                    counts["recovered"] += 1
                # Belt-and-braces: a recovered record should never contain
                # canary chars (status would have been FAIL_CANARY_IN_OUTPUT).
                if _has_canary(new_rec.get("raw", "")):
                    out_canary += 1

        # File-level canary gate.
        if out_canary:
            _rollback(dest, f"{fname}: {out_canary} records with canary in output")

        new_sha = hashlib.sha256(out_gz.read_bytes()).hexdigest()
        new_files_meta.append({
            "file": fname,
            "spec": fmeta["spec"],
            "rows": counts["passthrough"] + counts["recovered"],
            "sha256": new_sha,
            "watermark_to": fmeta.get("watermark_to", "00000000000000"),
            "recovery": {
                "passthrough_unchanged": counts["passthrough"],
                "recovered": counts["recovered"],
                "source_sha256": fmeta.get("sha256"),
            },
        })
        print(
            f"{fname}: {counts['passthrough']} passthrough, "
            f"{counts['recovered']} recovered"
        )

    new_manifest = {
        "snapshot_id": dest.name,
        "source_name": src_meta.get("source_name", "jravan"),
        "ingested_at": recovered_at,
        "provenance": {
            "method": "cp1252_to_cp932_recovery",
            "source_snapshot": source.name,
            "source_path": str(source),
            "recovered_at": recovered_at,
            "script": "tools/jravan/recover_cp1252_snapshot.py",
            "recovery_fn": "keibamon_core.adapters.jravan.recover_raw_bytes",
            "rationale": (
                "Source captured under Windows ACP != 932; cp1252 high chars "
                "and C1 orphan bytes inverted via recover_raw_bytes, then "
                "decoded cp932 strict. ASCII-only records byte-identical to "
                "source (UTF-8 of ASCII is invariant under cp1252 vs cp932). "
                "Lossless per the c1==hits invariant documented in the 2026-"
                "07-02 recovery run. When a clean PC re-capture lands, "
                "quarantine this dir in its favor (never delete bronze)."
            ),
        },
        "files": new_files_meta,
    }
    (dest / "_snapshot.json").write_text(
        json.dumps(new_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Final sanity: no canary anywhere in the dest dir.
    for gz in dest.glob("*.ndjson.gz"):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for ln, line in enumerate(fh):
                if any(c in line for c in CANARY):
                    _rollback(dest, f"{gz.name} line {ln}: canary in output")

    total_id = sum(f["recovery"]["passthrough_unchanged"] for f in new_files_meta)
    total_rc = sum(f["recovery"]["recovered"] for f in new_files_meta)
    print(f"\nrecovery complete: {dest}")
    print(f"  files: {len(new_files_meta)}")
    print(f"  passthrough-unchanged records: {total_id:,}")
    print(f"  recovered records: {total_rc:,}")
    print(f"  manifest: {dest / '_snapshot.json'}")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Undo cp1252 mojibake in a quarantined bronze snapshot.",
    )
    ap.add_argument(
        "--source", required=True, type=Path,
        help="quarantined .bad-encoding snapshot dir",
    )
    ap.add_argument(
        "--dest", required=True, type=Path,
        help="new derived snapshot dir (e.g. data/raw/jravan/20260630T214859R)",
    )
    args = ap.parse_args()
    run(args.source, args.dest)


if __name__ == "__main__":
    main()
