"""check_acp.py -- capture-PC preflight: verify the Windows ANSI codepage is 932.

Standalone, stdlib-only, safe to run anytime (touches nothing). Run BEFORE any
capture session on the Windows PC:

    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\check_acp.py
    (any Python works; no pywin32 needed)

WHY: JV-Link returns Shift-JIS text as COM BSTRs, converted to Unicode by
Windows using the process ANSI codepage (ACP). If ACP != 932 (e.g. English
Windows defaults to 1252), every Japanese byte is silently mangled into
U+0192 + C1-orphan mojibake before Python ever sees it. This destroyed the
20260630T214859 snapshot (see docs/jra-van-windows-ingestion.md §8 and
docs/runbooks/pc-acp-recapture-20260702.md).

The capture tools carry their own hard guard (assert_japanese_acp) and a
write-time mojibake canary; this script exists so a human can verify the fix
(Region settings + reboot) WITHOUT starting a capture.

Exit code 0 = PASS (ACP 932), 1 = FAIL.
"""
from __future__ import annotations

import subprocess
import sys


def main() -> int:
    if sys.platform != "win32":
        print("check_acp: not Windows -- nothing to check on this device.")
        return 0

    import ctypes

    acp = ctypes.windll.kernel32.GetACP()
    ok = acp == 932
    print(f"ANSI codepage (GetACP): {acp} -> {'PASS' if ok else 'FAIL (need 932 / Japanese)'}")
    if not ok:
        print(
            "\nFix: Control Panel -> Region -> Administrative ->\n"
            "  'Change system locale...' -> Japanese (Japan)\n"
            "  Leave 'Beta: Use Unicode UTF-8 for worldwide language support' UNCHECKED.\n"
            "  Reboot, then run this script again."
        )

    # Informational: the ACP guard + mojibake canary only exist on main.
    try:
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        if branch:
            note = "" if branch == "main" else "  <-- WARNING: guards/canary only exist on main"
            print(f"git branch: {branch}{note}")
    except Exception:
        pass  # not in a repo / git unavailable -- ACP check already reported

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
