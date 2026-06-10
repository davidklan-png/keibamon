from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow", reason="pyarrow is required for polling tests")

from keibamon_core.ingestion.odds import ODDS_TABLE
from keibamon_core.lake import read_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.polling import (
    PollTarget,
    next_poll_interval,
    parse_odds_payload,
    poll_once,
    run_poller,
)
from keibamon_core.polling.netkeiba import JST

PAYLOAD_PATH = Path(__file__).parent / "fixtures" / "netkeiba" / "odds_202605030211.json"
PAYLOAD_TEXT = PAYLOAD_PATH.read_text(encoding="utf-8")

RACE_ID = "r-2026-0607-tokyo-11"
POST_TIME = datetime(2026, 6, 14, 15, 40, tzinfo=JST)


def test_parse_odds_payload_extracts_win_and_place() -> None:
    captured_at = datetime(2026, 6, 7, 6, 12, tzinfo=timezone.utc)
    records = parse_odds_payload(PAYLOAD_TEXT, RACE_ID, "raw://test", captured_at)

    assert len(records) == 17
    favorite = next(r for r in records if r["horse_number"] == 14)
    assert favorite["win_odds"] == 2.9
    assert favorite["popularity"] == 1
    assert favorite["place_odds_low"] == 1.3
    assert favorite["place_odds_high"] == 1.6
    assert favorite["status"] == "middle"
    assert favorite["source_name"] == "netkeiba"

    # available_at is the official JRA odds timestamp (15:10:41 JST).
    expected = datetime(2026, 6, 7, 15, 10, 41, tzinfo=JST)
    assert favorite["available_at"] == expected
    assert favorite["captured_at"] == captured_at


def test_parse_odds_payload_without_odds_returns_empty() -> None:
    captured_at = datetime(2026, 6, 14, 0, 0, tzinfo=timezone.utc)
    records = parse_odds_payload('{"status":"yet","data":{}}', RACE_ID, "raw://test", captured_at)
    assert records == []


def test_poll_schedule_tightens_toward_post_time() -> None:
    cases = [
        (timedelta(hours=5), timedelta(minutes=15)),
        (timedelta(hours=2), timedelta(minutes=10)),
        (timedelta(minutes=45), timedelta(minutes=5)),
        (timedelta(minutes=15), timedelta(minutes=2)),
        (timedelta(minutes=5), timedelta(minutes=1)),
        (timedelta(minutes=-5), timedelta(minutes=1)),  # just past post: capture final odds
    ]
    for before_post, expected in cases:
        assert next_poll_interval(POST_TIME - before_post, POST_TIME) == expected

    # Long past post: stop.
    assert next_poll_interval(POST_TIME + timedelta(minutes=11), POST_TIME) is None


def test_poll_once_archives_bronze_and_appends_silver(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    target = PollTarget(race_id=RACE_ID, netkeiba_race_id="202605030211", post_time=POST_TIME)

    first = poll_once(lake, target, fetch=lambda _: PAYLOAD_TEXT,
                      now=datetime(2026, 6, 7, 6, 11, tzinfo=timezone.utc))
    assert first.parsed_rows == 17
    assert first.new_rows == 17
    assert Path(first.raw_path).is_file()  # raw payload always archived

    # Same payload again (same official_datetime): archived, but deduped in silver.
    second = poll_once(lake, target, fetch=lambda _: PAYLOAD_TEXT,
                       now=datetime(2026, 6, 7, 6, 12, tzinfo=timezone.utc))
    assert second.new_rows == 0
    assert Path(second.raw_path).is_file()
    assert Path(second.raw_path) != Path(first.raw_path)

    rows = read_parquet(lake.silver_table(ODDS_TABLE))
    assert len(rows) == 17


def test_run_poller_stops_after_post(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    target = PollTarget(race_id=RACE_ID, netkeiba_race_id="202605030211", post_time=POST_TIME)

    clock = iter(
        [
            POST_TIME - timedelta(minutes=3),  # one capture in the final window
            POST_TIME + timedelta(minutes=20),  # then well past post: stop
        ]
    )
    sleeps: list[float] = []
    results = []

    polls = run_poller(
        lake,
        target,
        fetch=lambda _: PAYLOAD_TEXT,
        sleep=sleeps.append,
        now_fn=lambda: next(clock),
        on_poll=results.append,
    )

    assert polls == 1
    assert sleeps == [60.0]  # final-window cadence
    assert results[0].parsed_rows == 17


def test_run_poller_survives_fetch_failures(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    target = PollTarget(race_id=RACE_ID, netkeiba_race_id="202605030211", post_time=POST_TIME)

    def flaky_fetch(_: str) -> str:
        raise OSError("network blip")

    clock = iter([POST_TIME - timedelta(minutes=2), POST_TIME + timedelta(minutes=20)])
    polls = run_poller(
        lake,
        target,
        fetch=flaky_fetch,
        sleep=lambda _: None,
        now_fn=lambda: next(clock),
    )

    assert polls == 0  # failed poll skipped, loop exited cleanly at stop time
