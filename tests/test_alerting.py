"""Loud capture alerting (keibamon_core.alerting) — the ADR-0004 mandatory
scrape-failure monitoring. Covers the ntfy transport fallback, the
consecutive-failure and staleness watchdogs (thresholds, cooldown re-fire,
recovery notice), and the wiring through weekend.pipeline.track."""
from __future__ import annotations

from pathlib import Path

import pytest

from keibamon_core.alerting import NTFY_TOPIC_ENV, CaptureAlerter, alert
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline


# --- alert() transport ---------------------------------------------------------


def test_alert_without_topic_is_loud_noop(monkeypatch, capsys):
    monkeypatch.delenv(NTFY_TOPIC_ENV, raising=False)
    assert alert("t", "m") is False
    err = capsys.readouterr().err
    assert "not pushed" in err and NTFY_TOPIC_ENV in err and "t: m" in err


def test_alert_posts_to_topic_url(monkeypatch):
    monkeypatch.setenv(NTFY_TOPIC_ENV, "keibamon-secret-topic")
    calls: list[tuple[str, str, str]] = []
    ok = alert("title", "body", post_fn=lambda url, t, m: calls.append((url, t, m)))
    assert ok is True
    assert calls == [("https://ntfy.sh/keibamon-secret-topic", "title", "body")]


def test_alert_swallow_post_failure(monkeypatch, capsys):
    monkeypatch.setenv(NTFY_TOPIC_ENV, "x")

    def boom(url, t, m):
        raise OSError("network down")

    assert alert("title", "body", post_fn=boom) is False  # never raises
    assert "push failed" in capsys.readouterr().err


# --- CaptureAlerter ------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _alerter(**kw):
    sent: list[str] = []
    clock = _Clock()
    a = CaptureAlerter(
        alert_fn=lambda title, msg: sent.append(title),
        now_fn=clock,
        **kw,
    )
    return a, sent, clock


def test_failing_alert_fires_at_threshold_not_before():
    a, sent, _ = _alerter(fail_cycles=3)
    assert a.record_cycle(ok=0, failed=5) == []
    assert a.record_cycle(ok=0, failed=5) == []
    assert a.record_cycle(ok=0, failed=5) == ["failing"]
    assert len(sent) == 1 and "FAILING" in sent[0]


def test_partial_success_resets_the_failure_counter():
    a, sent, _ = _alerter(fail_cycles=2)
    a.record_cycle(ok=0, failed=3)
    a.record_cycle(ok=1, failed=2)  # one race still fetching → capture alive
    a.record_cycle(ok=0, failed=3)
    assert sent == []  # never reached 2 consecutive total-failure cycles


def test_cooldown_suppresses_refire_then_allows_it():
    a, sent, clock = _alerter(fail_cycles=1, cooldown_s=600)
    assert a.record_cycle(ok=0, failed=1) == ["failing"]
    clock.t = 300
    assert a.record_cycle(ok=0, failed=1) == []  # inside cooldown
    clock.t = 900
    assert a.record_cycle(ok=0, failed=1) == ["failing"]  # re-fires after cooldown
    assert len(sent) == 2


def test_recovery_sends_one_notice_and_rearms():
    a, sent, clock = _alerter(fail_cycles=1, cooldown_s=0)
    a.record_cycle(ok=0, failed=1)
    assert a.record_cycle(ok=2, failed=0) == ["recovered"]
    assert a.record_cycle(ok=2, failed=0) == []  # notice is one-shot
    assert a.record_cycle(ok=0, failed=1) == ["failing"]  # re-armed
    assert [s.split()[-1] for s in sent] == ["FAILING", "recovered", "FAILING"]


def test_stale_alert_when_success_stops_arriving():
    a, sent, clock = _alerter(fail_cycles=99, stale_after_s=900)
    a.record_cycle(ok=3, failed=0)          # t=0: healthy
    clock.t = 600
    assert a.record_cycle(ok=0, failed=0) == []   # not stale yet
    clock.t = 1200
    assert a.record_cycle(ok=0, failed=0) == ["stale"]
    assert "STALE" in sent[-1]


def test_no_stale_alert_before_first_ever_success():
    # Cold start with everything failing is the FAILING alert's job, not stale's.
    a, sent, clock = _alerter(fail_cycles=99, stale_after_s=10)
    clock.t = 1000
    assert a.record_cycle(ok=0, failed=2) == []


# --- wiring through pipeline.track ----------------------------------------------


def _device_role_file(tmp_path: Path) -> Path:
    p = tmp_path / ".device"
    p.write_text("role = mac-dev\n", encoding="utf-8")
    return p


@pytest.fixture()
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path / "lake")


def test_track_feeds_alerter_per_cycle(lake: LakePaths, tmp_path: Path):
    """track() reports each cycle's ok/failed fetch counts to the alerter;
    a total-failure cycle reaches it as ok=0."""
    seen: list[tuple[int, int]] = []

    class FakeAlerter:
        def __bool__(self) -> bool:
            return True

        def record_cycle(self, *, ok: int, failed: int) -> list[str]:
            seen.append((ok, failed))
            return []

    def failing_fetch(nk_id: str) -> str:
        raise OSError("netkeiba down")

    result = pipeline.track(
        lake, ["jra-20260620-09-11", "jra-20260620-09-12"],
        role_file=_device_role_file(tmp_path),
        fetch_fn=failing_fetch,
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,
        max_cycles=2,
        sleep_fn=lambda s: None,
        alerter=FakeAlerter(),
    )
    assert seen == [(0, 2), (0, 2)]
    assert result["cycles"][0]["fetch_failures"] == 2


def test_track_alerter_error_never_kills_capture(lake: LakePaths, tmp_path: Path, capsys):
    class ExplodingAlerter:
        def __bool__(self) -> bool:
            return True

        def record_cycle(self, **kw):
            raise RuntimeError("alerter bug")

    result = pipeline.track(
        lake, ["jra-20260620-09-11"],
        role_file=_device_role_file(tmp_path),
        fetch_fn=lambda nk_id: (_ for _ in ()).throw(OSError("down")),
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,
        max_cycles=1,
        sleep_fn=lambda s: None,
        alerter=ExplodingAlerter(),
    )
    assert len(result["cycles"]) == 1  # loop survived
    assert "alerter error" in capsys.readouterr().err


def test_track_alerter_false_disables(lake: LakePaths, tmp_path: Path):
    result = pipeline.track(
        lake, ["jra-20260620-09-11"],
        role_file=_device_role_file(tmp_path),
        fetch_fn=lambda nk_id: (_ for _ in ()).throw(OSError("down")),
        push_fn=lambda snap, **kw: {"result": {"meta": {"changes": 1}}},
        inhibit_sleep=False,
        max_cycles=1,
        sleep_fn=lambda s: None,
        alerter=False,
    )
    assert result["cycles"][0]["fetch_failures"] == 1
