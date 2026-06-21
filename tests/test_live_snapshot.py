"""Tests for the ADR-0006 registration-exposure feed.

Pins the contract the app renders against:
  - a race with entries but no live odds is ``registered`` (grayed), and its
    estimated odds survive into ``win_odds_est``;
  - the moment a live price exists the race flips to ``open`` and the estimate
    is dropped (the app must distinguish a real price from a guess);
  - the estimated-odds parser captures a rendered number but returns ``None``
    for netkeiba's ``---.-`` placeholder (the real captured shutuba page) -- we
    never fabricate an estimate.
"""
from __future__ import annotations

from pathlib import Path

from keibamon_core.adapters.netkeiba_entries import parse_entries_payload
from keibamon_core.live.snapshot import (
    build_live_snapshot,
    build_race,
    build_runner,
    merge_entries_and_odds,
)

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"


def _load_expose_live():
    """tools/ is not a package -- load expose_live by path (same pattern as
    test_publish_d1)."""
    import importlib.util
    import sys

    root = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(root / "tools" / "jravan"))  # for publish_d1
    spec = importlib.util.spec_from_file_location(
        "expose_live", root / "tools" / "jravan" / "expose_live.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_runner_registered_keeps_estimate_only():
    r = build_runner({"umaban": 3, "name": "X", "est_odds": 4.2})
    assert r["win_odds"] is None
    assert r["win_odds_est"] == 4.2
    assert r["odds_is_live"] is False


def test_runner_live_drops_estimate():
    r = build_runner({"umaban": 3, "name": "X", "win_odds": 3.1, "est_odds": 4.2})
    assert r["win_odds"] == 3.1
    assert r["win_odds_est"] is None  # never show a guess next to a real price
    assert r["odds_is_live"] is True


def test_runner_rejects_impossible_odds():
    assert build_runner({"umaban": 1, "win_odds": 0.4})["win_odds"] is None
    assert build_runner({"umaban": 1, "est_odds": "x"})["win_odds_est"] is None


def test_race_status_registered_then_open_then_result():
    reg = build_race({"race_no": 1, "runners": [{"umaban": 1, "est_odds": 5.0}]})
    assert reg["status"] == "registered"

    opened = build_race(
        {"race_no": 1, "runners": [{"umaban": 1, "win_odds": 5.0}]}
    )
    assert opened["status"] == "open"

    done = build_race(
        {"race_no": 1, "result": {"win": 1}, "runners": [{"umaban": 1, "win_odds": 5.0}]}
    )
    assert done["status"] == "result"


def test_snapshot_counts_and_sort():
    snap = build_live_snapshot(
        [
            {
                "date": "20260621",
                "race_no": 2,
                "venue": "Tokyo",
                "grade_label": "G3",
                "runners": [{"umaban": 1, "win_odds": 3.0}],
            },
            {
                "date": "20260621",
                "race_no": 1,
                "venue": "Tokyo",
                "runners": [{"umaban": 1, "est_odds": 9.0}],
            },
        ],
        date="20260621",
    )
    assert snap["meta"]["counts"] == {"total": 2, "registered": 1, "open": 1}
    assert snap["meta"]["status"] == "live"  # at least one open
    # sorted by (venue, race_no): R1 (registered) before R2 (open)
    assert [r["race_no"] for r in snap["races"]] == [1, 2]
    assert snap["races"][1]["date"] == "20260621"
    assert snap["races"][1]["grade_label"] == "G3"


def test_empty_day_is_standby():
    snap = build_live_snapshot([], date="20260621")
    assert snap["meta"]["status"] == "standby"
    assert snap["races"] == []


def test_merge_entries_and_odds_by_umaban():
    entries = [
        {"horse_number": 1, "horse_name": "A", "est_odds": 4.0},
        {"horse_number": 2, "horse_name": "B", "est_odds": None},
    ]
    merged = merge_entries_and_odds(entries, {1: 2.8})
    assert merged[0] == {"umaban": 1, "name": "A", "win_odds": 2.8, "est_odds": 4.0}
    assert merged[1]["win_odds"] is None  # no live price for #2 yet


def test_est_odds_parser_returns_none_for_placeholder():
    """The real captured shutuba page shows '---.-' placeholders pre-open."""
    html = (FIXTURES / "shutuba_202605030611.html").read_text(encoding="utf-8")
    runners = parse_entries_payload(html, "202605030611")
    assert len(runners) >= 8  # real card parsed
    assert all(r["est_odds"] is None for r in runners)  # all placeholders


def test_publish_window_guard():
    """ADR-0006 scheduling: launchd fires coarsely; the guard decides if there's
    anything to do, so off-window fires are no-ops."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    jst = ZoneInfo("Asia/Tokyo")
    win = _load_expose_live().in_window

    def at(y, mo, d, h):
        return datetime(y, mo, d, h, 0, tzinfo=jst)

    # register: Fri 10:00-21:59 and Thu 14:00-17:59
    assert win(at(2026, 6, 19, 11), "register") is True   # Fri
    assert win(at(2026, 6, 19, 9), "register") is False   # Fri too early
    assert win(at(2026, 6, 18, 15), "register") is True   # Thu
    assert win(at(2026, 6, 18, 12), "register") is False  # Thu too early
    # race: Sat/Sun 09:00-16:59
    assert win(at(2026, 6, 20, 10), "race") is True        # Sat
    assert win(at(2026, 6, 20, 17), "race") is False       # Sat post-window
    assert win(at(2026, 6, 19, 12), "race") is False       # Fri not a race day
    # any: never gated
    assert win(at(2026, 6, 17, 3), "any") is True


def test_expose_live_default_dates_include_weekend_cards():
    """Scheduled register/Saturday race runs publish Sat+Sun, so tomorrow's
    graded races keep their own date and can be surfaced in the app."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    jst = ZoneInfo("Asia/Tokyo")
    mod = _load_expose_live()

    assert mod._default_dates(datetime(2026, 6, 19, 12, tzinfo=jst), "register") == [
        "20260620",
        "20260621",
    ]
    assert mod._default_dates(datetime(2026, 6, 20, 10, tzinfo=jst), "race") == [
        "20260620",
        "20260621",
    ]
    assert mod._default_dates(datetime(2026, 6, 21, 10, tzinfo=jst), "race") == [
        "20260621",
    ]


def test_est_odds_parser_captures_rendered_number():
    row = (
        '<tr class="HorseList" id="tr_1">'
        '<td class="Waku1 Txt_C"><span>1</span></td>'
        '<td class="Umaban1 Txt_C">1</td>'
        '<td class="HorseInfo"><a href="/horse/2021104999">テスト馬</a></td>'
        '<td class="Txt_R Popular"><span id="odds-1_01">3.4</span></td>'
        "</tr>"
    )
    runners = parse_entries_payload(row, "202605030611")
    assert len(runners) == 1
    assert runners[0]["est_odds"] == 3.4
