from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from keibamon_core.ingestion.odds import append_combo_odds_snapshots, append_odds_snapshots
from keibamon_core.paths import LakePaths
from keibamon_core.polling.netkeiba import (
    POOL_TYPES,
    fetch_odds_payload,
    parse_combo_odds_payload,
    parse_odds_payload,
)

BRONZE_ODDS_SOURCE = "odds_netkeiba"
STOP_AFTER_POST = timedelta(minutes=10)

# (threshold before post, poll interval) — checked top-down.
_SCHEDULE: tuple[tuple[timedelta, timedelta], ...] = (
    (timedelta(hours=3), timedelta(minutes=15)),
    (timedelta(hours=1), timedelta(minutes=10)),
    (timedelta(minutes=30), timedelta(minutes=5)),
    (timedelta(minutes=10), timedelta(minutes=2)),
    (timedelta(0), timedelta(minutes=1)),
)


@dataclass(frozen=True)
class PollTarget:
    """A race to capture: internal id, netkeiba id, and scheduled post time."""

    race_id: str
    netkeiba_race_id: str
    post_time: datetime


MAX_BACKOFF = timedelta(minutes=30)   # cadence ceiling when nothing is changing
FINAL_WINDOW = timedelta(minutes=10)  # never back off inside this window before post


@dataclass(frozen=True)
class PollResult:
    captured_at: datetime
    raw_paths: tuple[str, ...]   # raw payloads ARCHIVED this cycle (changed pools only)
    parsed_rows: int             # total parsed rows across all pools this cycle
    new_rows: int                # total newly-appended silver rows this cycle
    changed: bool = False        # did any pool's payload differ from the last seen?


def next_poll_interval(now: datetime, post_time: datetime) -> timedelta | None:
    """Cadence tightens as post time approaches; None means stop polling.

    >=3h out: 15 min, 1-3h: 10 min, 30-60m: 5 min, 10-30m: 2 min,
    final 10 minutes and just past post: 1 min. Stops 10 minutes after post
    (captures the final/confirmed odds update).
    """
    remaining = post_time - now
    if remaining < -STOP_AFTER_POST:
        return None
    for threshold, interval in _SCHEDULE:
        if remaining >= threshold:
            return interval
    return _SCHEDULE[-1][1]


def poll_once(
    lake: LakePaths,
    target: PollTarget,
    fetch: Callable[[str, str], str] | None = None,
    now: datetime | None = None,
    odds_types: tuple[str, ...] | None = None,
) -> PollResult:
    """One capture cycle across every pool type: fetch -> archive raw -> silver.

    For each pool ``odds_type`` (default: all of POOL_TYPES -- win/place plus the
    exotics) we issue one GET, ALWAYS archive the raw payload to bronze under a
    type-labelled path, then parse to silver. Archiving is unconditional so the
    capture is preserved even if a parser is wrong or the payload is empty
    (pre-announcement) -- the live odds curve cannot be backfilled, so raw
    capture is the irreplaceable step and silver parsing can be replayed later.

    Win/place (type 1) flows through the confirmed ``parse_odds_payload`` into
    the odds_snapshots table; exotics use the provisional combo parser into
    combo_odds_snapshots (see netkeiba.parse_combo_odds_payload).

    CONSERVATIVE / change-detection: each pool's payload is hashed and compared to
    the last seen (per-race state file). An UNCHANGED payload is skipped entirely
    -- not re-archived, not re-parsed -- so we keep exactly one raw copy per
    distinct state and never duplicate work. ``PollResult.changed`` reports whether
    anything moved this cycle, which lets ``run_poller`` back off when the source
    is idle. (The source is still queried each cycle; conditional GETs in
    ``fetch_odds_payload`` also avoid re-downloading bytes when the server supports
    If-Modified-Since/ETag.)
    """
    fetch = fetch or fetch_odds_payload
    captured_at = now or datetime.now(timezone.utc)
    odds_types = odds_types or tuple(POOL_TYPES)
    stamp = captured_at.strftime("%Y%m%dT%H%M%S%fZ")

    race_dir = lake.bronze_source_dir(BRONZE_ODDS_SOURCE) / target.netkeiba_race_id
    state = _load_poll_state(race_dir)

    raw_paths: list[str] = []
    parsed_rows = new_rows = 0
    changed = False

    for odds_type in odds_types:
        try:
            payload_text = fetch(target.netkeiba_race_id, odds_type)
        except TypeError:  # back-compat: a 1-arg fetch stub (win/place only)
            payload_text = fetch(target.netkeiba_race_id)  # type: ignore[call-arg]

        digest = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
        if state.get(odds_type) == digest:
            continue  # unchanged since last poll: skip archive + parse
        state[odds_type] = digest
        changed = True

        raw_dir = race_dir / f"type{odds_type}"
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f"{stamp}.json"
        raw_path.write_text(payload_text, encoding="utf-8")
        raw_paths.append(str(raw_path))

        if odds_type == "1":
            records = parse_odds_payload(
                payload_text, race_id=target.race_id,
                raw_uri=str(raw_path), captured_at=captured_at,
            )
            parsed_rows += len(records)
            new_rows += append_odds_snapshots(lake, records) if records else 0
        else:
            pool = POOL_TYPES.get(odds_type, odds_type)
            records = parse_combo_odds_payload(
                payload_text, race_id=target.race_id, pool=pool,
                raw_uri=str(raw_path), captured_at=captured_at,
            )
            parsed_rows += len(records)
            new_rows += append_combo_odds_snapshots(lake, records) if records else 0

    if changed:
        _save_poll_state(race_dir, state)

    return PollResult(
        captured_at=captured_at,
        raw_paths=tuple(raw_paths),
        parsed_rows=parsed_rows,
        new_rows=new_rows,
        changed=changed,
    )


