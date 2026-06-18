"""Tests for weekend stage 3: ``pipeline.track`` + ``track_once`` (ADR-0004).

The seam-injection style mirrors :mod:`tests.test_model_card` and
:mod:`tests.test_settle_card`: a ``lake`` fixture on ``tmp_path``, a
``.device`` role file pointed at ``mac-dev``, and ``fetch_fn`` / ``push_fn``
injection seams so the loop runs offline without a real clock or network.

Coverage:

  - **Lake-first**: ``track_once`` banks to ``odds_snapshots`` BEFORE any push;
    a ``push_fn`` that raises does not lose the lake write (ADR-0003 D4).
  - **Unchanged-timestamp backoff**: re-running with the same
    ``official_datetime`` banks zero new rows (the dedupe holds, so polling
    faster than netkeiba updates is harmless).
  - **Cadence tightens toward post**: ``_minutes_to_nearest_post`` parses
    ``post_time_jst`` and returns the delta in minutes; ``track`` passes the
    tightened cadence to ``sleep_fn``.
  - **Device guard**: ``mac-dev`` only after ADR-0004 -- both ``capture-pc``
    and any unknown role raise ``WrongDeviceError``.
  - **Missing CF_***: preflight warns loudly but the loop still banks the
    curve; the per-cycle push returns ``status=skipped`` with the reason.
  - **Stage 4 round-trip**: a ``curve_log`` built from the captured
    ``odds_snapshots`` has the expected open/decision/close per runner --
    proves stage 3's output feeds stage 4's freeze.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from keibamon_core.ingestion.curve_log import build_curve_records
from keibamon_core.ingestion.odds import ODDS_TABLE, append_odds_snapshots
from keibamon_core.lake import read_parquet_if_exists
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline


# --- fixtures ----------------------------------------------------------------


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path)


def _device_role_file(tmp_path: Path, role: str = "mac-dev") -> Path:
    role_file = tmp_path / ".device"
    role_file.write_text(f"role = {role}\n")
    return role_file


def _make_payload(
    official_datetime: str,
    win_odds: dict[int, float],
    place_low: dict[int, float] | None = None,
    place_high: dict[int, float] | None = None,
) -> str:
    """Build a netkeiba-style win/place odds payload.

    Format mirrors ``tests/fixtures/netkeiba/odds_202605030211.json``:
    ``data.odds["1"][<umaban>] = [win_odds, "", popularity]`` and
    ``data.odds["2"][<umaban>] = [place_low, place_high, popularity]``.
    """
    place_low = place_low or {}
    place_high = place_high or {}
    win_block: dict[str, list[str]] = {}
    place_block: dict[str, list[str]] = {}
    # popularity = ordinal of win odds (1 = favorite)
    ordered = sorted(win_odds, key=lambda h: win_odds[h])
    pop = {hn: i + 1 for i, hn in enumerate(ordered)}
    for hn, o in win_odds.items():
        win_block[f"{hn:02d}"] = [str(o), "", str(pop[hn])]
    for hn in place_low:
        place_block[f"{hn:02d}"] = [
            str(place_low.get(hn, "")),
            str(place_high.get(hn, "")),
            str(pop.get(hn, "")),
        ]
    return json.dumps({
        "status": "middle",
        "data": {
            "official_datetime": official_datetime,
            "odds": {"1": win_block, "2": place_block},
        },
    })


def _race_specs(
    race_ids: list[str],
    *,
    post_times_jst: list[str] | None = None,
) -> list[dict[str, Any]]:
    return pipeline._resolve_race_specs(
        race_ids, post_times_jst=post_times_jst,
    )


# --- lake first --------------------------------------------------------------


def test_track_once_banks_to_lake_before_push(lake: LakePaths):
    """ADR-0003 D4: lake write lands before any network call. push_fn must
    observe snapshots already on disk."""
    race_id = "jra-20260620-09-11"
    specs = _race_specs([race_id])
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0, 2: 10.0})

    push_calls: list[dict] = []

    def _push_fn(snapshot, *, key="netkeiba_track", **kw):
        on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
        push_calls.append({
            "key": key,
            "rows_on_disk_before_push": len(on_disk),
            "snapshot": snapshot,
        })
        return {"result": {"meta": {"changes": 1}}}

    cycle = pipeline.track_once(
        lake, specs,
        fetch_fn=lambda nk_id: payload,
        push_fn=_push_fn,
    )

    assert cycle["snapshots_banked"] == 2  # 2 horses, 1 new snapshot each
    assert len(push_calls) == 1
    # The lake write landed BEFORE the push ran.
    assert push_calls[0]["rows_on_disk_before_push"] == 2
    assert cycle["d1"]["status"] == "ok"


def test_track_once_push_failure_does_not_lose_lake_write(lake: LakePaths):
    """If push_fn raises, the lake write that already landed must survive."""
    race_id = "jra-20260620-09-11"
    specs = _race_specs([race_id])
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0})

    def _raising_push(snapshot, **kw):
        raise RuntimeError("D1 exploded")

    cycle = pipeline.track_once(
        lake, specs,
        fetch_fn=lambda nk_id: payload,
        push_fn=_raising_push,
    )
    assert cycle["snapshots_banked"] == 1
    assert cycle["d1"]["status"] == "failed"
    assert "D1 exploded" in cycle["d1"]["error"]

    # The lake write survived the D1 failure.
    on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    assert len(on_disk) == 1


# --- unchanged-timestamp backoff --------------------------------------------


def test_track_once_dedupes_unchanged_source_timestamp(lake: LakePaths):
    """Re-running with the same official_datetime banks zero new rows.
    The dedupe key is (race_id, horse_number, available_at) -- polling faster
    than netkeiba updates is harmless."""
    race_id = "jra-20260620-09-11"
    specs = _race_specs([race_id])
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0, 2: 10.0})

    cycle1 = pipeline.track_once(
        lake, specs, fetch_fn=lambda nk_id: payload,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
    )
    assert cycle1["snapshots_banked"] == 2

    # Same payload, same official_datetime -> append returns 0.
    cycle2 = pipeline.track_once(
        lake, specs, fetch_fn=lambda nk_id: payload,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
    )
    assert cycle2["snapshots_banked"] == 0

    on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    assert len(on_disk) == 2  # still exactly the first cycle's rows


def test_track_once_banks_again_when_source_timestamp_advances(lake: LakePaths):
    """A new official_datetime -> new dedupe key -> new rows. This is the
    happy path: netkeiba updated, we captured the new snapshot."""
    race_id = "jra-20260620-09-11"
    specs = _race_specs([race_id])
    payload_v1 = _make_payload("2026-06-20 09:00:00", {1: 5.0})
    payload_v2 = _make_payload("2026-06-20 09:05:00", {1: 4.5})

    pipeline.track_once(
        lake, specs, fetch_fn=lambda nk_id: payload_v1,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
    )
    cycle2 = pipeline.track_once(
        lake, specs, fetch_fn=lambda nk_id: payload_v2,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
    )
    assert cycle2["snapshots_banked"] == 1

    on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    assert len(on_disk) == 2  # both timestamps present


# --- cadence tightens toward post -------------------------------------------


def test_minutes_to_nearest_post_returns_future_delta():
    """A spec whose post_time is ~5 minutes from now (in JST) returns ~5."""
    # Compute a post time ~5 minutes from now in JST.
    from datetime import timedelta
    jst = timezone(timedelta(hours=9))
    now_jst = datetime.now(jst)
    soon = now_jst + timedelta(minutes=5)
    post_time = soon.strftime("%H:%M")
    specs = [{"race_id": "jra-20260620-09-11", "post_time_jst": post_time}]
    delta = pipeline._minutes_to_nearest_post(specs)
    assert delta is not None
    # Allow slack for test runtime.
    assert 3.0 <= delta <= 5.5


def test_track_tightens_cadence_near_post(lake: LakePaths, tmp_path: Path):
    """End-to-end through pipeline.track: when a race's post_time is within
    tighten_within_minutes, sleep_fn receives tighten_poll_seconds between
    cycles (not poll_seconds). Verifies the adaptive-cadence path flows all
    the way through track() to sleep_fn."""
    from datetime import timedelta
    jst = timezone(timedelta(hours=9))
    soon = datetime.now(jst) + timedelta(minutes=3)
    post_time_jst = soon.strftime("%H:%M")

    race_id = "jra-20260620-09-11"
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0})

    sleeps: list[int] = []
    pipeline.track(
        lake, [race_id],
        role_file=_device_role_file(tmp_path),
        post_times_jst=[post_time_jst],
        fetch_fn=lambda nk_id: payload,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,  # don't spawn caffeinate in tests
        poll_seconds=120,
        tighten_poll_seconds=30,
        tighten_within_minutes=10.0,
        max_cycles=2,  # need >= 2 cycles to observe one inter-cycle sleep
        sleep_fn=lambda s: sleeps.append(s),
    )
    assert sleeps == [30]  # tightened cadence, not nominal 120


def test_sleep_between_cycles_uses_tighten_when_near_post():
    """Direct unit: tighten_poll_seconds is selected when nearest post <= threshold."""
    from datetime import timedelta
    jst = timezone(timedelta(hours=9))
    soon = datetime.now(jst) + timedelta(minutes=4)
    specs = [{
        "race_id": "jra-20260620-09-11",
        "post_time_jst": soon.strftime("%H:%M"),
    }]
    slept: list[int] = []
    pipeline._sleep_between_cycles(
        specs, lambda s: slept.append(s),
        poll_seconds=120, tighten_poll_seconds=30,
        tighten_within_minutes=10.0,
    )
    assert slept == [30]


def test_sleep_between_cycles_uses_nominal_when_far_from_post():
    """Direct unit: poll_seconds is selected when no post time is near."""
    specs = [{"race_id": "jra-20260620-09-11", "post_time_jst": None}]
    slept: list[int] = []
    pipeline._sleep_between_cycles(
        specs, lambda s: slept.append(s),
        poll_seconds=120, tighten_poll_seconds=30,
        tighten_within_minutes=10.0,
    )
    assert slept == [120]


# --- device guard -----------------------------------------------------------


def test_track_refuses_on_capture_pc(lake: LakePaths, tmp_path: Path):
    """ADR-0004: capture-pc is no longer an allowed device for track. The
    guard must reject it just like any other non-mac-dev role."""
    role_file = tmp_path / ".device"
    role_file.write_text("role = capture-pc\n")
    with pytest.raises(pipeline.WrongDeviceError, match="must run on"):
        pipeline.track(
            lake, ["jra-20260620-09-11"],
            role_file=role_file,
            inhibit_sleep=False,
            fetch_fn=lambda nk_id: "",
        )


def test_track_refuses_on_unknown_device(lake: LakePaths, tmp_path: Path):
    role_file = tmp_path / ".device"
    role_file.write_text("role = cowork-sandbox\n")
    with pytest.raises(pipeline.WrongDeviceError, match="must run on"):
        pipeline.track(
            lake, ["jra-20260620-09-11"],
            role_file=role_file,
            inhibit_sleep=False,
            fetch_fn=lambda nk_id: "",
        )


def test_track_refuses_without_device_file(lake: LakePaths, tmp_path: Path):
    """No .device file at all -> refuse; the operator must not guess."""
    missing = tmp_path / ".device"  # never written
    with pytest.raises(pipeline.WrongDeviceError, match="needs a .device file"):
        pipeline.track(
            lake, ["jra-20260620-09-11"],
            role_file=missing,
            inhibit_sleep=False,
            fetch_fn=lambda nk_id: "",
        )


# --- missing CF_* creds -----------------------------------------------------


def test_track_missing_creds_skips_push_but_banks_curve(
    lake: LakePaths, tmp_path: Path, monkeypatch
):
    """CLAUDE.md: CF_* don't persist across Mac shells. Missing creds must
    not raise and must not lose the lake write -- the curve still banks."""
    race_id = "jra-20260620-09-11"
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0, 2: 10.0})
    for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)

    result = pipeline.track(
        lake, [race_id],
        role_file=_device_role_file(tmp_path),
        fetch_fn=lambda nk_id: payload,
        # NOTE: no push_fn -> exercises the CF_* preflight path.
        inhibit_sleep=False,
        max_cycles=1,
    )
    assert len(result["cycles"]) == 1
    cycle = result["cycles"][0]
    assert cycle["snapshots_banked"] == 2
    assert cycle["d1"]["status"] == "skipped"
    assert "CF_ACCOUNT_ID" in cycle["d1"]["reason"]
    # Preflight warning surfaced at startup.
    assert result["preflight"]["cf_creds"] is not None

    # Curve banked despite missing creds.
    on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    assert len(on_disk) == 2


def test_track_missing_creds_does_not_print_warning_when_push_fn_injected(
    lake: LakePaths, tmp_path: Path, monkeypatch, capsys
):
    """A caller-supplied push_fn bypasses the CF_* preflight (tests own the
    fake pusher). No preflight warning should be emitted in that case."""
    race_id = "jra-20260620-09-11"
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0})
    for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)

    pipeline.track(
        lake, [race_id],
        role_file=_device_role_file(tmp_path),
        fetch_fn=lambda nk_id: payload,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,
        max_cycles=1,
    )
    err = capsys.readouterr().err
    assert "CF_*" not in err and "CF_ACCOUNT_ID" not in err


# --- restartable: resume from a prior cycle ---------------------------------


def test_track_resumable_across_cycles_within_process(lake: LakePaths):
    """A second track_once call on the same lake does not duplicate rows for
    the same official_datetime. The opening-odds cache carries over via
    open_state (first sighting wins)."""
    race_id = "jra-20260620-09-11"
    specs = _race_specs([race_id])
    open_state: dict[tuple[str, int], float] = {}

    # Cycle 1: opening price hn=1 @ 5.0
    pipeline.track_once(
        lake, specs, fetch_fn=lambda nk_id: _make_payload("2026-06-20 09:00:00", {1: 5.0, 2: 10.0}),
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        open_state=open_state,
    )
    # Cycle 2: same timestamp but prices changed (impossible in practice, but
    # exercises the dedupe). The opening cache is carried -- hn=1 stays 5.0.
    pipeline.track_once(
        lake, specs, fetch_fn=lambda nk_id: _make_payload("2026-06-20 09:00:00", {1: 4.0, 2: 8.0}),
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        open_state=open_state,
    )
    # open_state preserved across cycles: first sighting wins.
    assert open_state[(race_id, 1)] == 5.0
    assert open_state[(race_id, 2)] == 10.0

    # The lake still holds exactly the first cycle's rows (dedupe held).
    on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    assert len(on_disk) == 2


# --- stage 4 round-trip: build_curve_records from captured odds_snapshots ----


def test_captured_curve_log_round_trips_through_build_curve_records(lake: LakePaths):
    """Stage 3's output feeds stage 4's FREEZE: a curve_log built from the
    captured odds_snapshots has the expected open/decision/close per runner.

    Captures 3 cycles for one race with monotonically advancing
    official_datetimes; odds drift so open != decision != close."""
    race_id = "jra-20260620-09-11"
    specs = _race_specs([race_id])

    # Three snapshots: hn=1 firms (5.0 -> 4.5 -> 4.2), hn=2 drains (10 -> 12 -> 15).
    payloads = [
        _make_payload("2026-06-20 09:00:00", {1: 5.0, 2: 10.0}),
        _make_payload("2026-06-20 09:10:00", {1: 4.5, 2: 12.0}),
        _make_payload("2026-06-20 09:20:00", {1: 4.2, 2: 15.0}),
    ]
    for payload in payloads:
        pipeline.track_once(
            lake, specs, fetch_fn=lambda nk_id, p=payload: p,
            push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        )

    # Read what stage 3 banked, project to build_curve_records' input shape.
    on_disk = read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
    assert len(on_disk) == 6  # 2 horses x 3 cycles

    # No post_time -> decision time = last_capture - lead_min (5 min default).
    # last capture = 09:20 JST = 00:20 UTC; decision = 00:15 UTC.
    records = build_curve_records(on_disk)
    by_hn = {int(r["horse_number"]): r for r in records}
    assert set(by_hn) == {1, 2}

    # Open = first sighting; close = last sighting.
    assert by_hn[1]["open_odds"] == pytest.approx(5.0)
    assert by_hn[1]["close_odds"] == pytest.approx(4.2)
    assert by_hn[2]["open_odds"] == pytest.approx(10.0)
    assert by_hn[2]["close_odds"] == pytest.approx(15.0)

    # Decision = latest snapshot at or before (last - 5min) = 09:15 JST ->
    # the 09:10 snapshot wins (09:20 > 09:15).
    assert by_hn[1]["decision_odds"] == pytest.approx(4.5)
    assert by_hn[2]["decision_odds"] == pytest.approx(12.0)

    # Result fields are NULL at FREEZE (stage 4 SETTLE fills them later).
    assert by_hn[1]["settled"] is False
    assert by_hn[1]["won"] is None
    assert by_hn[1]["finish_position"] is None


# --- race-specs resolution --------------------------------------------------


def test_resolve_race_specs_defaults_nk_id_to_race_id():
    """When nk_race_ids is None, nk_race_id defaults to race_id itself
    (tests don't care; production must supply the real netkeiba id)."""
    specs = pipeline._resolve_race_specs(["jra-20260620-09-11", "jra-20260620-09-12"])
    assert specs[0]["nk_race_id"] == "jra-20260620-09-11"
    assert specs[0]["race_no"] == 11
    assert specs[0]["name"] == "Race 11"
    assert specs[1]["race_no"] == 12


def test_resolve_race_specs_parallel_lists_must_match_length():
    with pytest.raises(ValueError, match="parallel race_ids"):
        pipeline._resolve_race_specs(
            ["jra-20260620-09-11"],
            nk_race_ids=["a", "b"],
        )


def test_pipeline_track_smoke_one_cycle(lake: LakePaths, tmp_path: Path):
    """End-to-end through pipeline.track with max_cycles=1: the device guard
    runs, preflight runs (no caffeinate, no CF_* needed since push_fn is
    injected), one cycle lands, and the result shape is the documented one."""
    race_id = "jra-20260620-09-11"
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0, 2: 10.0})

    result = pipeline.track(
        lake, [race_id],
        role_file=_device_role_file(tmp_path),
        fetch_fn=lambda nk_id: payload,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,
        max_cycles=1,
        sleep_fn=lambda s: None,
    )
    assert result["stage"] == "track"
    assert result["device"] == "mac-dev"
    assert len(result["cycles"]) == 1
    assert result["cycles"][0]["snapshots_banked"] == 2
    assert result["cycles"][0]["d1"]["status"] == "ok"
    assert result["preflight"]["cf_creds"] is None  # push_fn bypassed preflight
    assert result["preflight"]["sleep"] is None      # inhibit_sleep=False


def test_pipeline_track_loops_two_cycles_with_sleep(lake: LakePaths, tmp_path: Path):
    """max_cycles=2 produces two cycles and one inter-cycle sleep."""
    race_id = "jra-20260620-09-11"
    payload = _make_payload("2026-06-20 09:00:00", {1: 5.0})

    sleeps: list[int] = []
    result = pipeline.track(
        lake, [race_id],
        role_file=_device_role_file(tmp_path),
        fetch_fn=lambda nk_id: payload,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,
        max_cycles=2,
        poll_seconds=60,
        sleep_fn=lambda s: sleeps.append(s),
    )
    assert len(result["cycles"]) == 2
    # Second cycle dedupes (same official_datetime) -> 0 new rows.
    assert result["cycles"][1]["snapshots_banked"] == 0
    # One sleep between cycle 1 and cycle 2.
    assert sleeps == [60]
