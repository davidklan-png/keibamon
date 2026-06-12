"""ingest_jvlink.py -- Windows JV-Link -> immutable RAW bronze snapshot (keibamon).

RUN ON THE WINDOWS PC under a 32-bit Python venv (JV-Link is 32-bit COM):

    py -3.11-32 -m venv C:\\keibamon\\venv32
    C:\\keibamon\\venv32\\Scripts\\pip install pywin32
    set KEIBAMON_LAKE=D:\\keibamon\\data        # defaults to <repo>/data
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\ingest_jvlink.py setup  # full history (once)
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\ingest_jvlink.py pull   # delta (scheduled)

Bronze policy (see docs/data_architecture.md): store JV-Data records EXACTLY AS
RECEIVED (Shift-JIS text) plus the seven required metadata fields, so parsers can
be replayed when schemas change. Parsing into typed silver tables happens later,
on the Mac, in src/keibamon_core/adapters/jravan.py -- NOT here.

This is a SKELETON: confirm dataspec strings / JVOpen signature against your
JV-Data spec PDF and SDK version. The call flow, Shift-JIS handling, watermark
deltas, immutable snapshot writing, and manifest are complete in shape.
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import win32com.client  # pywin32 (Windows only)

SID = os.environ.get("JRAVAN_SID", "UNLP00000000")       # your JRA-VAN software ID
LAKE = Path(os.environ.get("KEIBAMON_LAKE", "data"))
BRONZE = LAKE / "raw" / "jravan"
STATE = BRONZE / "_state.json"
ENCODING = "cp932"                                        # Shift-JIS
SOURCE_NAME = "jravan"

# CONFIRM exact spec strings against your JV-Data spec PDF.
SETUP_SPECS = ["RACE", "BLOD", "MING", "SNAP", "SLOP", "WOOD"]
DELTA_SPECS = ["RACE", "MING", "SNAP"]


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {"watermarks": {}}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def assert_japanese_acp() -> None:
    """JV-Link converts Shift-JIS to Unicode via the Windows ANSI codepage.
    If ACP != 932 every Japanese byte is silently destroyed (observed as
    U+FFFD in bronze). Refuse to ingest rather than corrupt the lake."""
    import ctypes
    acp = ctypes.windll.kernel32.GetACP()
    if acp != 932:
        sys.exit(
            f"FATAL: Windows ANSI codepage is {acp}, need 932 (Japanese).\n"
            "Set: Settings > Time & Language > Language & Region > Administrative\n"
            "language settings > Change system locale > Japanese (Japan),\n"
            "uncheck 'Beta: Use Unicode UTF-8', then reboot."
        )


def open_jvlink():
    assert_japanese_acp()
    jv = win32com.client.Dispatch("JVDTLab.JVLink")
    rc = jv.JVInit(SID)
    if rc != 0:
        raise RuntimeError(f"JVInit failed rc={rc} (check JV-Link install / service key)")
    return jv


def pull_spec(jv, spec: str, fromtime: str, option: int):
    """Pull one dataspec; returns (records, new watermark).

    Corrupt-cache recovery (JRA-VAN FAQ): -402/-403 -> JVFiledelete the file,
    then RESTART from JVOpen (a mid-session re-read returns -503 "file not
    found"). Up to 4 JVOpen attempts per spec.
    """
    for attempt in range(1, 5):
        rc, readcount, dlcount, lastfile = jv.JVOpen(spec, fromtime, option, 0, 0, "")
        if rc == -1:                        # no matching data for this spec/window
            print(f"{spec}: no data (JVOpen rc=-1) - skipped")
            return [], fromtime
        if rc != 0:
            raise RuntimeError(f"JVOpen({spec}) failed rc={rc}")
        while dlcount > 0:                  # wait for JV-Link's async download
            st = jv.JVStatus()
            if st < 0:
                raise RuntimeError(f"JVStatus error {st} during {spec} download")
            print(f"\r{spec}: downloading {st}/{dlcount}", end="")
            if st >= dlcount:
                print()
                break
            time.sleep(2)
        records = []
        redo = False
        while True:
            ret = jv.JVRead("", 110000, "")   # v4.9: (rc, buff, size, filename)
            rc, buff, filename = ret[0], ret[1], ret[-1]
            if rc == 0:
                break                       # EOF: all files consumed
            if rc == -1:
                continue                    # file boundary
            if rc in (-402, -403, -503):    # corrupt or missing cached file
                if rc in (-402, -403):
                    jv.JVFiledelete(filename)
                print(f"{spec}: rc={rc} on {filename or '?'} - restart from JVOpen "
                      f"(attempt {attempt}/4)")
                redo = True
                break
            if rc < -1:
                raise RuntimeError(f"JVRead error {rc}")
            # Nao's speed trick: jv.JVSkip() here if `filename` is one we already hold.
            records.append((buff[:2], buff, filename))  # buff already str via BSTR
        jv.JVClose()
        if not redo:
            return records, (lastfile or fromtime)
    raise RuntimeError(f"{spec}: corrupt cache persists after 4 JVOpen attempts")


def write_snapshot(spec: str, records, file_ts: str, snapshot_id: str, ingested_at: str) -> dict:
    """Write one immutable gzip-NDJSON of raw records + the 7 bronze metadata fields."""
    snap_dir = BRONZE / snapshot_id
    snap_dir.mkdir(parents=True, exist_ok=True)
    out = snap_dir / f"{spec}.ndjson.gz"
    n = 0
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        for record_id, raw_text, src_file in records:
            content_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
            row = {
                "source_name": SOURCE_NAME,
                "source_record_id": f"{record_id}:{content_hash[:16]}",
                "raw_uri": src_file,
                "content_hash": content_hash,
                "ingested_at": ingested_at,
                "published_time": file_ts,     # JV file make-time; record-level refine in silver
                "available_at": file_ts,
                "record_id": record_id,
                "spec": spec,
                "raw": raw_text,
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1
    sha = hashlib.sha256(out.read_bytes()).hexdigest()
    return {"file": out.name, "spec": spec, "rows": n, "sha256": sha,
            "watermark_to": file_ts}


def run(mode: str) -> None:
    state = load_state()
    ingested_at = dt.datetime.utcnow().isoformat() + "Z"
    snapshot_id = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    specs = SETUP_SPECS if mode == "setup" else DELTA_SPECS
    option = 4 if mode == "setup" else 1

    jv = open_jvlink()
    files = []
    for spec in specs:
        wm_from = "00000000000000" if mode == "setup" else \
            state["watermarks"].get(spec, "00000000000000")
        records, wm_to = pull_spec(jv, spec, wm_from, option)
        if records:
            info = write_snapshot(spec, records, wm_to, snapshot_id, ingested_at)
            files.append(info)
            print(f"{spec}: {info['rows']} raw records -> raw/jravan/{snapshot_id}/{info['file']}")
        state["watermarks"][spec] = wm_to
        save_state(state)               # persist per spec: a later crash must not lose this watermark

    if files:
        manifest = {"snapshot_id": snapshot_id, "source_name": SOURCE_NAME,
                    "ingested_at": ingested_at, "files": files}
        (BRONZE / snapshot_id / "_snapshot.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    save_state(state)
    print(f"done: {mode} ({len(files)} files in snapshot {snapshot_id})")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "pull"
    if mode not in ("setup", "pull"):
        sys.exit("usage: ingest_jvlink.py [setup|pull]")
    run(mode)
