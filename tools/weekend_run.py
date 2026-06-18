"""weekend_run.py -- CLI entry for the weekend pipeline (ADR-0003 / ADR-0004).

Each subcommand is one stage and enforces its own device guard (in
``keibamon_core.weekend.pipeline``), so you cannot, say, run ``track`` on the
wrong host. Run ``python tools/whichdevice.py`` first.

    # Mac (Thu/Fri): pick the card and freeze our odds pre-market
    python tools/weekend_run.py select --date 20260620
    python tools/weekend_run.py post   --date 20260620

    # Mac (race day): live odds curve -- the only unrecoverable job.
    # The Mac must be stationary with lid-close sleep disabled (ADR-0003 D5).
    # --nk-race-ids is required for live capture (the netkeiba race_id encodes
    # kai/nichi and cannot be derived from --date/--venue alone).
    python tools/weekend_run.py track  --date 20260620 --venue hanshin \
                                       --nk-race-ids 202609030401,202609030402,...

    # Mac (after results land): settle + score the card
    python tools/weekend_run.py settle --date 20260620

This is a thin shell over ``keibamon_core.weekend.pipeline``; the stages wire
existing modules together. ``select`` and ``track`` are implemented (ADR-0004);
``post``/``settle`` are reached via their pipeline functions directly.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from keibamon_core.paths import LakePaths  # noqa: E402
from keibamon_core.weekend import pipeline  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Keibamon weekend pipeline (ADR-0003).")
    parser.add_argument(
        "stage", choices=["select", "post", "track", "settle"],
        help="which weekend stage to run (each guards its own device).",
    )
    parser.add_argument("--date", required=True, help="race date, YYYYMMDD")
    # options shared by select / track; ignored for stages that don't use them.
    parser.add_argument(
        "--venue",
        help="select/track. racecourse/venue slug (e.g. hanshin). Select matches "
             "the races mart's racecourse; track maps via netkeiba's VENUE_JYO.",
    )
    parser.add_argument(
        "--races",
        help="select/track. comma-separated race numbers (e.g. 1,2,3). Select "
             "filters the mart to this subset; track defaults to R1..R12.",
    )
    parser.add_argument(
        "--nk-race-ids",
        help="track only. comma-separated netkeiba race ids (parallel to the canonical "
             "ids derived from --date/--venue/--races). Required for live capture.",
    )
    parser.add_argument(
        "--post-times-jst",
        help="track only. comma-separated HH:MM post times (parallel to race_ids). "
             "Enables the adaptive cadence near post.",
    )
    parser.add_argument(
        "--poll-seconds", type=int, default=120,
        help="track only. nominal poll cadence. Default 120s.",
    )
    parser.add_argument(
        "--max-cycles", type=int, default=None,
        help="track only. stop after N cycles (smoke-test). Default: run forever.",
    )
    parser.add_argument(
        "--no-sleep-inhibit", action="store_true",
        help="track only. skip the caffeinate spawn (use after disabling lid sleep "
             "manually, or in environments without caffeinate).",
    )
    # select-only options; ignored for other stages.
    parser.add_argument(
        "--min-field-size", type=int, default=1,
        help="select only. drop races whose entries are not yet posted "
             "(field_size below this). Default 1.",
    )
    parser.add_argument(
        "--include-run", action="store_true",
        help="select only. include races that have already run "
             "(results_available == True). Default: upcoming only.",
    )
    args = parser.parse_args(argv)

    if args.stage == "select":
        return _run_select(args)

    if args.stage == "track":
        return _run_track(args)

    # post/settle wiring already lives in pipeline; the CLI for those stages is
    # intentionally minimal here. They raise NotImplementedError or
    # WrongDeviceError with actionable messages when invoked directly via their
    # pipeline functions.
    print(f"[weekend_run] stage={args.stage} date={args.date}")
    print("[weekend_run] use keibamon_core.weekend.pipeline directly for this stage.")
    return 0


def _run_select(args: argparse.Namespace) -> int:
    """Dispatch to pipeline.select. The device guard lives in the pipeline
    (single source of truth); the CLI just parses filters and prints."""
    if len(args.date) != 8 or not args.date.isdigit():
        raise SystemExit(f"--date must be YYYYMMDD, got {args.date!r}")
    race_nos = _parse_race_numbers(args.races) if args.races else None
    lake = LakePaths()
    lake.ensure()
    race_ids = pipeline.select(
        lake, args.date,
        venue=args.venue,
        min_field_size=args.min_field_size,
        include_run=args.include_run,
        races=race_nos,
    )
    for rid in race_ids:
        print(rid)
    print(f"[select] date={args.date} venue={args.venue or '*'} "
          f"selected={len(race_ids)}")
    return 0


def _run_track(args: argparse.Namespace) -> int:
    """Dispatch to pipeline.track. The device guard lives in the pipeline
    (single source of truth); the CLI just builds race_ids + parallel lists."""
    from keibamon_core.ingestion.curve_log import VENUE_JYO

    if args.venue is None:
        raise SystemExit("track needs --venue (e.g. hanshin)")
    venue = args.venue.lower()
    if venue not in VENUE_JYO:
        raise SystemExit(f"unknown venue {args.venue!r}; known: {sorted(VENUE_JYO)}")
    jyo = VENUE_JYO[venue]
    yyyy = args.date[:4]
    mmdd = args.date[4:]
    if len(args.date) != 8 or not args.date.isdigit():
        raise SystemExit(f"--date must be YYYYMMDD, got {args.date!r}")

    race_nos = _parse_race_numbers(args.races) if args.races else list(range(1, 13))
    race_ids = [f"jra-{yyyy}{mmdd}-{jyo}-{n:02d}" for n in race_nos]

    nk_race_ids = (
        [s.strip() for s in args.nk_race_ids.split(",") if s.strip()]
        if args.nk_race_ids else None
    )
    post_times_jst = (
        [s.strip() for s in args.post_times_jst.split(",") if s.strip()]
        if args.post_times_jst else None
    )

    lake = LakePaths()
    lake.ensure()
    result = pipeline.track(
        lake, race_ids,
        poll_seconds=args.poll_seconds,
        inhibit_sleep=not args.no_sleep_inhibit,
        nk_race_ids=nk_race_ids,
        post_times_jst=post_times_jst,
        max_cycles=args.max_cycles,
    )

    cycles = result.get("cycles") or []
    last = cycles[-1] if cycles else {}
    last_d1 = (last.get("d1") or {}).get("status", "?")
    print(
        f"[track] date={args.date} venue={venue} races={len(race_ids)} "
        f"cycles={len(cycles)} last_banked={last.get('snapshots_banked', 0)} "
        f"last_push={last_d1}"
    )
    # Preflight warnings already printed at startup by pipeline.track; surface
    # a brief reminder of which preflight failed (if any) so the summary line
    # carries the operational status without re-emitting the full warning.
    preflight = result.get("preflight") or {}
    flagged = [k for k in ("cf_creds", "sleep") if preflight.get(k)]
    if flagged:
        print(f"[track] preflight warnings: {','.join(flagged)}", file=sys.stderr)
    return 0


def _parse_race_numbers(spec: str) -> list[int]:
    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            out.append(int(chunk))
        except ValueError:
            raise SystemExit(f"bad --races entry {chunk!r}") from None
    return sorted(set(out))


if __name__ == "__main__":
    raise SystemExit(main())
