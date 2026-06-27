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
import re
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
from publish_d1 import (  # noqa: E402
    fetch_race_card_max,
    fetch_snapshot,
    push_to_d1,
    upsert_race_card_max,
)

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

      register : Thursday or Friday, ANY hour. JRA's shutuba (出走馬) finalizes
                 Thursday — the publish time wanders inside the 13:00-16:00 JST
                 band week-to-week, so an hour gate on Thursday would miss early
                 publishes (the 2026-06-25 case: weekend G3 rosters were already
                 public at 13:00 JST but the old Thu 14:00-17:59 gate let the
                 launchd agent skip every fire before 14:00). The launchd
                 agent's 30-min StartInterval is the actual sample cadence; this
                 function only decides whether a fire is allowed to do real
                 work. ``--skip-empty`` plus the completeness guard
                 (``race_card_max``) protect the snapshot when a fire lands
                 before netkeiba has published. Saturday/Sunday morning is
                 owned by the ``race`` window (the two windows don't overlap).
      race     : Sat/Sun 09:00-18:59 JST. The 9:00-17:00 portion covers the
                 race-day odds feed (JRA updates ~every 120s; last race on a
                 Sat/Sun card is typically 15:30-16:00). The 17:00-18:59
                 extension (ADR-0007 R2 Task 2) catches late 確定: a race
                 that finishes near 16:00 + a 30+min 審議 can confirm after
                 the old 17:00 cutoff. Without the extension, those races
                 never attached a result block, so the Phase-4 sweep couldn't
                 settle them. The cycle is full (entries+odds+result), not
                 result-only — see R2 prompt's Option A vs B trade-off.
      any      : always (no gate)
    """
    if window in ("", "any"):
        return True
    wd, h = now_jst.weekday(), now_jst.hour
    if window == "race":
        return wd in (5, 6) and 9 <= h < 19
    if window == "register":
        # Thursday roster capture: drop the hour gate. See docstring above.
        return wd in (3, 4)
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


def _parse_surface_distance(
    distance: str | None,
) -> tuple[str | None, int | None]:
    """Parse netkeiba's RaceList_ItemLong cell (e.g. "芝1800m" / "ダ1400m")
    into (surface, distance_m).

    Surface: 芝→"turf", ダ→"dirt" (ダート abbreviated to ダ on the index page).
    Distance_m: the integer before the trailing 'm'. Returns (None, None) on
    any miss — never fabricates. Source: discover_card already extracts this
    field from the day-index page; no extra fetch needed here.
    """
    if not distance:
        return None, None
    s = distance.strip()
    surface: str | None = None
    if s.startswith("芝"):
        surface = "turf"
    elif s.startswith("ダ"):
        surface = "dirt"
    # Distance: first run of digits anywhere in the cell. tolerate missing
    # trailing 'm' and surrounding whitespace.
    m = re.search(r"(\d+)\s*m?", s)
    dist_m = int(m.group(1)) if m else None
    return surface, dist_m


def _maybe_result(
    nk_id: str,
    race_id: str,
    *,
    post_time_jst: str | None,
    now_jst: datetime,
    race_date_yyyymmdd: str | None = None,
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

    ``race_date_yyyymmdd`` (R4 fix): the SCHEDULED race date, so the
    "hasn't started" gate can be evaluated against the race's actual post
    time (race_date + post_time), not today's calendar day at the post
    hour. Without this, re-publishing a past race day (e.g. verifying the
    Saturday card on Monday) incorrectly computed ``post_at = today at
    HH:MM`` -- which is in the future -- and gated out every result fetch,
    producing a 36-race snapshot with zero result blocks. The original
    race-day-cycle path (same-day publish) is unaffected.
    """
    if post_time_jst:
        try:
            hh, mm = post_time_jst.split(":")[:2]
            if race_date_yyyymmdd:
                # R4: pin post_at to the SCHEDULED race date + post time.
                # now_jst < post_at then correctly evaluates "has the race
                # started" for past-day re-publishes.
                d = datetime.strptime(race_date_yyyymmdd, "%Y%m%d")
                post_at = datetime(
                    d.year, d.month, d.day, int(hh), int(mm), tzinfo=_JST
                )
            else:
                # Legacy same-day path: today at HH:MM. Equivalent to the
                # pre-R4 behavior when race_date is unknown.
                post_at = now_jst.replace(
                    hour=int(hh), minute=int(mm), second=0, microsecond=0
                )
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


def _races_for_date(
    date_yyyymmdd: str,
    *,
    prior_by_race_id: dict[str, dict] | None = None,
) -> list[dict]:
    """Discover + scrape one race date; return raw race dicts for snapshot assembly.

    ``prior_by_race_id`` (R4 fix): map of race_id -> prior captured race dict
    (typically from the currently-deployed snapshot). When a fresh result fetch
    returns None (the page is gone, network blip, parser hiccup), the prior
    result block is carried forward instead of being lost. This is defense-
    in-depth against buggy re-publishes: a result that was OFFICIALLY captured
    once stays in the snapshot until a NEW official result replaces it. The
    alternative -- silently dropping the result -- is exactly the failure that
    bit the verification pass: a Monday re-publish of Saturday's card produced
    a 36-race snapshot with zero result blocks because netkeiba's result.html
    momentarily parsed empty for every race.
    """
    discovered = discover_card(date_yyyymmdd)
    now_jst = datetime.now(_JST)
    prior_by_race_id = prior_by_race_id or {}
    races = []
    for d in discovered:
        entries = _entries_for(d.numeric_id)
        odds = _live_odds_by_umaban(d.numeric_id, d.canonical_race_id) if entries else {}
        runners = merge_entries_and_odds(entries, odds)
        surface, distance_m = _parse_surface_distance(d.distance)
        race: dict = {
            "date": d.date_yyyymmdd,
            "race_no": d.race_no,
            "race_id": d.canonical_race_id,
            "name": d.race_name or f"Race {d.race_no}",
            "grade_label": d.grade_label,
            "post_time_jst": d.post_time_jst,
            "venue": VENUE_NAMES.get(d.venue_code, d.venue_code),
            "surface": surface,
            "distance_m": distance_m,
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
            race_date_yyyymmdd=date_yyyymmdd,
        )
        if result is not None:
            race["result"] = result
        else:
            # R4: carry forward a prior captured result so a transient fetch
            # miss or post-time gate doesn't drop already-official results.
            prior_race = prior_by_race_id.get(d.canonical_race_id)
            prior_result = (prior_race or {}).get("result")
            if prior_result:
                race["result"] = prior_result
                race["result_source"] = "prior"  # provenance for the audit trail
        races.append(race)
    return races


def build_once(date_yyyymmdd: str) -> dict:
    """Discover + scrape + assemble one snapshot document for the date."""
    races = _races_for_date(date_yyyymmdd)
    return build_live_snapshot(races, date=date_yyyymmdd, source="netkeiba-live")


def build_dates(
    dates_yyyymmdd: list[str],
    *,
    prior_snapshot: dict | None = None,
) -> dict:
    """Discover + scrape + assemble one snapshot across one or more race dates.

    ``prior_snapshot`` (R4 fix): if provided, per-race result blocks that
    can't be freshly fetched are carried forward from this snapshot. See
    ``_races_for_date`` for the rationale.
    """
    prior_by_race_id: dict[str, dict] = {}
    if prior_snapshot:
        for r in prior_snapshot.get("races", []):
            rid = r.get("race_id")
            if rid and r.get("result"):
                prior_by_race_id[rid] = r
    races: list[dict] = []
    for date in dates_yyyymmdd:
        races.extend(_races_for_date(date, prior_by_race_id=prior_by_race_id))
    meta_date = dates_yyyymmdd[0] if len(dates_yyyymmdd) == 1 else ",".join(dates_yyyymmdd)
    return build_live_snapshot(races, date=meta_date, source="netkeiba-live")


def _race_counts_by_date(snap: dict | None) -> dict[str, int]:
    """Per-date race counts in a snapshot. Falls back to ``meta.date`` when a
    race dict doesn't carry its own ``date`` (the legacy single-date shape)."""
    if not snap:
        return {}
    fallback = (snap.get("meta") or {}).get("date") or ""
    counts: dict[str, int] = {}
    for r in snap.get("races", []):
        d = r.get("date") or fallback or ""
        counts[d] = counts.get(d, 0) + 1
    return counts


def _venue_code_for(venue_name: str | None) -> str:
    """Inverse of VENUE_NAMES — display name back to the 2-digit JRA code so
    we can join against race_card_max (keyed on venue_code). Unknown display
    names pass through verbatim; that's fine for the guard's lookup (it just
    won't find a max for that key, treated as no prior floor)."""
    if not venue_name:
        return ""
    for code, name in VENUE_NAMES.items():
        if name == venue_name:
            return code
    return venue_name


def _race_counts_by_date_venue(snap: dict | None) -> dict[tuple[str, str], int]:
    """Per-(date, venue_code) race counts in a snapshot. The guard's primary
    signal: a truncated card shows up as one venue's count below its prior
    high-water mark even when the date-level total looks fine (e.g. Tokyo
    dropping 12 -> 8 while Hakodate and Hanshin stay at 12 — total 36 -> 32
    is visible at the date level too, but per-venue pins WHICH venue
    regressed)."""
    if not snap:
        return {}
    fallback_date = (snap.get("meta") or {}).get("date") or ""
    counts: dict[tuple[str, str], int] = {}
    for r in snap.get("races", []):
        d = str(r.get("date") or fallback_date or "")
        v = _venue_code_for(r.get("venue"))
        if not v:
            continue
        counts[(d, v)] = counts.get((d, v), 0) + 1
    return counts


# Per-(date, venue) floor below which a publish is REFUSED. JRA cards at a
# single venue on a race day are typically 10-12 races; 8 is an extreme
# outlier (typhoon cancellations, single-digit cards at small tracks). A
# venue below this floor on a date we've never seen before can't be detected
# by the race_card_max check alone (no prior high-water to compare), so this
# structural prior is the backstop for the "first publish for a date was
# already truncated" hole. Set conservatively low — it's a tripwire, not a
# predictor.
STRUCTURAL_VENUE_FLOOR = 6


def should_skip_publish(
    new: dict | None,
    existing: dict | None,
    card_max: dict[tuple[str, str], int] | None = None,
) -> tuple[bool, str]:
    """Completeness guard. Return ``(skip, reason)``.

    The rule: a publish must NOT overwrite ``key='current'`` when the new
    snapshot regresses ANY (date, venue) below the high-water mark we've
    previously published. Two independent baselines:

    1. ``card_max`` (from race_card_max in D1): the historical max per
       (date, venue). A publish that would lower it is REFUSED — the existing
       snapshot keeps the better view. This survives across publishes, so a
       transient discover_card miss can't lower the bar over time.
    2. ``existing`` snapshot's per-(date, venue) counts: an additional floor
       for the very first publish after deploy (when race_card_max is empty).
       The prior publish's actual counts stand in for the missing max.

    A structural floor (``STRUCTURAL_VENUE_FLOOR``) catches the residual hole:
    a FIRST-EVER publish for a date where the producer misses late races on
    every fetch -- no prior max, no existing snapshot, but a venue at e.g.
    4 races is obviously broken. We flag (don't refuse) below the floor so
    the dashboard still gets SOMETHING, but the meta carries a ``partial``
    marker and the operator is paged.

    Returns ``(True, reason)`` to refuse; ``(False, "")`` to allow.

    Note: this is a one-shot fetch-then-write -- not atomic against concurrent
    publishers. The Mac publisher is single-threaded per cycle (one launchd
    fire -> one process -> one write), so the race window doesn't exist in
    production.
    """
    new_counts = _race_counts_by_date_venue(new)
    if not new_counts:
        return False, ""  # empty new snapshot -- let --skip-empty handle it
    card_max = card_max or {}

    # If we have an existing snapshot, derive per-(date, venue) counts from it
    # as an additional floor (covers first-publish-after-deploy when
    # race_card_max hasn't accumulated yet).
    existing_counts = _race_counts_by_date_venue(existing) if existing else {}

    regressed = []
    for key, n_new in sorted(new_counts.items()):
        n_prior_max = card_max.get(key)
        n_existing = existing_counts.get(key)
        n_floor: int | None = None
        for candidate in (n_prior_max, n_existing):
            if candidate is not None and (n_floor is None or candidate > n_floor):
                n_floor = candidate
        if n_floor is not None and n_new < n_floor:
            regressed.append(f"{key[0]}|{key[1]}: {n_new} < {n_floor}")

    if regressed:
        return True, "regressed venue(s): " + ", ".join(regressed)
    return False, ""


def partial_flag(
    new: dict | None,
    card_max: dict[tuple[str, str], int] | None = None,
) -> tuple[bool, list[str]]:
    """Return ``(is_partial, warnings)`` for a snapshot that's about to publish.

    A "partial" snapshot is one where a venue is below the STRUCTURAL floor
    (a JRA card almost never has < 6 races at a venue on a normal race day)
    -- the guard's race_card_max check can't catch this for a FIRST-EVER
    publish for the date (no prior high-water), so this is the backstop.

    Returns ``(False, [])`` for a healthy publish. The publisher writes
    ``meta.counts.partial`` from the boolean and surfaces ``warnings`` in the
    cycle log so an operator sees the flag at publish time.
    """
    new_counts = _race_counts_by_date_venue(new)
    warnings = []
    for (date, venue), n in sorted(new_counts.items()):
        if n < STRUCTURAL_VENUE_FLOOR:
            warnings.append(f"{date}|{venue}: {n} races (below floor {STRUCTURAL_VENUE_FLOOR})")
    return bool(warnings), warnings


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
            # Fetch the existing snapshot ONCE per cycle -- used by both the
            # completeness guard (per-venue floor) and the result-carry-forward
            # merge (so a buggy re-publish can't drop official results).
            try:
                existing = fetch_snapshot(key=args.key)
            except Exception as fetch_exc:  # noqa: BLE001
                print(
                    f"[{datetime.now(timezone.utc):%H:%M:%S}Z] existing-snapshot fetch failed "
                    f"({fetch_exc!r}); guard and result-merge will run without prior"
                )
                existing = None
            snap = build_dates(dates, prior_snapshot=existing)
            c = snap["meta"]["counts"]
            if args.skip_empty and c["total"] == 0:
                print(f"[{datetime.now(timezone.utc):%H:%M:%S}Z] no races registered — skip")
            else:
                # Completeness guard (ADR-0007 R4 -- Tokyo truncation
                # root cause): refuse to overwrite 'current' when ANY
                # (date, venue) in the new snapshot is below the historical
                # high-water mark (race_card_max) OR the existing snapshot's
                # counts. The R3 guard compared only per-date totals -- a
                # 32->32 re-publish passed, advancing the timestamp while
                # the card stayed broken. R4 gates on per-(date, venue)
                # floors drawn from a separate D1 table that survives across
                # publishes; a transient discover_card miss can't lower it.
                try:
                    card_max = fetch_race_card_max(dates)
                except Exception as guard_exc:  # noqa: BLE001
                    print(
                        f"[{datetime.now(timezone.utc):%H:%M:%S}Z] card_max fetch failed "
                        f"({guard_exc!r}); guard will use existing snapshot only"
                    )
                    card_max = {}
                skip, reason = should_skip_publish(snap, existing, card_max)
                # Backstop: even if the per-venue max check passes, a venue
                # below the STRUCTURAL floor on a first-ever publish for the
                # date is flagged in meta.counts.partial so the deployed JSON
                # is self-describing.
                is_partial, partial_warns = partial_flag(snap, card_max)
                if is_partial:
                    snap["meta"]["counts"]["partial"] = True
                    snap["meta"]["counts"]["partial_reasons"] = partial_warns
                else:
                    snap["meta"]["counts"]["partial"] = False
                if skip:
                    print(
                        f"[{datetime.now(timezone.utc):%H:%M:%S}Z] REFUSED regressed publish "
                        f"({reason}); keeping existing snapshot"
                    )
                else:
                    push_to_d1(snap, key=args.key)
                    # Advance the high-water mark so the next cycle's guard
                    # sees this publish as the new floor. Idempotent --
                    # equal-or-smaller counts are no-ops.
                    new_counts = _race_counts_by_date_venue(snap)
                    try:
                        upsert_race_card_max(new_counts)
                    except Exception as upsert_exc:  # noqa: BLE001
                        print(
                            f"[{datetime.now(timezone.utc):%H:%M:%S}Z] card_max upsert failed "
                            f"({upsert_exc!r}); next-cycle guard will lag"
                        )
                    partial_note = " [PARTIAL]" if is_partial else ""
                    by_venue_str = ", ".join(
                        f"{v}={n}" for (_, v), n in sorted(new_counts.items())
                    )
                    print(
                        f"[{datetime.now(timezone.utc):%H:%M:%S}Z] published {c['total']} races "
                        f"({c['registered']} registered, {c['open']} open) "
                        f"by_venue[{by_venue_str}]{partial_note}"
                    )
                    if partial_warns:
                        for w in partial_warns:
                            print(f"  PARTIAL: {w}")
        except Exception as exc:  # noqa: BLE001 - loud, but keep the loop alive
            print(f"cycle failed: {exc!r}")
        if args.once:
            break
        time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
