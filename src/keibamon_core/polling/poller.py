from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from keibamon_core.ingestion.odds import append_odds_snapshots
from keibamon_core.paths import LakePaths
from keibamon_core.polling.netkeiba import fetch_odds_payload, parse_odds_payload

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


@dataclass(frozen=True)
class PollResult:
    captured_at: datetime
    raw_path: str
    parsed_rows: int
    new_rows: int


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
    fetch: Callable[[str], str] | None = None,
    now: datetime | None = None,
) -> PollResult:
    """One capture cycle: fetch -> archive raw to bronze -> append to silver.

    The raw payload is always archived, even if parsing yields no rows
    (pre-announcement), so nothing is ever lost to a parser bug.
    """
    fetch = fetch or fetch_odds_payload
    captured_at = now or datetime.now(timezone.utc)

    payload_text = fetch(target.netkeiba_race_id)

    raw_dir = lake.bronze_source_dir(BRONZE_ODDS_SOURCE) / target.netkeiba_race_id
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / f"{captured_at.strftime('%Y%m%dT%H%M%S%fZ')}.json"
    raw_path.write_text(payload_text, encoding="utf-8")

    records = parse_odds_payload(
        payload_text,
        race_id=target.race_id,
        raw_uri=str(raw_path),
        captured_at=captured_at,
    )
    new_rows = append_odds_snapshots(lake, records) if records else 0

    return PollResult(
        captured_at=captured_at,
        raw_path=str(raw_path),
        parsed_rows=len(records),
        new_rows=new_rows,
    )


def run_poller(
    lake: LakePaths,
    target: PollTarget,
    fetch: Callable[[str], str] | None = None,
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
    while True:
        now = now_fn()
        interval = next_poll_interval(now, target.post_time)
        if interval is None:
            return polls

        try:
            result = poll_once(lake, target, fetch=fetch, now=now)
            polls += 1
            if on_poll is not None:
                on_poll(result)
            else:
                print(
                    f"[{result.captured_at.isoformat()}] {target.race_id}: "
                    f"{result.parsed_rows} rows parsed, {result.new_rows} new -> {result.raw_path}"
                )
        except Exception as exc:  # noqa: BLE001 - keep race-day capture alive
            print(f"[{now.isoformat()}] poll failed ({exc!r}); continuing")

        sleep(interval.total_seconds())
