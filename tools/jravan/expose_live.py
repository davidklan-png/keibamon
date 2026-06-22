"""expose_live.py -- publish registered races to the app the moment they exist.

ADR-0006. Near-real-time registration-exposure feed (Mac-only, scrape-sourced).

Each cycle:
  1. discover the day's registered races (one polite GET of the day index);
  2. for each, scrape entries (carrying opportunistic estimated odds) and the
     live win-odds API (empty until the pool opens);
  3. merge + assemble the live_snapshot document (per-race status: registered ->
     open -> result);
  4. upsert it into Cloudflare D1 (key='current') so the app shows the race
     immediately -- grayed with estimated odds until live odds post.

Run on the Mac (the stationary capture host per ADR-0004); needs CF_* env vars:

    PYTHONPATH=src ./venv64/bin/python tools/jravan/expose_live.py --interval 30

Polite-fetch is enforced inside netkeiba_http (rate floor); --interval is the
floor between discovery cycles, not a license to hammer. Ctrl-C to stop.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # for publish_d1

from keibamon_core.adapters import netkeiba_http  # noqa: E402
from keibamon_core.adapters.netkeiba_discovery import discover_card  # noqa: E402
from keibamon_core.adapters.netkeiba_entries import parse_entries_payload  # noqa: E402
from keibamon_core.adapters.netkeiba_payouts import parse_payouts_payload  # noqa: E402
from keibamon_core.adapters.netkeiba_results import parse_results_payload  # noqa: E402
from keibamon_core.live.result import build_result  # noqa: E402
from keibamon_core.live.snapshot import (  # noqa: E402
    build_live_snapshot,
    merge_entries_and_odds,
)
from keibamon_core.polling.netkeiba import (  # noqa: E402
    fetch_odds_payload,
    parse_odds_payload,
)
from publish_d1 import push_to_d1  # noqa: E402

_JST = ZoneInfo("Asia/Tokyo")

# JRA track code (positions 5-6 of the netkeiba id) -> display name.
VENUE_NAMES = {
    "01": "Sapporo", "02": "Hakodate", "03": "Fukushima", "04": "Niigata",
    "05": "Tokyo", "06": "Nakayama", "07": "Chukyo", "08": "Kyoto",
    "09": "Hanshin", "10": "Kokura",
}


def _today_jst() -> str:
    return datetime.now(_JST).strftime("%Y%m%d")


def in_window(now_jst: datetime, window: str) -> bool:
    """Is ``now`` (JST) inside the named publish window? (ADR-0006 scheduling.)

    Pure + testable so the launchd agents can fire on a coarse StartInterval and
    this gate decides whether there is actually anything to do — off-window fires
    exit in milliseconds, and a stray manual/launchd run can't publish at the
    wrong time. Weekday(): Mon=0 .. Sun=6.

      register : Thu 14:00-17:59 (special-G1 numbered entries) OR
                 Fri 10:00-21:59 (weekend numbered entries + estimated odds)
      race     : Sat/Sun 09:00-16:59 (race-day odds; JRA updates ~every 120s)
      any      : always (no gate)
    """
    if window in ("", "any"):
        return True
    wd, h = now_jst.weekday(), now_jst.hour
    if window == "race":
        return wd in (5, 6) and 9 <= h < 17
    if window == "register":
        return (wd == 3 and 14 <= h < 18) or (wd == 4 and 10 <= h < 22)
    return True  # unknown window name -> don't block


def _live_odds_by_umaban(nk_id: str, race_id: str) -> dict[int, float]:
    """Best-effort live win odds keyed by umaban. Empty pre-open (or on error)
    -- a missing pool must never kill the cycle."""
    try:
        payload = fetch_odds_payload(nk_id, "1")
        recs = parse_odds_payload(
            payload,
            race_id=race_id,
            raw_uri=f"netkeiba:{nk_id}",
            captured_at=datetime.now(timezone.utc),
        )
    except Exception as exc:  # noqa: BLE001 - one race must not kill the loop
        print(f"  {race_id}: odds fetch skipped ({exc!r})")
        return {}
    out: dict[int, float] = {}
    for r in recs:
        uma, win = r.get("horse_number"), r.get("win_odds")
        if uma is not None and win:
            out[uma] = win
    return out


def _entries_for(nk_id: str) -> list[dict]:
    """Scrape one shutuba page -> entry runner dicts (carry est_odds)."""
    try:
        url = f"https://race.netkeiba.com/race/shutuba.html?race_id={nk_id}"
        body, _ = netkeiba_http.fetch_payload(url)
        return parse_entries_payload(body, nk_id)
    except Exception as exc:  # noqa: BLE001
        print(f"  {nk_id}: entries fetch skipped ({exc!r})")
        return []


def _maybe_result(
    nk_id: str,
    race_id: str,
    *,
    post_time_jst: str | None,
    now_jst: datetime,
) -> dict | None:
    """Best-effort: fetch result.html -> build_result -> resolver block.

    Returns ``None`` (race stays ``open``) when:

      - the race hasn't started (post_time in the future);
      - the fetch fails (offline / rate-limited / malformed page);
      - the page parses but no placings could be derived (race still
        running, under 審議, or pre-result).

    A successful return means the race is OFFICIAL enough for the resolver:
    placings are present, payouts are present (or the resolver falls back to
    the commit-time estimate). Failure NEVER kills the publish cycle --
    the race dict is emitted without a ``result`` key and ``snapshot.build_race``
    leaves status at ``open``.

    Provenance / PIT: the result block carries only data scraped FROM the
    official result page, never anything pre-race. We do NOT attach a result
    block while ``post_time`` is in the future, even if result.html is
    reachable (e.g. a stale page from a prior running of the same race_no).
    """
    if post_time_jst:
        try:
            hh, mm = post_time_jst.split(":")[:2]
            post_at = now_jst.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
            if now_jst < post_at:
                return None  # race hasn't started -- don't risk a stale page
        except (ValueError, TypeError):
            pass  # unparseable post_time -- fall through and try the fetch
    try:
        url = f"https://race.netkeiba.com/race/result.html?race_id={nk_id}"
        body, _ = netkeiba_http.fetch_payload(url)
    except Exception as exc:  # noqa: BLE001
        print(f"  {race_id}: result fetch skipped ({exc!r})")
        return None
    finishers = parse_results_payload(body, nk_id)
    payouts = parse_payouts_payload(body, nk_id)
    block = build_result(finishers, payouts)
    if not block:
        return None
    return block


def _upcoming_weekend_dates(now_jst: datetime) -> list[str]:
    """Return the next Saturday/Sunday card dates from ``now``.

    Friday registration should expose both weekend cards. Saturday race-day
    should keep tomorrow visible too, so users can select Sunday's G3s without
    waiting for a separate publish key.
    """
    days_until_sat = (5 - now_jst.weekday()) % 7
    sat = (now_jst + timedelta(days=days_until_sat)).date()
    sun = sat + timedelta(days=1)
    return [sat.strftime("%Y%m%d"), sun.strftime("%Y%m%d")]


def _default_dates(now_jst: datetime, window: str) -> list[str]:
    if window == "register":
        return _upcoming_weekend_dates(now_jst)
    if window == "race" and now_jst.weekday() == 5:
        return _upcoming_weekend_dates(now_jst)
    return [now_jst.strftime("%Y%m%d")]


def _races_for_date(date_yyyymmdd: str) -> list[dict]:
    """Discover + scrape one race date; return raw race dicts for snapshot assembly."""
    discovered = discover_card(date_yyyymmdd)
    now_jst = datetime.now(_JST)
    races = []
    for d in discovered:
        entries = _entries_for(d.numeric_id)
        odds = _live_odds_by_umaban(d.numeric_id, d.canonical_race_id) if entries else {}
        runners = merge_entries_and_odds(entries, odds)
        race: dict = {
            "date": d.date_yyyymmdd,
            "race_no": d.race_no,
            "race_id": d.canonical_race_id,
            "name": d.race_name or f"Race {d.race_no}",
            "grade_label": d.grade_label,
            "post_time_jst": d.post_time_jst,
            "venue": VENUE_NAMES.get(d.venue_code, d.venue_code),
            "runners": runners,
        }
        # ADR-0007 R1: best-effort attach a `result` block for finished races.
        # snapshot.build_race flips status to "result" when the key is present;
        # the app's auto-settle + the social Worker's cron sweep then resolve
        # OPEN tickets on this race. Failure (no result / fetch error / under
        # 審議) leaves the key absent and the race stays "open".
        result = _maybe_result(
            d.numeric_id,
            d.canonical_race_id,
            post_time_jst=d.post_time_jst,
            now_jst=now_jst,
        )
        if result is not None:
            race["result"] = result
        races.append(race)
    return races


def build_once(date_yyyymmdd: str) -> dict:
    """Discover + scrape + assemble one snapshot document for the date."""
    races = _races_for_date(date_yyyymmdd)
    return build_live_snapshot(races, date=date_yyyymmdd, source="netkeiba-live")


def build_dates(dates_yyyymmdd: list[str]) -> dict:
    """Discover + scrape + assemble one snapshot across one or more race dates."""
    races: list[dict] = []
    for date in dates_yyyymmdd:
        races.extend(_races_for_date(date))
    meta_date = dates_yyyymmdd[0] if len(dates_yyyymmdd) == 1 else ",".join(dates_yyyymmdd)
    return build_live_snapshot(races, date=meta_date, source="netkeiba-live")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--date", default=None, help="YYYYMMDD (default: today JST)")
    ap.add_argument("--dates", default=None, help="comma-separated YYYYMMDD dates")
    ap.add_argument("--interval", type=int, default=30, help="seconds between cycles")
    ap.add_argument("--key", default="current", help="D1 live_snapshot key")
    ap.add_argument("--once", action="store_true", help="one cycle then exit")
    ap.add_argument(
        "--skip-empty",
        action="store_true",
        help="don't publish (or overwrite) when no races are registered yet -- "
        "use for scheduled fires that may land outside a race window",
    )
    ap.add_argument(
        "--window",
        default="any",
        choices=["any", "race", "register"],
        help="only act inside this JST publish window; exit fast otherwise",
    )
    args = ap.parse_args()

    # Fail fast if creds are missing -- push_to_d1 reads CF_* via os.environ and
    # would otherwise fail silently every cycle (the cross-shell trap in CLAUDE.md).
    import os

    missing = [k for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN") if not os.environ.get(k)]
    if missing:
        sys.exit(f"missing required env vars: {', '.join(missing)}")

    print(f"expose_live: publishing registered races every {args.interval}s (Ctrl-C to stop)")
    while True:
        now_jst = datetime.now(_JST)
        if not in_window(now_jst, args.window):
            print(f"[{now_jst:%a %H:%M} JST] outside {args.window} window — skip")
            if args.once:
                break
            time.sleep(max(5, args.interval))
            continue
        if args.dates:
            dates = [d.strip() for d in args.dates.split(",") if d.strip()]
        elif args.date:
            dates = [args.date]
        else:
            dates = _default_dates(now_jst, args.window)
        try:
            snap = build_dates(dates)
            c = snap["meta"]["counts"]
            if args.skip_empty and c["total"] == 0:
                print(f"[{datetime.now(timezone.utc):%H:%M:%S}Z] no races registered — skip")
            else:
                push_to_d1(snap, key=args.key)
                print(
                    f"[{datetime.now(timezone.utc):%H:%M:%S}Z] published {c['total']} races "
                    f"({c['registered']} registered, {c['open']} open)"
                )
        except Exception as exc:  # noqa: BLE001 - loud, but keep the loop alive
            print(f"cycle failed: {exc!r}")
        if args.once:
            break
        time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
