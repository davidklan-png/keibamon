"""pull_results_snapshot.py -- targeted JV-Link bulk results snapshot.

Windows capture-PC helper for race-day settlement handoff. This pulls the RACE
bulk feed through JVOpen, filters one target card's final result files, writes a
manifest-bearing bronze snapshot, and optionally copies it to the KEIBA USB
airlock format consumed by tools/jravan/import_delta.py.

The helper intentionally refuses to export preliminary RADW/SEDW files. For
June 14 Hanshin settlement we need the final RASW/SESW/HRSW records.

Example:
    C:\keibamon\venv32\Scripts\python tools\jravan\pull_results_snapshot.py ^
      --date 20260614 --jyo 09 ^
      --to E:\keibamon-xfer
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import gzip
import hashlib
import json
import os
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import win32com.client

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from keibamon_core.adapters.jravan import JravanSourceAdapter  # noqa: E402

SID = os.environ.get("JRAVAN_SID", "UNLP00000000")
LAKE = Path(os.environ.get("KEIBAMON_LAKE", r"D:\keibamon\data"))
BRONZE = LAKE / "raw" / "jravan"
STATE = BRONZE / "_state.json"
SOURCE_NAME = "jravan"
ENCODING = "cp932"
DEFAULT_RACES = tuple(range(1, 13))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def file_make_ts(filename: str) -> str | None:
    stem = filename.rsplit(".", 1)[0]
    ts = stem[-14:]
    return ts if len(ts) == 14 and ts.isdigit() else None


def header(raw: str) -> dict[str, str | int]:
    # The race-id header is ASCII-only and ends before Japanese names begin.
    # Some record types we skip (notably JG) can contain characters that do not
    # round-trip through cp932 in this console/Python path, so avoid encoding the
    # whole record until we know it is a target RA/SE/HR row.
    b = raw[:27].encode(ENCODING, "replace")
    return {
        "record_id": b[0:2].decode(ENCODING),
        "data_kubun": b[2:3].decode(ENCODING),
        "year": b[11:15].decode(ENCODING),
        "mmdd": b[15:19].decode(ENCODING),
        "jyo": b[19:21].decode(ENCODING),
        "race": int(b[25:27].decode(ENCODING)),
    }


def recover_cp932_text(raw: str) -> str:
    """Return text that round-trips to the original JV-Data cp932 bytes.

    Some JV-Link/JVRead paths return Japanese bytes mojibaked as Windows-1252-ish
    characters (e.g. byte 0x83 as "ƒ", byte 0x81 as U+0081). Rebuild the
    original byte stream and decode it as cp932 so the shared silver parser can
    slice by byte offsets.
    """
    body = raw.rstrip("\r\n")
    try:
        body.encode(ENCODING)
        return raw
    except UnicodeEncodeError:
        pass

    out = bytearray()
    for ch in body:
        code = ord(ch)
        if code <= 255:
            out.append(code)
            continue
        try:
            out.extend(ch.encode("cp1252"))
        except UnicodeEncodeError:
            out.extend(ch.encode(ENCODING))
    fixed = bytes(out).decode(ENCODING)
    return fixed + ("\r\n" if raw.endswith("\r\n") else "")


def is_final_result_file(record_id: str, filename: str) -> bool:
    prefix = Path(filename).name[:4]
    return (
        (record_id == "RA" and prefix == "RASW")
        or (record_id == "SE" and prefix == "SESW")
        or (record_id == "HR" and prefix == "HRSW")
    )


def wrapped_row(raw: str, filename: str, ingested_at: str, published_time: str) -> dict:
    record_id = raw[:2]
    content_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return {
        "source_name": SOURCE_NAME,
        "source_record_id": f"{record_id}:{content_hash[:16]}",
        "raw_uri": filename,
        "content_hash": content_hash,
        "ingested_at": ingested_at,
        "published_time": published_time,
        "available_at": published_time,
        "record_id": record_id,
        "spec": "RACE",
        "raw": raw,
    }


def assert_japanese_acp() -> None:
    acp = ctypes.windll.kernel32.GetACP()
    if acp != 932:
        raise SystemExit(f"FATAL: Windows ANSI codepage is {acp}, need 932.")


def pull_rows(date: str, jyo: str, races: set[int], fromtime: str, option: int) -> tuple[list[dict], str]:
    assert_japanese_acp()
    mmdd = date[4:]
    ingested_at = dt.datetime.utcnow().isoformat() + "Z"
    rows: list[dict] = []
    max_ts = "00000000000000"

    jv = win32com.client.Dispatch("JVDTLab.JVLink")
    rc = jv.JVInit(SID)
    if rc != 0:
        raise RuntimeError(f"JVInit failed rc={rc}")

    rc, readcount, dlcount, lastfile = jv.JVOpen("RACE", fromtime, option, 0, 0, "")
    print(f"JVOpen RACE fromtime={fromtime} option={option} rc={rc} readcount={readcount} dlcount={dlcount} lastfile={lastfile}")
    if rc == -1:
        jv.JVClose()
        return [], max_ts
    if rc != 0:
        jv.JVClose()
        raise RuntimeError(f"JVOpen RACE failed rc={rc}")

    while dlcount > 0:
        status = jv.JVStatus()
        print(f"JVStatus {status}/{dlcount}")
        if status < 0:
            jv.JVClose()
            raise RuntimeError(f"JVStatus failed rc={status}")
        if status >= dlcount:
            break
        time.sleep(2)

    try:
        while True:
            ret = jv.JVRead("", 110000, "")
            rc, raw, filename = ret[0], ret[1], ret[-1]
            if rc == 0:
                break
            if rc == -1:
                continue
            if rc < -1:
                raise RuntimeError(f"JVRead failed rc={rc} filename={filename}")
            h = header(raw)
            if (
                h["year"] == date[:4]
                and h["mmdd"] == mmdd
                and h["jyo"] == jyo
                and h["race"] in races
                and h["record_id"] in ("RA", "SE", "HR")
                and is_final_result_file(str(h["record_id"]), filename)
            ):
                raw = recover_cp932_text(raw)
                ts = file_make_ts(filename) or str(lastfile or "00000000000000")
                max_ts = max(max_ts, ts)
                rows.append(wrapped_row(raw, filename, ingested_at, ts))
    finally:
        jv.JVClose()
    return rows, max_ts


def default_race_fromtime() -> str:
    if not STATE.exists():
        return "00000000000000"
    state = json.loads(STATE.read_text(encoding="utf-8"))
    return (
        state.get("specs", {}).get("RACE", {}).get("watermark")
        or state.get("watermarks", {}).get("RACE")
        or "00000000000000"
    )


def validate_rows(rows: list[dict], races: set[int]) -> dict:
    counts = Counter(r["record_id"] for r in rows)
    per_race: dict[int, Counter] = defaultdict(Counter)
    finish: dict[int, Counter] = defaultdict(Counter)
    files = Counter(r["raw_uri"] for r in rows)

    for row in rows:
        h = header(row["raw"])
        race = int(h["race"])
        per_race[race][row["record_id"]] += 1
        if row["record_id"] == "SE":
            parsed = JravanSourceAdapter.parse_record(row)
            pos = parsed.get("finish_position") if parsed else None
            finish[race][pos] += 1

    missing = []
    for race in sorted(races):
        if per_race[race]["RA"] < 1:
            missing.append(f"R{race}: missing RA")
        if per_race[race]["SE"] < 1:
            missing.append(f"R{race}: missing SE")
        if sum(n for pos, n in finish[race].items() if isinstance(pos, int) and pos > 0) < 1:
            missing.append(f"R{race}: no positive SE finish_position")
        if per_race[race]["HR"] < 1:
            missing.append(f"R{race}: missing HR")

    return {
        "counts": dict(counts),
        "per_race": {f"R{k:02d}": dict(v) for k, v in sorted(per_race.items())},
        "finish": {f"R{k:02d}": {str(pos): n for pos, n in v.items()} for k, v in sorted(finish.items())},
        "files": dict(files),
        "missing": missing,
    }


def write_snapshot(rows: list[dict], watermark_to: str, snapshot_id: str) -> Path:
    snap_dir = BRONZE / snapshot_id
    snap_dir.mkdir(parents=True, exist_ok=False)
    out = snap_dir / f"RACE.{snapshot_id}.0001.ndjson.gz"
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    info = {
        "file": out.name,
        "spec": "RACE",
        "rows": len(rows),
        "sha256": sha256_file(out),
        "watermark_to": watermark_to,
    }
    meta = {
        "snapshot_id": snapshot_id,
        "source_name": SOURCE_NAME,
        "ingested_at": dt.datetime.utcnow().isoformat() + "Z",
        "files": [info],
    }
    (snap_dir / "_snapshot.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return snap_dir


def copy_to_airlock(snap_dir: Path, airlock: Path) -> Path:
    dst = airlock / "incoming" / snap_dir.name
    if dst.exists():
        raise FileExistsError(f"airlock snapshot already exists: {dst}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(snap_dir, dst)
    return dst


def verify_manifest(snap_dir: Path) -> None:
    meta = json.loads((snap_dir / "_snapshot.json").read_text(encoding="utf-8"))
    for f in meta["files"]:
        path = snap_dir / f["file"]
        got = sha256_file(path)
        if got != f["sha256"]:
            raise RuntimeError(f"sha256 mismatch {path}: {got} != {f['sha256']}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Pull one target card's final RACE results.")
    ap.add_argument("--date", default="20260614", help="YYYYMMDD race date")
    ap.add_argument("--jyo", default="09", help="JRA venue code, e.g. 09=Hanshin")
    ap.add_argument("--races", default="1-12", help="Race range, currently only 1-12 style")
    ap.add_argument("--fromtime", default=None,
                    help="JVOpen fromtime. Defaults to the local RACE watermark.")
    ap.add_argument("--option", type=int, default=1,
                    help="JVOpen dataOption. Default 1=normal diff; option 3 may show JV-Link setup UI.")
    ap.add_argument("--snapshot-id", default=None)
    ap.add_argument("--to", default=None, help="USB airlock root, e.g. E:\\keibamon-xfer")
    ap.add_argument("--allow-partial", action="store_true", help="Write even if validation is incomplete")
    args = ap.parse_args()

    if args.races != "1-12":
        raise SystemExit("Only --races 1-12 is supported by this focused helper.")
    races = set(DEFAULT_RACES)
    fromtime = args.fromtime or default_race_fromtime()
    if args.option == 3:
        print("WARN: option=3 can trigger JV-Link setup UI. Prefer default option=1 for result retries.")
    rows, watermark_to = pull_rows(args.date, args.jyo, races, fromtime, args.option)
    report = validate_rows(rows, races)
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if report["missing"] and not args.allow_partial:
        print("Refusing to write/export: official final result slice is incomplete.")
        raise SystemExit(2)
    if not rows:
        print("No matching final result rows.")
        raise SystemExit(2)

    snapshot_id = args.snapshot_id or dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    snap_dir = write_snapshot(rows, watermark_to, snapshot_id)
    verify_manifest(snap_dir)
    print(f"wrote {snap_dir}")

    if args.to:
        dst = copy_to_airlock(snap_dir, Path(args.to))
        verify_manifest(dst)
        print(f"exported {dst}")


if __name__ == "__main__":
    main()
