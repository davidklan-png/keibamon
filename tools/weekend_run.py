"""weekend_run.py -- CLI entry for the weekend pipeline (ADR-0003 / ADR-0004).

Each subcommand is one stage and enforces its own device guard (in
``keibamon_core.weekend.pipeline``), so you cannot, say, run ``track`` on the
wrong host. Run ``python tools/whichdevice.py`` first.

    # Mac (Thu/Fri): pick the card and freeze our odds pre-market
    python tools/weekend_run.py select --date 20260620
    python tools/weekend_run.py post   --date 20260620

    # Mac (race day): live odds curve -- the only unrecoverable job.
    # The Mac must be stationary with lid-close sleep disabled (ADR-0003 D5).
    #
    # PREFERRED form -- self-resolving, no lookups (ADR-0003/0004 polite-volume
    # default: live odds = graded only). Requires a prior `scrape_ingest.py`
    # card scrape so the lake carries each graded race's netkeiba_race_id +
    # post time + grade:
    python tools/weekend_run.py track --date 20260621 --grades G1,G2,G3
    # resolves *which* races are graded (across all venues that day), their
    # post times, and the netkeiba ids they live-capture at -- from the lake.
    #
    # FALLBACK form -- explicit args (use when the lake lacks the self-resolve
    # mapping, e.g. a quick test on a known race):
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
    parser.add_argument(
        "--grades",
        help="select/track. comma-separated grade labels (e.g. G1,G2,G3) to "
             "filter to graded races only. The ADR-0003/0004 polite-volume "
             "default for live odds is graded only. Pass --grades G1,G2,G3,JG1,"
             "JG2,JG3 to include jump grades. None (default) = all races.",
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
    grades = _parse_grades(args.grades) if args.grades else None
    lake = LakePaths()
    lake.ensure()
    race_ids = pipeline.select(
        lake, args.date,
        venue=args.venue,
        min_field_size=args.min_field_size,
        include_run=args.include_run,
        races=race_nos,
        grades=grades,
    )
    for rid in race_ids:
        print(rid)
    print(f"[select] date={args.date} venue={args.venue or '*'} "
          f"grades={','.join(grades) if grades else '*'} "
          f"selected={len(race_ids)}")
    return 0


def _run_track(args: argparse.Namespace) -> int:
    """Dispatch to pipeline.track. Two modes:

    1. **Self-resolve** (PREFERRED): ``--grades G1,G2,G3`` with no --venue.
       Resolve graded race_ids + post times + netkeiba ids from the lake
       (requires a prior card scrape via ``scrape_ingest.py``).
    2. **Explicit** (fallback): ``--venue`` + parallel lists of --races /
       --nk-race-ids / --post-times-jst.

    The device guard lives in the pipeline (single source of truth).
    """
    if len(args.date) != 8 or not args.date.isdigit():
        raise SystemExit(f"--date must be YYYYMMDD, got {args.date!r}")
    grades = _parse_grades(args.grades) if args.grades else None

    lake = LakePaths()
    lake.ensure()

    if args.venue is None:
        # Self-resolve mode: requires --grades (the polite default).
        # --venue absent AND --grades absent -> SystemExit (the guardrail
        # against accidentally running the unfiltered track without nk ids).
        if grades is None:
            raise SystemExit(
                "track needs either --venue (explicit mode) or --grades "
                "(self-resolve mode). Self-resolve requires a prior card scrape."
            )
        race_ids, nk_race_ids, post_times_jst, race_names = _self_resolve_track(
            args.date, grades, lake=lake,
        )
        venue_label = "(multi-venue)"
    else:
        venue_label, race_ids, nk_race_ids, post_times_jst = _explicit_track_args(args)
        race_names = None

    if not race_ids:
        print(
            f"[track] no races selected for date={args.date} "
            f"grades={','.join(grades) if grades else '*'}. Nothing to capture."
        )
        return 0

    result = pipeline.track(
        lake, race_ids,
        poll_seconds=args.poll_seconds,
        inhibit_sleep=not args.no_sleep_inhibit,
        nk_race_ids=nk_race_ids,
        post_times_jst=post_times_jst,
        race_names=race_names,
        max_cycles=args.max_cycles,
    )

    cycles = result.get("cycles") or []
    last = cycles[-1] if cycles else {}
    last_d1 = (last.get("d1") or {}).get("status", "?")
    print(
        f"[track] date={args.date} venue={venue_label} races={len(race_ids)} "
        f"cycles={len(cycles)} last_banked={last.get('snapshots_banked', 0)} "
        f"last_push={last_d1}"
    )
    preflight = result.get("preflight") or {}
    flagged = [k for k in ("cf_creds", "sleep") if preflight.get(k)]
    if flagged:
        print(f"[track] preflight warnings: {','.join(flagged)}", file=sys.stderr)
    return 0


def _self_resolve_track(
    date_yyyymmdd: str,
    grades: tuple[str, ...],
    *,
    lake: "LakePaths | None" = None,
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Resolve race_ids + nk ids + post times + names from the lake.

    Requires the races mart to carry ``netkeiba_race_id`` and ``grade`` per
    race -- i.e. the card was scraped via ``scrape_ingest.py`` first. A graded
    race with no stored netkeiba_race_id is named and skipped with a warning;
    we never fabricate an id (a wrong nk id = wrong curve, unrecoverable).

    ``lake`` defaults to ``LakePaths()`` (the production lake); tests inject a
    tmp_path-rooted lake to exercise the lookup offline.
    """
    from keibamon_core import lake_query
    from keibamon_core.ingestion.marts import MART_RACES

    if lake is None:
        lake = LakePaths()
    mart_path = lake.mart(MART_RACES)
    if not mart_path.exists():
        raise SystemExit(
            "races mart is missing -- run `scrape_ingest.py --date ... --header` "
            "first so the lake carries each graded race's netkeiba_race_id + post time."
        )

    target_date = pipeline._normalize_race_date(date_yyyymmdd)
    placeholders = ", ".join("?" for _ in grades)
    sql = (
        f"SELECT race_id, scheduled_post_time, netkeiba_race_id, racecourse "
        f"FROM {lake_query.src(mart_path)} "
        f"WHERE CAST(race_date AS DATE) = ? "
        f"  AND grade IN ({placeholders}) "
        f"ORDER BY scheduled_post_time NULLS LAST, race_id"
    )
    params: list = [target_date, *grades]
    rows = lake_query.query(sql, params=params).to_pylist()

    race_ids: list[str] = []
    nk_race_ids: list[str] = []
    post_times_jst: list[str] = []
    race_names: list[str] = []
    skipped: list[str] = []
    for r in rows:
        rid = r["race_id"]
        nk = r.get("netkeiba_race_id")
        if not nk:
            # Loud warn + skip. Never fabricate an id.
            skipped.append(rid)
            print(
                f"[track] WARNING: {rid} ({r.get('racecourse')}) has no stored "
                "netkeiba_race_id -- skipping. Re-run `scrape_ingest.py --header`.",
                file=sys.stderr,
            )
            continue
        post_jst = _post_time_to_jst_hhmm(r.get("scheduled_post_time"))
        race_ids.append(rid)
        nk_race_ids.append(nk)
        post_times_jst.append(post_jst or "")
        race_names.append(f"{r.get('racecourse') or 'Race'} R{pipeline._parse_race_no(rid)}")

    if skipped:
        print(
            f"[track] self-resolve: {len(race_ids)} graded race(s) ready, "
            f"{len(skipped)} skipped (no nk id)",
            file=sys.stderr,
        )
    return race_ids, nk_race_ids, post_times_jst, race_names