def _load_poll_state(race_dir) -> dict[str, str]:
    """Per-race {odds_type: last_payload_sha256}, used for change-detection."""
    path = race_dir / "_poll_state.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def _save_poll_state(race_dir, state: dict[str, str]) -> None:
    race_dir.mkdir(parents=True, exist_ok=True)
    (race_dir / "_poll_state.json").write_text(
        json.dumps(state, indent=2), encoding="utf-8"
    )


def run_poller(
    lake: LakePaths,
    target: PollTarget,
    fetch: Callable[[str, str], str] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    on_poll: Callable[[PollResult], None] | None = None,
) -> int:
    """Poll until shortly after post time. Returns total polls performed.

    Failures of a single poll (network blip, malformed payload) are logged
    to stdout and skipped; the loop continues so one bad cycle never kills
    a race-day capture session.
    """
    lake.ensure()
    polls = 0
    idle = 0  # consecutive cycles with no change, drives back-off
    while True:
        now = now_fn()
        interval = next_poll_interval(now, target.post_time)
        if interval is None:
            return polls

        try:
            result = poll_once(lake, target, fetch=fetch, now=now)
            polls += 1
            idle = 0 if result.changed else idle + 1
            if on_poll is not None:
                on_poll(result)
            else:
                print(
                    f"[{result.captured_at.isoformat()}] {target.race_id}: "
                    f"{result.parsed_rows} parsed, {result.new_rows} new across "
                    f"{len(result.raw_paths)} pools{'' if result.changed else ' (no change)'}"
                )
        except Exception as exc:  # noqa: BLE001 - keep race-day capture alive
            print(f"[{now.isoformat()}] poll failed ({exc!r}); continuing")

        sleep(_effective_interval(interval, idle, now, target.post_time).total_seconds())


def _effective_interval(
    base: timedelta, idle: int, now: datetime, post_time: datetime
) -> timedelta:
    """Back off when the source is idle and we're not in the final pre-post window.

    Inside FINAL_WINDOW before post (and after post), always use the base cadence
    so late odds moves are never missed. Otherwise, after 2+ unchanged cycles,
    widen the interval geometrically (capped at MAX_BACKOFF) to avoid polling a
    static source. Any change resets the back-off (idle=0 -> base)."""
    remaining = post_time - now
    if remaining <= FINAL_WINDOW or idle < 2:
        return base
    factor = min(2 ** (idle - 1), 8)
    return min(base * factor, MAX_BACKOFF)
