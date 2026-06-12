"""ingest_jvlink.py -- Windows JV-Link -> immutable RAW bronze snapshot (keibamon).

RUN ON THE WINDOWS PC under a 32-bit Python venv (JV-Link is 32-bit COM):

    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\ingest_jvlink.py setup  # full history (resumable)
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\ingest_jvlink.py pull   # delta (scheduled)

Bronze policy (see docs/data_architecture.md): store JV-Data records EXACTLY AS
RECEIVED plus the seven required metadata fields. Parsing into typed silver
tables happens later, on the Mac (src/keibamon_core/adapters/jravan.py).

Operational lessons baked in (validated live against JV-Link 4.9.0):
- pywin32 byref out-params return as a tuple; pass str placeholders, never bytes.
- Windows ACP must be 932 or JV-Link destroys Japanese text (hard guard).
- JVOpen download is async: wait on JVStatus before reading.
- -402/-403 corrupt cache: JVFiledelete + restart from JVOpen (-503 otherwise).
- Records STREAM to disk: a 32-bit process cannot hold a spec in RAM.
- CHUNKED sessions: one giant JVOpen/JVRead session slows quadratically
  (community-documented). Close and reopen every KEIBAMON_CHUNK_FILES files.
- RESUMABLE: per-file completion is tracked in _state.json and already-held
  files are JVSkip'd, so Ctrl+C / crash / reboot never lose finished work.
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

SID = os.environ.get("JRAVAN_SID", "UNKNOWN")
LAKE = Path(os.environ.get("KEIBAMON_LAKE", "data"))
BRONZE = LAKE / "raw" / "jravan"
STATE = BRONZE / "_state.json"
SOURCE_NAME = "jravan"
CHUNK_FILES = int(os.environ.get("KEIBAMON_CHUNK_FILES", "300"))
MAX_REDO = 6                       # corrupt-cache restarts allowed per spec

# CONFIRM exact spec strings against the JV-Data spec PDF.
SETUP_SPECS = ["RACE", "BLOD", "MING", "SNAP", "SLOP", "WOOD"]
DELTA_SPECS = ["RACE", "MING", "SNAP"]


def load_state() -> dict:
    if STATE.exists():
        state = json.loads(STATE.read_text(encoding="utf-8"))
    else:
        state = {}
    state.setdefault("specs", {})
    # discard legacy {"watermarks": ...} layout: those came from delta pulls;
    # using one as a setup fromtime would silently skip decades of history
    state.pop("watermarks", None)
    return state


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE)


def spec_state(state: dict, spec: str) -> dict:
    return state["specs"].setdefault(
        spec, {"watermark": "00000000000000", "files_done": []})


def assert_japanese_acp() -> None:
    """JV-Link converts Shift-JIS via the Windows ANSI codepage; ACP != 932
    silently destroys every Japanese byte. Refuse to corrupt the lake."""
    import ctypes
    acp = ctypes.windll.kernel32.GetACP()
    if acp != 932:
        sys.exit(
            f"FATAL: Windows ANSI codepage is {acp}, need 932 (Japanese).\n"
            "Settings > Time & Language > Language & Region > Administrative\n"
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


def _file_make_ts(filename: str) -> str | None:
    """JV file names embed the make datetime as the last 14 digits before
    the extension (e.g. JGDW2025061420250613112844.jvd -> 20250613112844)."""
    stem = filename.rsplit(".", 1)[0]
    ts = stem[-14:]
    return ts if len(ts) == 14 and ts.isdigit() else None


def _write_row(fh, spec: str, buff: str, filename: str, ingested_at: str,
               file_ts: str) -> None:
    content_hash = hashlib.sha256(buff.encode("utf-8")).hexdigest()
    fh.write(json.dumps({
        "source_name": SOURCE_NAME,
        "source_record_id": f"{buff[:2]}:{content_hash[:16]}",
        "raw_uri": filename,
        "content_hash": content_hash,
        "ingested_at": ingested_at,
        "published_time": file_ts,     # JV file make-time; refine in silver
        "available_at": file_ts,
        "record_id": buff[:2],
        "spec": spec,
        "raw": buff,                   # already str via BSTR (ACP=932 enforced)
    }, ensure_ascii=False) + "\n")


def _write_manifest(snap_dir: Path, snapshot_id: str, ingested_at: str,
                    files: list) -> None:
    (snap_dir / "_snapshot.json").write_text(json.dumps(
        {"snapshot_id": snapshot_id, "source_name": SOURCE_NAME,
         "ingested_at": ingested_at, "files": files},
        ensure_ascii=False, indent=2), encoding="utf-8")


def pull_spec(jv, spec: str, option: int, state: dict, snap_dir: Path,
              snapshot_id: str, ingested_at: str, manifest_files: list) -> None:
    """Pull one dataspec in chunked, resumable JVOpen sessions.

    Each session reads at most CHUNK_FILES new files then closes (one giant
    session degrades quadratically). Completed files are recorded in
    _state.json and JVSkip'd on any later pass, so interrupt/resume is safe
    and nothing is double-ingested. Each chunk lands as its own
    <spec>.<n>.ndjson.gz with the manifest rewritten after every chunk --
    a crash leaves a valid, exportable snapshot of all finished chunks.
    """
    st = spec_state(state, spec)
    done = set(st["files_done"])
    redo_count = 0
    chunk = 0
    while True:
        fromtime = st["watermark"]
        rc, readcount, dlcount, lastfile = jv.JVOpen(spec, fromtime, option, 0, 0, "")
        if rc == -1:
            print(f"{spec}: no data (JVOpen rc=-1) - done/skipped")
            return
        if rc != 0:
            raise RuntimeError(f"JVOpen({spec}) failed rc={rc}")
        while dlcount > 0:              # wait for JV-Link's async download
            stt = jv.JVStatus()
            if stt < 0:
                raise RuntimeError(f"JVStatus error {stt} during {spec} download")
            print(f"\r{spec}: downloading {stt}/{dlcount}", end="")
            if stt >= dlcount:
                print()
                break
            time.sleep(2)
        file_ts = lastfile or fromtime
        chunk += 1
        part = snap_dir / f"{spec}.{snapshot_id}.{chunk:04d}.ndjson.gz.part"
        n = 0
        new_files = 0
        current: str | None = None
        redo = False
        eof = False

        def complete(fname: str) -> None:
            nonlocal new_files
            done.add(fname)
            new_files += 1
            ts = _file_make_ts(fname)
            if ts and ts > st["watermark"]:
                st["watermark"] = ts

        snap_dir.mkdir(parents=True, exist_ok=True)
        with gzip.open(part, "wt", encoding="utf-8") as fh:
            while new_files < CHUNK_FILES:
                ret = jv.JVRead("", 110000, "")   # (rc, buff, size, filename)
                rc, buff, filename = ret[0], ret[1], ret[-1]
                if rc == 0:                       # EOF: everything consumed
                    if current is not None:
                        complete(current)
                    eof = True
                    break
                if rc == -1:                      # file boundary
                    if current is not None:
                        complete(current)
                    current = None
                    continue
                if rc in (-402, -403, -503):      # corrupt/missing cached file
                    if rc in (-402, -403):
                        jv.JVFiledelete(filename)
                    print(f"{spec}: rc={rc} on {filename or '?'} - restart from JVOpen "
                          f"({redo_count + 1}/{MAX_REDO})")
                    redo = True
                    break
                if rc < -1:
                    raise RuntimeError(f"JVRead error {rc}")
                if filename != current:
                    if current is not None:   # boundary -1 was missed
                        complete(current)
                    current = filename
                    if filename in done:          # already ingested: skip whole file
                        jv.JVSkip()
                        current = None
                        continue
                if current is None:               # records of a skipped file
                    continue
                _write_row(fh, spec, buff, filename, ingested_at, file_ts)
                n += 1
                if n % 50000 == 0:
                    print(f"{spec}: chunk {chunk}: {n} records "
                          f"({len(done)}/{readcount or '?'} files done)")
        jv.JVClose()

        if redo:
            part.unlink(missing_ok=True)
            redo_count += 1
            if redo_count >= MAX_REDO:
                raise RuntimeError(f"{spec}: corrupt cache persists after {MAX_REDO} restarts")
            continue

        if n > 0:
            out = part.with_name(part.name[:-5])  # strip .part
            part.replace(out)
            manifest_files.append({"file": out.name, "spec": spec, "rows": n,
                                   "sha256": _sha256_file(out),
                                   "watermark_to": st["watermark"]})
            _write_manifest(snap_dir, snapshot_id, ingested_at, manifest_files)
            print(f"{spec}: chunk {chunk} sealed: {n} records, "
                  f"{len(done)}/{readcount or '?'} files done")
        else:
            part.unlink(missing_ok=True)

        st["files_done"] = sorted(done)
        save_state(state)                          # durable per chunk

        if eof:
            print(f"{spec}: complete ({len(done)} files)")
            return


def run(mode: str) -> None:
    state = load_state()
    ingested_at = dt.datetime.utcnow().isoformat() + "Z"
    snapshot_id = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    specs = SETUP_SPECS if mode == "setup" else DELTA_SPECS
    option = 4 if mode == "setup" else 1
    snap_dir = BRONZE / snapshot_id

    jv = open_jvlink()
    manifest_files: list = []
    for spec in specs:
        pull_spec(jv, spec, option, state, snap_dir, snapshot_id,
                  ingested_at, manifest_files)
    print(f"done: {mode} ({len(manifest_files)} chunk files in snapshot {snapshot_id})")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "pull"
    if mode not in ("setup", "pull"):
        sys.exit("usage: ingest_jvlink.py [setup|pull]")
    run(mode)
