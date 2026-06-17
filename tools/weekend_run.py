"""weekend_run.py -- CLI entry for the weekend pipeline (ADR-0003).

Each subcommand is one stage and enforces its own device guard, so you cannot,
say, run `track` on the wrong host. Run `python tools/whichdevice.py` first.

    # Mac (Thu/Fri): pick the card and freeze our odds pre-market
    python tools/weekend_run.py select --date 20260620
    python tools/weekend_run.py post   --date 20260620

    # Capture host (race day): live odds curve -- the only unrecoverable job
    python tools/weekend_run.py track  --date 20260620

    # Mac (after results land): settle + score the card
    python tools/weekend_run.py settle --date 20260620

This is a thin shell over keibamon_core.weekend.pipeline; the stages are stubs
pending implementation on the Mac (venv64).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from keibamon_core.weekend import pipeline  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Keibamon weekend pipeline (ADR-0003).")
    parser.add_argument(
        "stage", choices=["select", "post", "track", "settle"],
        help="which weekend stage to run (each guards its own device).",
    )
    parser.add_argument("--date", required=True, help="race date, YYYYMMDD")
    args = parser.parse_args(argv)

    # Stubs raise NotImplementedError / WrongDeviceError with actionable messages.
    print(f"[weekend_run] stage={args.stage} date={args.date}")
    print("[weekend_run] stages are stubs (ADR-0003); implement on the Mac. "
          "This entry point exists to lock the device guards + CLI shape.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
