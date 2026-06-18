"""day_runner.py -- orchestrate realtime odds capture for all races on a race day.

Spawns one realtime_jvlink.py subprocess per race, starting each at T-120min.
Subprocess isolation means one crashed race doesn't kill others, and JV-Link
COM state stays clean across concurrent venues (Hanshin + Hakodate etc.).

Usage:
    # Run all races from a manifest file
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\day_runner.py
        --manifest tools\\jravan\\manifests\\2026-06-14.json

    # Build a manifest stub from today's date (fill in post times manually or
    # via race_manifest.py once MING silver parsing is available)
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\day_runner.py
        --build-manifest 2026-06-14

Manifest format (JSON array):
    [
      {
        "race_key":  "2026061409030401",   // 16-digit JV-Link key
        "post_time": "2026-06-14T10:05:00+09:00",
        "label":     "Hanshin R1"          // optional, for log readability
      },
      ...
    ]

Storage estimate (tiered cadence, O1-O6, ~40 KB/snapshot):
    ~350 polls/race  →  ~14 MB/race  →  ~508 MB / 36-race Sunday
    O7/O8 only from T-30 — captured within the same pool, stored when stp <= 1800s.

Key design decisions baked in:
    - One subprocess per race: crash isolation + COM state isolation.
    - Subprocesses are started at T-early (default 120 min) regardless of whether
      JVRTOpen returns data yet (rc=-1 just means no data yet; the loop retries).
    - Day runner exits after all subprocesses finish (blocking wait).
    - SIGINT (Ctrl+C) to day_runner sends SIGINT to all children and waits.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

VENV_PYTHON = Path(os.environ.get(
    "KEIBAMON_VENV32_PYTHON",
    r"C:\keibamon\venv32\Scripts\python.exe"
))
RUNNER = Path(os.environ.get(
    "KEIBAMON_RT_SCRIPT",
    r"C:\keibamon\tools\jravan\realtime_jvlink.py"
))
MANIFEST_DIR = Path(r"C:\keibamon\tools\jravan\manifests")

TZ_JST = dt.timezone(dt.timedelta(hours=9))


# ---------------------------------------------------------------------------
# Manifest helpers
# ---------------------------------------------------------------------------
def load_manifest(path: Path) -> list[dict]:
    races = json.loads(path.read_text(encoding="utf-8"))
    for r in races:
        if "race_key" not in r or "post_time" not in r:
            raise ValueError(f"Manifest entry missing race_key or post_time: {r}")
    return races


def build_manifest_stub(date_str: str) -> Path:
    """Write an empty manifest stub the user can fill in."""
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    out = MANIFEST_DIR / f"{date_str}.json"
    if out.exists():
        print(f"Manifest already exists: {out}")
        return out
    stub = [
        {
            "race_key":  f"{date_str.replace('-','')}0000000000",
            "post_time": f"{date_str}T10:00:00+09:00",
            "label":     "FILL IN — see JRA race card"
        }
    ]
    out.write_text(json.dumps(stub, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Stub written: {out}")
    print("Edit it with the correct race_key and post_time for each race, then rerun.")
    return out


# ---------------------------------------------------------------------------
# Subprocess launcher
# ---------------------------------------------------------------------------
def launch_race(race: dict, early: int, tail: int, pool: str) -> subprocess.Popen:
    label = race.get("label", race["race_key"])
    cmd = [
        str(VENV_PYTHON), str(RUNNER),
        "--race-key",  race["race_key"],
        "--post-time", race["post_time"],
        "--pool",      pool,
        "--early",     str(early),
        "--tail",      str(tail),
    ]
    print(f"[day_runner] launching: {label}  key={race['race_key']}  post={race['post_time']}")
    return subprocess.Popen(cmd, text=True)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def run(manifest: list[dict], early: int, tail: int, pool: str) -> None:
    # Sort by post time so we launch in race order
    manifest = sorted(manifest, key=lambda r: r["post_time"])

    procs: list[tuple[dict, subprocess.Popen]] = []
    launched: set[str] = set()

    interrupted = False

    def _sigint(sig, frame):
        nonlocal interrupted
        interrupted = True
        print("\n[day_runner] Ctrl+C — sending SIGINT to all children...")
        for _, p in procs:
            try:
                p.send_signal(signal.CTRL_C_EVENT)  # Windows
            except Exception:
                pass

    signal.signal(signal.SIGINT, _sigint)

    print(f"[day_runner] {len(manifest)} races queued  early={early}min  tail={tail}min  pool={pool}")

    while not interrupted:
        now = dt.datetime.now(tz=TZ_JST)

        # Launch any race whose T-early window has arrived
        for race in manifest:
            key = race["race_key"]
            if key in launched:
                continue
            post = dt.datetime.fromisoformat(race["post_time"])
            if now >= post - dt.timedelta(minutes=early):
                p = launch_race(race, early, tail, pool)
                procs.append((race, p))
                launched.add(key)

        # Check for finished subprocesses
        for race, p in procs:
            if p.poll() is not None:
                label = race.get("label", race["race_key"])
                rc = p.returncode
                status = "ok" if rc == 0 else f"FAILED rc={rc}"
                print(f"[day_runner] {label} finished: {status}")

        # All launched and all done?
        all_launched = len(launched) == len(manifest)
        all_done = all(p.poll() is not None for _, p in procs)
        if all_launched and all_done:
            print("[day_runner] all races complete.")
            break

        time.sleep(10)   # check every 10s

    # Wait for any stragglers
    for race, p in procs:
        p.wait()
    print("[day_runner] exited.")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="Keibamon realtime day orchestrator")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--manifest",       help="Path to race manifest JSON")
    group.add_argument("--build-manifest", metavar="YYYY-MM-DD",
                       help="Write a manifest stub for a date and exit")
    ap.add_argument("--pool",  default="0B30")
    ap.add_argument("--early", type=int, default=120,
                    help="Minutes before post to start capture (default: 120)")
    ap.add_argument("--tail",  type=int, default=5,
                    help="Minutes after post to keep capturing (default: 5)")
    args = ap.parse_args()

    if args.build_manifest:
        build_manifest_stub(args.build_manifest)
        return

    manifest_path = Path(args.manifest)
    if not manifest_path.exists():
        sys.exit(f"Manifest not found: {manifest_path}")

    manifest = load_manifest(manifest_path)
    run(manifest, args.early, args.tail, args.pool)


if __name__ == "__main__":
    main()
