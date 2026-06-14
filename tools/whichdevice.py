"""whichdevice.py -- print which device this checkout is, and the role's rules.

Run this FIRST when you (human or agent) start working, so device-specific
actions don't cross a boundary (see docs/device-topology.md). Source of truth is
the machine-local ``.device`` file at the repo root (gitignored, one per machine,
copied from ``.device.example``). If it's missing, this infers a best guess from
the OS/mount and tells you to create it.

    python tools/whichdevice.py            # human-readable
    python tools/whichdevice.py --role     # just the role token (for scripts)
"""
from __future__ import annotations

import os
import platform
import socket
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEVICE_FILE = REPO / ".device"

# role -> (one-line summary, CAN do, MUST NOT do)
ROLES = {
    "capture-pc": (
        "Windows always-on capture host of record (JV-Link).",
        ["run JV-Link bulk + realtime ingest (32-bit COM)",
         "push the live dashboard to D1 (holds CF_* creds)",
         "write bronze; export bronze to the USB for the Mac"],
        ["heavy ML / DuckDB (do that on the Mac)",
         "travel or sleep during a race day",
         "assume the lake is here (it's airgapped — USB only)"],
    ),
    "mac-dev": (
        "macOS dev workstation + lake owner + BACKUP capture.",
        ["edit code, run tests, build silver/gold, model (venv64)",
         "own the git repo and the data lake (source of truth)",
         "run the backup netkeiba feed / import the USB / git push"],
        ["run JV-Link (Windows-only)",
         "be the SOLE race-day capture host — it travels",
         "rely on `caffeinate -i` vs a closed lid (it won't hold)"],
    ),
    "cowork-sandbox": (
        "Linux ephemeral compute mounting the Mac repo (the Cowork agent).",
        ["read/edit repo files; run python/duckdb/tests in-sandbox",
         "query Cloudflare D1 via the MCP connector; web research"],
        ["git push (no creds) or commit (index.lock unlink fails)",
         "`make jravan-import` (USB not mounted in the sandbox)",
         "run JV-Link — defer all of the above to the Mac/human"],
    ),
}


def _read_device_file() -> dict:
    if not DEVICE_FILE.exists():
        return {}
    out = {}
    for line in DEVICE_FILE.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _infer_role() -> str:
    sys_name = platform.system()
    if sys_name == "Windows":
        return "capture-pc"
    if sys_name == "Linux" and "/sessions/" in str(REPO):
        return "cowork-sandbox"
    if sys_name == "Darwin":
        return "mac-dev"
    return "cowork-sandbox" if sys_name == "Linux" else "mac-dev"


def main() -> None:
    cfg = _read_device_file()
    inferred = _infer_role()
    role = cfg.get("role") or inferred
    declared = bool(cfg.get("role"))

    if "--role" in sys.argv:
        print(role)
        return

    summary, can, cannot = ROLES.get(role, ("UNKNOWN role.", [], []))
    host = cfg.get("hostname") or socket.gethostname()
    print(f"DEVICE: {role}   ({host}, {platform.system()})")
    print(f"  {summary}")
    if not declared:
        print(f"  ⚠ no .device file — INFERRED. Create one: cp .device.example .device  (set role)")
    print("  CAN:")
    for c in can:
        print(f"    + {c}")
    print("  MUST NOT:")
    for c in cannot:
        print(f"    - {c}")
    print("  See docs/device-topology.md for the full map.")
    if "CF_API_TOKEN" in os.environ:
        print("  CF_* creds: present in env (dashboard push possible).")
    elif role in ("capture-pc", "mac-dev"):
        print("  CF_* creds: NOT in env — dashboard push will fail until sourced.")


if __name__ == "__main__":
    main()
