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


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pull_spec(jv, spec: str, fromtime: str, option: int,
              snapshot_id: str, ingested_at: str):
    """Pull one dataspec, STREAMING records straight to the bronze file.
    Returns (manifest_info | None, new_watermark).

    Records are written as they are read: a 32-bit process accumulating a
    full-history spec in RAM exhausts its ~2 GB address space and dies
    hours into a setup pull. Streaming keeps memory flat.

    Corrupt-cache recovery (JRA-VAN FAQ): -402/-403 -> JVFiledelete the
    file, then RESTART from JVOpen (mid-session re-read returns -503).
    Partial .part output is discarded on restart. Up to 4 attempts.
    """
    for attempt in range(1, 5):
        rc, readcount, dlcount, lastfile = jv.JVOpen(spec, fromtime, option, 0, 0, "")
        if rc == -1:                        # no matching data for this spec/window
            print(f"{spec}: no data (JVOpen rc=-1) - skipped")
            return None, fromtime
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
        file_ts = lastfile or fromtime
        snap_dir = BRONZE / snapshot_id
        snap_dir.mkdir(parents=True, exist_ok=True)
        part = snap_dir / f"{spec}.ndjson.gz.part"
        n = 0
        redo = False
        with gzip.open(part, "wt", encoding="utf-8") as fh:
            while True:
                ret = jv.JVRead("", 110000, "")   # v4.9: (rc, buff, size, filename)
                rc, buff, filename = ret[0], ret[1], ret[-1]
                if rc == 0:
                    break                   # EOF: all files consumed
                if rc == -1:
                    continue                # file boundary
                if rc in (-402, -403, -503):
                    if rc in (-402, -403):
                        jv.JVFiledelete(filename)
                    print(f"{spec}: rc={rc} on {filename or '?'} - restart from JVOpen "
                          f"(attempt {attempt}/4)")
                    redo = True
                    break
                if rc < -1:
                    raise RuntimeError(f"JVRead error {rc}")
                content_hash = hashlib.sha256(buff.encode("utf-8")).hexdigest()
                fh.write(json.dumps({
                    "source_name": SOURCE_NAME,
                    "source_record_id": f"{buff[:2]}:{content_hash[:16]}",
                    "raw_uri": filename,
                    "content_hash": content_hash,
                    "ingested_at": ingested_at,
                    "published_time": file_ts,   # JV file make-time; refine in silver
                    "available_at": file_ts,
                    "record_id": buff[:2],
                    "spec": spec,
                    "raw": buff,                 # already str via BSTR (ACP=932 enforced)
                }, ensure_ascii=False) + "\n")
                n += 1
                if n % 100000 == 0:
                    print(f"{spec}: {n} records...")
        jv.JVClose()
        if redo:
            part.unlink(missing_ok=True)    # discard partial output, reopen
            continue
        if n == 0:
            part.unlink(missing_ok=True)
            return None, file_ts
        out = snap_dir / f"{spec}.ndjson.gz"
        part.replace(out)
        return {"file": out.name, "spec": spec, "rows": n,
                "sha256": _sha256_file(out), "watermark_to": file_ts}, file_ts
    raise RuntimeError(f"{spec}: corrupt cache persists after 4 JVOpen attempts")


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
        info, wm_to = pull_spec(jv, spec, wm_from, option, snapshot_id, ingested_at)
        if info:
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
