"""backfill_timeseries.py -- JVRTOpen per-race-key pull of 0B41/0B42 time-series.

WHY JVRTOpen (not JVOpen)
-------------------------
0B41/0B42 are 速報系 (realtime-tier) specs -- JVOpen returns rc=-111 for them
because JVOpen only handles 蓄積系 (accumulated) data.  The correct API is
JVRTOpen(spec, race_key), which returns the full time-series for ONE race.
JRA-VAN retains this data for ~1 year, so calling JVRTOpen for every race key
from the RACE bronze gives a trailing-year backfill.

RUN ON THE CAPTURE-PC (32-bit venv only -- JV-Link is 32-bit COM):

    python tools/whichdevice.py      # confirm capture-pc FIRST
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\backfill_timeseries.py

Steps
-----
1.  Device-role + ACP check.
2.  Entitlement probe: JVRTOpen("0B41", known_race_key).
        rc=0  or rc>0 → data found, entitled.
        rc=-1          → no data but call ok; entitled (check race key).
        rc<-1          → error; stop and report.
3.  Extract race keys from RACE bronze (RA records, bytes 11-26 = YYYYMMDDJJKKHHRRR).
    Filter to last LOOKBACK_DAYS days (JRA-VAN's ~1-year retention window).
4.  For each race key (sorted oldest-first):
        JVRTOpen("0B41", race_key) → drain → append to 0B41.ndjson.gz
        JVRTOpen("0B42", race_key) → drain → append to 0B42.ndjson.gz
        Mark complete in _progress.json (survives crash / resume).
5.  SHA-256 each output file, write _snapshot.json manifest.
6.  Robocopy to E:\\keibamon-xfer\\incoming\\<snapshot_id>\\.
    Mac: `make jravan-import` then `make silver`.

Manifest format (matches import_delta.py exactly)
--------------------------------------------------
    {
      "snapshot_id": "<YYYYMMDDTHHMMSS>",
      "source_name": "jravan",
      "ingested_at": "...",
      "files": [
        {"file": "0B41.ndjson.gz", "spec": "0B41", "rows": N, "sha256": "...", "watermark_to": "..."},
        {"file": "0B42.ndjson.gz", "spec": "0B42", "rows": M, "sha256": "...", "watermark_to": "..."}
      ]
    }

Resuming after a crash
-----------------------
Re-run exactly the same command.  The snapshot_id is stable (stored in
_state.json as "backfill_ts_snapshot_id").  Race keys already in
_progress.json["completed"] are skipped; the gzip files are opened in append
mode and new records are added after the existing ones.

Options
-------
--probe-only        Entitlement check only (no data pulled).
--probe-race-key K  Use this 16-char race key for the probe (default: inferred
                    from the most recent RACE bronze record).
--lookback N        Days to look back (default: 365).
--airlock PATH      USB airlock root (default: E:\\keibamon-xfer).
--specs A B         Specs to pull (default: 0B41 0B42).
--strict-device     Exit if not capture-pc (default: warn only).
--no-export         Skip robocopy step.
--race-keys A B … Override the race key list (skip RACE bronze scan; useful
                    for targeted re-pulls or single-race tests).
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import gzip
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import win32com.client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SID         = os.environ.get("JRAVAN_SID", "UNKNOWN")   # JV-Link uses its own registered key
LAKE        = Path(os.environ.get("KEIBAMON_LAKE", "data"))
BRONZE      = LAKE / "raw" / "jravan"
STATE       = BRONZE / "_state.json"
DEFAULT_AIRLOCK = Path(os.environ.get("KEIBAMON_AIRLOCK", r"E:\keibamon-xfer"))
SOURCE_NAME = "jravan"
ENCODING    = "cp932"

DEFAULT_SPECS    = ["0B41", "0B42"]
DEFAULT_LOOKBACK = 365


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def assert_japanese_acp() -> None:
    acp = ctypes.windll.kernel32.GetACP()
    if acp != 932:
        sys.exit(
            f"FATAL: Windows ACP={acp}, need 932. Disable 'Beta UTF-8' and reboot."
        )


def check_device_role(strict: bool) -> str:
    here = Path(__file__).resolve().parents[1]
    wd = here / "whichdevice.py"
    role = "UNKNOWN"
    if wd.exists():
        try:
            r = subprocess.run([sys.executable, str(wd), "--role"],
                               capture_output=True, text=True, timeout=10)
            role = r.stdout.strip()
        except Exception:
            pass
    if role != "capture-pc":
        msg = f"[backfill] {'FATAL' if strict else 'WARN'}: device role='{role}', expected 'capture-pc'."
        if strict:
            sys.exit(msg)
        print(msg)
    else:
        print(f"[backfill] device: {role} ✓")
    return role


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_state() -> dict:
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {}
    # Step 5 writes _state.json with only backfill_ts_snapshot_id, so an existing
    # file can lack "watermarks". Always guarantee the key (root cause of the
    # KeyError at finalize).
    state.setdefault("watermarks", {})
    return state


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Race key extraction from RACE bronze (RA records)
# Race key = bytes 11-26 (0-indexed) of the RA record, in cp932 encoding.
# All bytes 0-26 of the RA header are ASCII digits, so char index == byte index.
# Layout (from _RACE_ID_HEADER in adapters/jravan.py):
#   bytes 11-14: year (4)   YYYY
#   bytes 15-18: month_day (4)  MMDD
#   bytes 19-20: jyo_code (2)
#   bytes 21-22: kaiji (2)
#   bytes 23-24: nichiji (2)
#   bytes 25-26: race_num (2)
#   => race_key = bytes 11:27 (16 chars)
# ---------------------------------------------------------------------------
def extract_race_keys_from_bronze(lookback_days: int) -> list[str]:
    """Scan RACE.ndjson.gz files across all snapshots; return sorted unique race keys
    for races in the last ``lookback_days`` days."""
    cutoff = (dt.date.today() - dt.timedelta(days=lookback_days)).strftime("%Y%m%d")
    today  = dt.date.today().strftime("%Y%m%d")
    keys: set[str] = set()
    files_scanned = 0

    for snap in sorted(p for p in BRONZE.glob("*") if p.is_dir()):
        for gz in sorted(snap.glob("RACE*.ndjson.gz")):
            files_scanned += 1
            with gzip.open(gz, "rt", encoding="utf-8") as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    raw = row.get("raw", "")
                    if len(raw) < 27 or not raw.startswith("RA"):
                        continue
                    # race key is chars 11-26 (all ASCII in the header)
                    race_key = raw[11:27]
                    race_date = raw[11:19]   # YYYYMMDD portion
                    if not race_key.isdigit() or not race_date.isdigit():
                        continue
                    if cutoff <= race_date <= today:
                        keys.add(race_key)

    print(f"[backfill] scanned {files_scanned} RACE bronze file(s); "
          f"found {len(keys)} race keys in last {lookback_days} days "
          f"({cutoff} – {today})")
    return sorted(keys)


# ---------------------------------------------------------------------------
# JV-Link
# ---------------------------------------------------------------------------
def open_jvlink():
    assert_japanese_acp()
    jv = win32com.client.Dispatch("JVDTLab.JVLink")
    rc = jv.JVInit(SID)
    if rc != 0:
        sys.exit(f"[backfill] JVInit failed rc={rc}")
    return jv


def probe_entitlement(jv, race_key: str, spec: str = "0B41") -> bool:
    """JVRTOpen probe: rc=0 or rc=-1 → entitled.  Any other negative → error."""
    print(f"[backfill] probe: JVRTOpen({spec!r}, {race_key!r}) ...", end="", flush=True)
    try:
        rc = jv.JVRTOpen(spec, race_key)
    except Exception as exc:
        print(f"\n[backfill] JVRTOpen raised: {exc}")
        return False

    if rc >= 0:
        print(f" rc={rc} → entitled ✓")
        jv.JVClose()
        return True
    if rc == -1:
        print(f" rc=-1 → no data for this race key, but call succeeded → entitled ✓")
        return True

    print(f" rc={rc} → ERROR")
    print(
        f"[backfill] STOP: JVRTOpen returned rc={rc}.\n"
        "  If rc is in the -100..-299 range this is typically a subscription or\n"
        "  connection error.  Check the JV-Link status app and your JRA-VAN\n"
        "  membership.  Known working: JVRTOpen works when venv32 is used AND\n"
        "  JV-Link is installed and initialised (the June 14 0B30 capture proved this).\n"
        "  Try: python tools\\jravan\\backfill_timeseries.py --probe-only --probe-race-key <key>"
    )
    return False


def pull_one_race(jv, spec: str, race_key: str,
                  out_gz: Path, ingested_at: str) -> int:
    """JVRTOpen(spec, race_key) → drain → append to out_gz.  Returns records written.

    Opens out_gz in APPEND mode (creates multi-stream gzip, readable transparently).
    If the race has no data (rc=-1), writes nothing and returns 0.
    """
    rc = jv.JVRTOpen(spec, race_key)
    if rc == -1:
        return 0   # no data for this race/spec (too old, not yet run, etc.)
    if rc < -1:
        print(f"\n[backfill] {spec} {race_key}: JVRTOpen rc={rc} — skipping")
        return 0

    n = 0
    captured_at = dt.datetime.utcnow().isoformat() + "Z"

    with gzip.open(out_gz, "at", encoding="utf-8") as fh:
        while True:
            ret  = jv.JVRead("", 600000, "")
            rc_r = ret[0]
            buff = ret[1]
            if rc_r <= 0:
                break
            record_type  = buff[:2] if buff else "??"
            content_hash = hashlib.sha256(buff.encode("utf-8")).hexdigest()
            row = {
                "source_name":      SOURCE_NAME,
                "source_record_id": f"{record_type}:{content_hash[:16]}",
                "raw_uri":          race_key,
                "content_hash":     content_hash,
                "ingested_at":      ingested_at,
                "published_time":   captured_at,
                "available_at":     captured_at,
                "record_id":        record_type,
                "spec":             spec,
                "raw":              buff,
                "race_key":         race_key,
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += 1

    jv.JVClose()
    return n


# ---------------------------------------------------------------------------
# Progress tracking (survives crash / resume)
# ---------------------------------------------------------------------------
def load_progress(snap_dir: Path) -> dict:
    p = snap_dir / "_progress.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"completed": {}}   # {race_key: {spec: rows}}


def save_progress(snap_dir: Path, progress: dict) -> None:
    p = snap_dir / "_progress.json"
    p.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def robocopy_to_airlock(snap_dir: Path, airlock: Path, snapshot_id: str) -> None:
    dest = airlock / "incoming" / snapshot_id
    print(f"[backfill] robocopy → {dest}")
    # Explicit /R and /W override any machine-level ROBOCOPY env defaults
    # (e.g. /R:1000000 /W:30, which can hang the capture host ~1 year on a
    # single flaky USB write). Fail fast instead.
    result = subprocess.run(
        ["robocopy", str(snap_dir), str(dest), "/E", "/J", "/NP", "/R:3", "/W:5"])
    if result.returncode >= 8:
        print(f"[backfill] WARN: robocopy rc={result.returncode}")
    else:
        print(f"[backfill] export done (rc={result.returncode})")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill 0B41/0B42 via JVRTOpen per race key")
    ap.add_argument("--probe-only",     action="store_true")
    ap.add_argument("--probe-race-key", default=None,
                    help="16-char race key to use for entitlement probe "
                         "(default: inferred from most recent RACE bronze)")
    ap.add_argument("--lookback",       type=int, default=DEFAULT_LOOKBACK,
                    help=f"Days to look back for race keys (default: {DEFAULT_LOOKBACK})")
    ap.add_argument("--airlock",        default=str(DEFAULT_AIRLOCK))
    ap.add_argument("--specs",          nargs="+", default=DEFAULT_SPECS)
    ap.add_argument("--strict-device",  action="store_true")
    ap.add_argument("--no-export",      action="store_true")
    ap.add_argument("--race-keys",      nargs="+", default=None,
                    help="Override race key list (skip RACE bronze scan)")
    args = ap.parse_args()
    airlock = Path(args.airlock)

    # 1. Device + ACP
    check_device_role(strict=args.strict_device)

    # 2. JV-Link init
    jv = open_jvlink()
    print(f"[backfill] JVLink initialised")

    # 3. Race keys (needed even for probe, to pick a probe key)
    if args.race_keys:
        race_keys = sorted(args.race_keys)
        print(f"[backfill] using {len(race_keys)} manually specified race key(s)")
    else:
        race_keys = extract_race_keys_from_bronze(args.lookback)

    if not race_keys:
        sys.exit("[backfill] No race keys found. Check KEIBAMON_LAKE and --lookback.")

    # 4. Entitlement probe
    probe_key = args.probe_race_key or race_keys[-1]   # most recent race
    if not probe_entitlement(jv, probe_key, spec=args.specs[0]):
        sys.exit(1)

    if args.probe_only:
        print("[backfill] --probe-only: done.")
        return

    # 5. Setup snapshot dir (stable across resumes)
    state = load_state()
    if "backfill_ts_snapshot_id" not in state:
        state["backfill_ts_snapshot_id"] = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        save_state(state)
    snapshot_id = state["backfill_ts_snapshot_id"]
    snap_dir    = BRONZE / snapshot_id
    snap_dir.mkdir(parents=True, exist_ok=True)

    progress    = load_progress(snap_dir)
    ingested_at = dt.datetime.utcnow().isoformat() + "Z"

    # Per-spec row counters (include already-completed rows from prior runs)
    spec_rows: dict[str, int] = {
        spec: sum(
            progress["completed"].get(rk, {}).get(spec, 0)
            for rk in progress["completed"]
        )
        for spec in args.specs
    }

    total_races = len(race_keys)
    newly_done  = 0

    # 6. Main loop: one JVRTOpen call per spec per race key
    for i, race_key in enumerate(race_keys, 1):
        all_specs_done = all(
            race_key in progress["completed"] and
            spec in progress["completed"][race_key]
            for spec in args.specs
        )
        if all_specs_done:
            continue   # already fully processed this race key

        for spec in args.specs:
            if (race_key in progress["completed"] and
                    spec in progress["completed"][race_key]):
                continue   # this spec already done for this race

            out_gz = snap_dir / f"{spec}.ndjson.gz"
            n = pull_one_race(jv, spec, race_key, out_gz, ingested_at)
            spec_rows[spec] += n

            # Mark complete
            progress["completed"].setdefault(race_key, {})[spec] = n

        save_progress(snap_dir, progress)
        newly_done += 1

        if newly_done % 10 == 0 or i == total_races:
            pct = i / total_races * 100
            print(
                f"\r[backfill] {i}/{total_races} ({pct:.0f}%)  "
                + "  ".join(f"{s}={spec_rows[s]:,}" for s in args.specs),
                end="", flush=True
            )

    print()   # newline after progress

    # 7. Finalize manifest
    files = []
    for spec in args.specs:
        out_gz = snap_dir / f"{spec}.ndjson.gz"
        if not out_gz.exists():
            print(f"[backfill] {spec}: no output file (all races returned 0 records)")
            continue
        file_sha = sha256_file(out_gz)
        rows     = spec_rows[spec]
        # watermark_to: the most recent race key processed (YYYYMMDD.. sortable)
        wm_to    = max(
            (rk for rk, specs in progress["completed"].items() if spec in specs),
            default="00000000000000"
        )
        entry = {"file": out_gz.name, "spec": spec, "rows": rows,
                 "sha256": file_sha, "watermark_to": wm_to}
        files.append(entry)
        state["watermarks"][spec] = wm_to
        print(f"[backfill] {spec}: {rows:,} rows  wm={wm_to}  sha={file_sha[:16]}…")

    save_state(state)

    manifest = {"snapshot_id": snapshot_id, "source_name": SOURCE_NAME,
                "ingested_at": ingested_at, "files": files}
    (snap_dir / "_snapshot.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[backfill] manifest: {snap_dir / '_snapshot.json'}")

    # 8. announce_mdhm spot-check on 0B41
    b41 = snap_dir / "0B41.ndjson.gz"
    if b41.exists():
        try:
            with gzip.open(b41, "rt", encoding="utf-8") as fh:
                sample = json.loads(fh.readline())
            raw = sample.get("raw", "")
            # announce_mdhm at bytes 27-34 (all-ASCII header => char == byte)
            if len(raw) >= 35:
                mdhm = raw[27:35]
                ok   = mdhm.isdigit() and mdhm != "00000000"
                print(f"[backfill] announce_mdhm spot-check: '{mdhm}' "
                      f"({'OK — time-series field populated' if ok else 'WARN: zeroes or non-digit'})")
            else:
                print(f"[backfill] WARN: sample raw too short ({len(raw)} chars) to check announce_mdhm")
        except Exception as exc:
            print(f"[backfill] WARN: announce_mdhm check failed: {exc}")

    # 9. Summary
    print(f"\n[backfill] ── Summary ────────────────────────────")
    print(f"  snapshot_id  : {snapshot_id}")
    print(f"  races pulled : {newly_done}  (of {total_races} in window)")
    for f in files:
        print(f"  {f['spec']}  {f['rows']:>10,} rows  {f['sha256'][:12]}…")

    if not files:
        print("[backfill] No data. Nothing to export.")
        return

    # 10. Export
    if args.no_export:
        print(f"[backfill] --no-export: skip robocopy.")
        print(f"  Manual: robocopy {snap_dir} {airlock / 'incoming' / snapshot_id} /E /J /NP")
    else:
        robocopy_to_airlock(snap_dir, airlock, snapshot_id)
        print(
            "\n[backfill] Done. Mac next steps:\n"
            "    make jravan-import\n"
            "    make silver\n"
            "    python tools/validate_curve_signal.py"
        )


if __name__ == "__main__":
    main()
