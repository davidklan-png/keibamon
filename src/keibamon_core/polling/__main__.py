"""CLI for race-day odds capture.

Example (Takarazuka Kinen, June 14 2026, Hanshin 11R):

    python3 -m keibamon_core.polling \\
        --race-id r-2026-0614-hanshin-11 \\
        --netkeiba-race-id 202609030411 \\
        --post-time 2026-06-14T15:40:00+09:00

Use --once for a single capture (e.g. to test connectivity the day before).
"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path

from keibamon_core.paths import LakePaths
from keibamon_core.polling.poller import PollTarget, poll_once, run_poller


def main() -> None:
    parser = argparse.ArgumentParser(description="Keibamon odds poller (announcement -> post)")
    parser.add_argument("--race-id", required=True, help="Internal race id, e.g. r-2026-0614-hanshin-11")
    parser.add_argument("--netkeiba-race-id", required=True, help="netkeiba race id, e.g. 202609030411")
    parser.add_argument(
        "--post-time",
        required=True,
        help="Scheduled post time, ISO-8601 with offset, e.g. 2026-06-14T15:40:00+09:00",
    )
    parser.add_argument("--data-root", default="data", help="Lake root directory (default: data)")
    parser.add_argument("--once", action="store_true", help="Poll a single time and exit")
    args = parser.parse_args()

    post_time = datetime.fromisoformat(args.post_time)
    if post_time.tzinfo is None:
        raise SystemExit("--post-time must include a UTC offset, e.g. +09:00")

    lake = LakePaths(root=Path(args.data_root))
    lake.ensure()
    target = PollTarget(
        race_id=args.race_id,
        netkeiba_race_id=args.netkeiba_race_id,
        post_time=post_time,
    )

    if args.once:
        result = poll_once(lake, target)
        print(
            f"captured {result.parsed_rows} rows ({result.new_rows} new) "
            f"at {result.captured_at.isoformat()} -> {result.raw_path}"
        )
        return

    polls = run_poller(lake, target)
    print(f"polling finished after {polls} captures")


if __name__ == "__main__":
    main()