def _explicit_track_args(
    args: argparse.Namespace,
) -> tuple[str, list[str], list[str] | None, list[str] | None]:
    """Build the canonical race_ids + parallel lists from --venue/--races/etc."""
    from keibamon_core.ingestion.curve_log import VENUE_JYO

    venue = args.venue.lower()
    if venue not in VENUE_JYO:
        raise SystemExit(f"unknown venue {args.venue!r}; known: {sorted(VENUE_JYO)}")
    jyo = VENUE_JYO[venue]
    yyyy = args.date[:4]
    mmdd = args.date[4:]
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
    return venue, race_ids, nk_race_ids, post_times_jst


def _post_time_to_jst_hhmm(utc_dt: Any) -> str | None:
    """Convert a UTC scheduled_post_time (datetime) back to JST 'HH:MM' for the
    track loop's adaptive-cadence helper. Returns None if the input is null."""
    from datetime import timedelta, timezone

    if not utc_dt:
        return None
    try:
        # DuckDB returns tz-aware values; coerce and shift to JST.
        if utc_dt.tzinfo is None:
            from datetime import datetime as _dt
            utc_dt = _dt.replace(utc_dt, tzinfo=timezone.utc)
        jst = utc_dt.astimezone(timezone(timedelta(hours=9)))
        return f"{jst.hour:02d}:{jst.minute:02d}"
    except (AttributeError, TypeError, ValueError):
        return None


def _parse_grades(spec: str) -> tuple[str, ...]:
    """Parse a comma-separated --grades value into a validated tuple."""
    from keibamon_core.adapters.jravan import GRADE_CODE_MAP

    # Valid grade labels are the values of GRADE_CODE_MAP (G1/G2/G3/JG1/JG2/JG3).
    valid = set(GRADE_CODE_MAP.values())
    out: list[str] = []
    for chunk in spec.split(","):
        label = chunk.strip().upper()
        if not label:
            continue
        if label not in valid:
            raise SystemExit(
                f"unknown grade {label!r}; valid: {sorted(valid)} "
                "(case-insensitive)"
            )
        out.append(label)
    if not out:
        raise SystemExit("--grades given but parsed to empty list")
    return tuple(out)


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
