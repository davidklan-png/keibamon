from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow", reason="pyarrow is required for polling tests")

from keibamon_core.ingestion.odds import COMBO_ODDS_TABLE, ODDS_TABLE
from keibamon_core.lake import read_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.polling import (
    PollTarget,
    next_poll_interval,
    parse_odds_payload,
    poll_once,
    run_poller,
)
from keibamon_core.polling.netkeiba import JST, POOL_TYPES, parse_combo_odds_payload
from keibamon_core.polling.poller import MAX_BACKOFF, _effective_interval

# An empty (pre-announcement) payload, returned for pool types other than
# win/place in tests so win/place assertions stay stable while the multi-pool
# loop and per-pool archiving are still exercised.
EMPTY_PAYLOAD = '{"status":"yet","data":{}}'


def _winplace_only(_race_id: str, odds_type: str = "1") -> str:
    """Fetch stub: real win/place payload for type 1, empty for exotics."""
    return PAYLOAD_TEXT if odds_type == "1" else EMPTY_PAYLOAD

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

    first = poll_once(lake, target, fetch=_winplace_only,
                      now=datetime(2026, 6, 7, 6, 11, tzinfo=timezone.utc))
    assert first.changed is True
    assert first.parsed_rows == 17   # only win/place yields rows here
    assert first.new_rows == 17
    # first sight of every pool type archives its own raw payload (even empty exotics)
    assert len(first.raw_paths) == len(POOL_TYPES)
    assert all(Path(p).is_file() for p in first.raw_paths)

    # Identical payloads again: change-detection skips archive AND parse entirely.
    second = poll_once(lake, target, fetch=_winplace_only,
                       now=datetime(2026, 6, 7, 6, 12, tzinfo=timezone.utc))
    assert second.changed is False
    assert second.raw_paths == ()     # nothing re-archived
    assert second.new_rows == 0

    rows = read_parquet(lake.silver_table(ODDS_TABLE))
    assert len(rows) == 17            # silver still holds exactly one snapshot


def test_poll_once_detects_changed_winplace(tmp_path: Path) -> None:
    """A win/place payload with a new official_datetime is treated as changed:
    re-archived and appended as a new time-series snapshot."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    target = PollTarget(race_id=RACE_ID, netkeiba_race_id="202605030211", post_time=POST_TIME)

    poll_once(lake, target, fetch=_winplace_only,
              now=datetime(2026, 6, 7, 6, 11, tzinfo=timezone.utc))
    moved = PAYLOAD_TEXT.replace("15:10:41", "15:12:41").replace("\"2.9\"", "\"3.1\"")

    def fetch2(_rid: str, odds_type: str = "1") -> str:
        return moved if odds_type == "1" else EMPTY_PAYLOAD

    res = poll_once(lake, target, fetch=fetch2,
                    now=datetime(2026, 6, 7, 6, 13, tzinfo=timezone.utc))
    assert res.changed is True
    assert len(res.raw_paths) == 1            # only win/place changed; exotics stable
    rows = read_parquet(lake.silver_table(ODDS_TABLE))
    assert len(rows) == 34                    # two snapshots now (17 + 17)


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
        fetch=_winplace_only,
        sleep=sleeps.append,
        now_fn=lambda: next(clock),
        on_poll=results.append,
    )

    assert polls == 1
    assert sleeps == [60.0]  # final-window cadence
    assert results[0].parsed_rows == 17


def test_effective_interval_backs_off_when_idle_far_from_post() -> None:
    base = timedelta(minutes=10)
    far = POST_TIME - timedelta(hours=2)
    # no/low idle -> base cadence unchanged
    assert _effective_interval(base, 0, far, POST_TIME) == base
    assert _effective_interval(base, 1, far, POST_TIME) == base
    # idle >= 2 widens geometrically...
    assert _effective_interval(base, 2, far, POST_TIME) == timedelta(minutes=20)
    # ...capped at MAX_BACKOFF
    assert _effective_interval(base, 5, far, POST_TIME) == MAX_BACKOFF
    # but inside the final window before post, never back off
    near = POST_TIME - timedelta(minutes=5)
    assert _effective_interval(timedelta(minutes=1), 9, near, POST_TIME) == timedelta(minutes=1)


def test_parse_combo_odds_extracts_combo_odds_popularity() -> None:
    """Generic exotic parser on a combo-keyed block ({combo: [odds, popularity]}),
    the shape exotic pools share with the confirmed win/place layout."""
    payload = (
        '{"status":"middle","data":{"official_datetime":"2026-06-07 15:10:41",'
        '"odds":{"9":{"01-02":["12.3","5"],"01-03":["240.1","41"],"02-03":["8.4","3"]}}}}'
    )
    captured = datetime(2026, 6, 7, 6, 12, tzinfo=timezone.utc)
    rows = parse_combo_odds_payload(payload, RACE_ID, "quinella", "raw://x", captured)

    assert len(rows) == 3
    fav = next(r for r in rows if r["combo"] == "02-03")
    assert fav["pool"] == "quinella" and fav["odds"] == 8.4 and fav["popularity"] == 3
    assert fav["available_at"] == datetime(2026, 6, 7, 15, 10, 41, tzinfo=JST)
    assert parse_combo_odds_payload(EMPTY_PAYLOAD, RACE_ID, "wide", "raw://x", captured) == []


def test_poll_once_appends_exotic_combo_odds(tmp_path: Path) -> None:
    """When exotic payloads carry odds, they land in the combo_odds silver table
    keyed by (race_id, pool, combo, available_at)."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    target = PollTarget(race_id=RACE_ID, netkeiba_race_id="202605030211", post_time=POST_TIME)
    quinella = (
        '{"status":"middle","data":{"official_datetime":"2026-06-07 15:10:41",'
        '"odds":{"9":{"01-02":["12.3","5"],"02-03":["8.4","3"]}}}}'
    )

    def fetch(_race_id: str, odds_type: str = "1") -> str:
        if odds_type == "1":
            return PAYLOAD_TEXT
        return quinella if POOL_TYPES.get(odds_type) == "quinella" else EMPTY_PAYLOAD

    res = poll_once(lake, target, fetch=fetch,
                    now=datetime(2026, 6, 7, 6, 11, tzinfo=timezone.utc))
    assert res.parsed_rows == 17 + 2  # win/place + 2 quinella combos
    combo = read_parquet(lake.silver_table(COMBO_ODDS_TABLE))
    assert {r["pool"] for r in combo} == {"quinella"}
    assert {r["combo"] for r in combo} == {"01-02", "02-03"}


def test_run_poller_survives_fetch_failures(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    target = PollTarget(race_id=RACE_ID, netkeiba_race_id="202605030211", post_time=POST_TIME)

    def flaky_fetch(_race_id: str, _odds_type: str = "1") -> str:
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
