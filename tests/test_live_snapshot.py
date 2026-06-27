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

from keibamon_core.adapters.netkeiba_entries import (
    parse_entries_payload,
    parse_race_condition,
)
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


def test_build_race_passes_surface_and_distance_through():
    """Item 3: surface + distance_m from discover_card's RaceList_ItemLong
    cell must round-trip build_race so the app can render them on cards."""
    turf = build_race(
        {
            "race_no": 11,
            "surface": "turf",
            "distance_m": 2200,
            "runners": [{"umaban": 1, "win_odds": 5.0}],
        }
    )
    assert turf["surface"] == "turf"
    assert turf["distance_m"] == 2200

    # Absent fields degrade to None — older snapshots without these stay readable.
    legacy = build_race({"race_no": 1, "runners": [{"umaban": 1}]})
    assert legacy["surface"] is None
    assert legacy["distance_m"] is None


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
    assert snap["meta"]["counts"]["total"] == 2
    assert snap["meta"]["counts"]["registered"] == 1
    assert snap["meta"]["counts"]["open"] == 1
    # by_venue is the partial-publish guard's signal: {date|venue: count}.
    assert snap["meta"]["counts"]["by_venue"] == {"20260621|Tokyo": 2}
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
        {"horse_number": 1, "horse_name": "A", "est_odds": 4.0,
         "jockey_id": "05201", "jockey_name": "Takeshi"},
        {"horse_number": 2, "horse_name": "B", "est_odds": None},
    ]
    merged = merge_entries_and_odds(entries, {1: 2.8})
    # Milestone-4 form panel: jockey id + name ride along (option-a JOCKEY GAP).
    # Gate (wakuban) rides along too — None until the entries scrape parses one.
    assert merged[0] == {"umaban": 1, "name": "A", "win_odds": 2.8, "est_odds": 4.0,
                         "jockey_id": "05201", "jockey_name": "Takeshi", "gate": None}
    assert merged[1] == {"umaban": 2, "name": "B", "win_odds": None, "est_odds": None,
                         "jockey_id": None, "jockey_name": None, "gate": None}


def test_build_runner_passes_jockey_through():
    """build_runner carries jockey_id/jockey_name so the form panel can look up
    jockey history by id. None when absent (legacy/manual runners)."""
    r = build_runner({"umaban": 3, "name": "X", "jockey_id": "05201", "jockey_name": "Y"})
    assert r["jockey_id"] == "05201"
    assert r["jockey_name"] == "Y"
    bare = build_runner({"umaban": 3, "name": "X"})
    assert bare["jockey_id"] is None
    assert bare["jockey_name"] is None


def test_jockey_name_extracted_from_shutuba_row():
    """The shutuba parser pulls the jockey NAME (anchor text) alongside the id;
    it lives only in the in-memory entry dict (silver keeps jockey_id only)."""
    row = (
        '<tr class="HorseList" id="tr_1">'
        '<td class="Umaban1 Txt_C">1</td>'
        '<td class="Jockey"><a href="https://db.netkeiba.com/jockey/result/recent/05201/">武 豊</a></td>'
        "</tr>"
    )
    runners = parse_entries_payload(row, "202605030611")
    assert len(runners) == 1
    assert runners[0]["jockey_id"] == "05201"
    assert runners[0]["jockey_name"] == "武 豊"


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

    # register: Thursday or Friday, ANY hour (Thursday roster capture — JRA's
    # shutuba finalizes Thursday with a publish time that wanders inside the
    # 13:00-16:00 JST band; an hour gate would miss early publishes).
    assert win(at(2026, 6, 19, 11), "register") is True   # Fri
    assert win(at(2026, 6, 19, 9), "register") is True    # Fri early — now allowed
    assert win(at(2026, 6, 19, 23), "register") is True   # Fri late — now allowed
    assert win(at(2026, 6, 18, 15), "register") is True   # Thu afternoon
    assert win(at(2026, 6, 18, 12), "register") is True   # Thu before 14:00 — now allowed
    assert win(at(2026, 6, 18, 0), "register") is True    # Thu small hours — now allowed
    assert win(at(2026, 6, 17, 15), "register") is False  # Wed — still off
    assert win(at(2026, 6, 20, 8), "register") is False   # Sat morning — race window owns it
    # race: Sat/Sun 09:00-18:59 JST. The 17:00-18:59 extension (R2 Task 2)
    # catches late 確定: a race that finishes near 16:00 + a 30+min 審議
    # can confirm after the old 17:00 cutoff.
    assert win(at(2026, 6, 20, 10), "race") is True        # Sat morning
    assert win(at(2026, 6, 20, 16), "race") is True        # Sat late afternoon
    assert win(at(2026, 6, 20, 17), "race") is True        # Sat extended window (R2)
    assert win(at(2026, 6, 20, 18), "race") is True        # Sat last extended hour
    assert win(at(2026, 6, 20, 19), "race") is False       # Sat post-window
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


def test_parse_surface_distance_handles_index_cell_forms():
    """Item 3: _parse_surface_distance must split netkeiba's
    RaceList_ItemLong cell ("芝1800m" / "ダ1400m") into surface + distance_m
    without ever fabricating values."""
    mod = _load_expose_live()
    parse = mod._parse_surface_distance

    # Standard forms from the day-index page.
    assert parse("芝1800m") == ("turf", 1800)
    assert parse("ダ1400m") == ("dirt", 1400)
    assert parse(" 芝2200m ") == ("turf", 2200)  # tolerates whitespace

    # Absent / empty / unrecognised → (None, None). Never fabricate.
    assert parse(None) == (None, None)
    assert parse("") == (None, None)
    assert parse("—") == (None, None)


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


def test_thursday_pre_entries_layout_umaban_recovered_from_mark_id():
    """Thursday roster capture (2026-06-25). The Thursday-before-race shutuba
    page renders EMPTY Umaban + Waku cells server-side; the umaban is filled
    client-side by JS, but it's recoverable from the row's select control
    (``id="mark_N"``). Race-week layouts (the existing fixture) keep the
    populated cell, so this test pins the fallback in isolation."""
    # Mirrors the live 2026-06-25 函館記念 shutuba row structure (trimmed).
    row = (
        '<tr class="HorseList" id="tr_1">'
        '<td class="Waku Txt_C"><span></span></td>'
        '<td class="Umaban Txt_C"></td>'
        '<td class="CheckMark Horse_Select">'
        '<select class="makeMeFancy_1" name="1" id="mark_1" style="display: none;">'
        '<option value="_0">--</option></select>'
        "</td>"
        '<td class="HorseInfo"><span class="HorseName">'
        '<a href="https://db.netkeiba.com/horse/2017104756" target="_blank" '
        'title="アラタ">アラタ</a></span></td>'
        '<td class="Barei Txt_C">牡9</td>'
        '<td class="Txt_C">58.0</td>'
        '<td class="Jockey">'
        '<a href="https://db.netkeiba.com/jockey/result/recent/01096/" '
        'target="_blank" title="大野"> 大野</a></td>'
        '<td class="Txt_R Popular"><span id="odds-1_1">---.-</span></td>'
        "</tr>"
    )
    runners = parse_entries_payload(row, "202602010611")
    assert len(runners) == 1
    r = runners[0]
    # Umaban RECOVERED from the mark_1 id (not the empty cell).
    assert r["horse_number"] == 1
    # Horse identity intact.
    assert r["horse_id"] == "2017104756"
    assert r["horse_name"] == "アラタ"
    # Jockey name + id from the title attribute (latent bug fix — the old regex
    # required /CODE/"> which never matched real netkeiba anchors with target=
    # and title= attributes between the href and the >).
    assert r["jockey_id"] == "01096"
    assert r["jockey_name"] == "大野"
    # No estimated odds yet (Thursday pre-market) — placeholder stays None.
    assert r["est_odds"] is None
    # Wakuban stays None on the pre-entries layout (gate is JS-filled).
    assert r["gate"] is None





# ---------------------------------------------------------------------------
# ADR-0007 R3 — partial-publish guard.
#
# The publisher does INSERT OR REPLACE on key='current', so without a guard a
# partial scrape (netkeiba day-index hiccup; one track's R9–R12 missing) would
# silently clobber a previously complete card. `should_skip_publish` refuses
# the overwrite when the new snapshot has strictly fewer races than the
# existing row for any one date. Per-date so multi-date snapshots work; a new
# date always passes (no prior to clobber).
# ---------------------------------------------------------------------------


def _snap(race_nos_by_date: dict[str, int]) -> dict:
    """Build a minimal snapshot with N placeholder races per date."""
    races = []
    for d, n in race_nos_by_date.items():
        for i in range(1, n + 1):
            races.append({"date": d, "race_no": i, "venue": "Tokyo"})
    return {"meta": {"date": ",".join(race_nos_by_date)}, "races": races}


def test_should_skip_publish_allows_first_publish():
    mod = _load_expose_live()
    skip, _ = mod.should_skip_publish(_snap({"20260621": 36}), existing=None)
    assert skip is False


def test_should_skip_publish_allows_equal_or_larger_card():
    mod = _load_expose_live()
    existing = _snap({"20260621": 36})
    # same size — fine
    assert mod.should_skip_publish(_snap({"20260621": 36}), existing)[0] is False
    # larger — fine (more races are always welcome)
    assert mod.should_skip_publish(_snap({"20260621": 37}), existing)[0] is False


def test_should_skip_publish_refuses_strictly_smaller_card():
    """The regression that motivated this guard: a transient discover_card miss
    (e.g. Tokyo R9–R12 unreachable) returned 32 races for a date that already
    has 36 deployed. Without the guard, INSERT OR REPLACE would clobber the
    complete card with the partial one."""
    mod = _load_expose_live()
    existing = _snap({"20260621": 36})
    skip, reason = mod.should_skip_publish(_snap({"20260621": 32}), existing)
    assert skip is True
    assert "20260621" in reason
    assert "32 < 36" in reason


def test_should_skip_publish_refuses_when_only_one_date_shrinks():
    """Multi-date snapshot: the guard is per-date. A complete Sat + partial Sun
    is refused even if Sat grew."""
    mod = _load_expose_live()
    existing = _snap({"20260620": 12, "20260621": 12})
    # Sat grew, Sun shrank: refused (Sun's 8 < 12).
    skip, reason = mod.should_skip_publish(
        _snap({"20260620": 12, "20260621": 8}), existing
    )
    assert skip is True
    assert "20260621" in reason
    assert "20260620" not in reason


def test_should_skip_publish_allows_new_date_added():
    """First publish of Sun alongside an existing Sat card: nothing to clobber
    on the new date, so the publish goes through even though Sun's count is
    smaller than Sat's."""
    mod = _load_expose_live()
    existing = _snap({"20260620": 36})
    skip, _ = mod.should_skip_publish(
        _snap({"20260620": 36, "20260621": 12}), existing
    )
    assert skip is False


def test_should_skip_publish_ignores_empty_new_snapshot():
    """Empty new snapshot is the --skip-empty path, not the guard's concern."""
    mod = _load_expose_live()
    existing = _snap({"20260621": 36})
    skip, _ = mod.should_skip_publish({"races": []}, existing)
    assert skip is False


def test_should_skip_publish_handles_missing_race_date_field():
    """Legacy single-date snapshots omit per-race `date` and rely on meta.date.
    The guard's fallback must still count races correctly. Each race DOES carry
    a venue (production snapshots always do -- it's how the app groups cards)."""
    mod = _load_expose_live()
    existing = {
        "meta": {"date": "20260621"},
        "races": [
            {"race_no": i, "venue": "Tokyo"} for i in range(1, 13)
        ] + [
            {"race_no": i, "venue": "Hanshin"} for i in range(1, 13)
        ] + [
            {"race_no": i, "venue": "Hakodate"} for i in range(1, 13)
        ],  # 36, no per-race date
    }
    new = {
        "meta": {"date": "20260621"},
        "races": [
            {"race_no": i, "venue": "Tokyo"} for i in range(1, 9)
        ] + [
            {"race_no": i, "venue": "Hanshin"} for i in range(1, 13)
        ] + [
            {"race_no": i, "venue": "Hakodate"} for i in range(1, 13)
        ],  # 32 -- Tokyo truncated to 8
    }
    skip, reason = mod.should_skip_publish(new, existing)
    assert skip is True
    # Per-(date, venue) regression pins WHICH venue regressed (Tokyo -> code
    # "05" -- the guard keys on the JRA venue code, not the display name).
    assert "05" in reason  # Tokyo's JRA code
    assert "8 < 12" in reason


# ---------------------------------------------------------------------------
# R4 (Tokyo truncation root cause) -- strengthened guard with race_card_max.
# The R3 guard only compared per-date totals -- "32 -> 32" passed, advancing
# meta.published_at while Tokyo stayed broken. R4 gates on per-(date, venue)
# floors drawn from a separate D1 table that survives across publishes.
# ---------------------------------------------------------------------------


def _snap_r4(date: str, venue_counts: dict[str, int]) -> dict:
    """Build a snapshot with per-venue race counts. venue_counts keys are
    venue CODES (02/05/09) -- same shape the guard keys on internally."""
    races = []
    for venue_code, n in venue_counts.items():
        from keibamon_core.live.snapshot import build_live_snapshot

        # Use the venue code as the venue field directly -- the guard's
        # _venue_code_for() passes unknown strings through verbatim, so the
        # code-as-name shortcut keeps the test deterministic without depending
        # on VENUE_NAMES resolution.
        for i in range(1, n + 1):
            races.append({"date": date, "race_no": i, "venue": venue_code})
    snap = build_live_snapshot(races, date=date)
    return snap


def test_should_skip_publish_uses_card_max_to_refuse_regression():
    """The race_card_max high-water mark is the guard's INDEPENDENT baseline.
    A new snapshot that regresses ANY venue below the stored max is REFUSED --
    even if there's no existing snapshot to compare against."""
    mod = _load_expose_live()
    new = _snap_r4("20260621", {"02": 12, "05": 8, "09": 12})  # Tokyo truncated
    # race_card_max says Tokyo=12 from a prior healthy publish.
    card_max = {("20260621", "02"): 12, ("20260621", "05"): 12, ("20260621", "09"): 12}
    skip, reason = mod.should_skip_publish(new, existing=None, card_max=card_max)
    assert skip is True
    assert "05" in reason  # Tokyo regressed
    assert "8 < 12" in reason


def test_should_skip_publish_allows_meeting_card_max():
    """Publishing at-or-above the high-water mark passes and the publisher
    will then advance the mark."""
    mod = _load_expose_live()
    new = _snap_r4("20260621", {"02": 12, "05": 12, "09": 12})
    card_max = {("20260621", "02"): 12, ("20260621", "05"): 12, ("20260621", "09"): 12}
    skip, _ = mod.should_skip_publish(new, existing=None, card_max=card_max)
    assert skip is False
    # Above max -- new race added -- also fine.
    new_above = _snap_r4("20260621", {"02": 12, "05": 13, "09": 12})
    skip, _ = mod.should_skip_publish(new_above, existing=None, card_max=card_max)
    assert skip is False


def test_should_skip_publish_new_date_ignores_card_max():
    """A date not in card_max always passes -- no prior baseline means the
    first publish for a new date can't be a regression."""
    mod = _load_expose_live()
    new = _snap_r4("20260628", {"05": 8})  # new date, truncated
    card_max = {("20260621", "05"): 12}  # different date
    skip, _ = mod.should_skip_publish(new, existing=None, card_max=card_max)
    assert skip is False


def test_partial_flag_marks_venue_below_structural_floor():
    """The structural floor is the backstop for the 'first publish for a date
    was already truncated' hole -- race_card_max can't catch that (no prior
    high-water), so a venue at e.g. 4 races is flagged in meta.counts.partial.
    The publish is NOT refused (the dashboard still gets something) but the
    flag is visible to the verifier."""
    mod = _load_expose_live()
    # Tokyo=4 races -- below the structural floor (6). No card_max for this
    # date so the regression check can't see it.
    new = _snap_r4("20260628", {"05": 4, "02": 12, "09": 12})
    is_partial, warns = mod.partial_flag(new, card_max=None)
    assert is_partial is True
    assert any("05" in w and "4" in w for w in warns)
    # Only Tokyo (05) is below floor; Hakodate (02) and Hanshin (09) are
    # excluded. Match the venue-code slot after the "|" so a date like
    # "20260628" doesn't false-match "02".
    warned_venues = {w.split("|", 1)[1].split(":")[0] for w in warns}
    assert warned_venues == {"05"}


def test_partial_flag_clean_for_full_card():
    mod = _load_expose_live()
    new = _snap_r4("20260621", {"02": 12, "05": 12, "09": 12})
    is_partial, warns = mod.partial_flag(new, card_max=None)
    assert is_partial is False
    assert warns == []


# ---------------------------------------------------------------------------
# Gate (waku/枠) + going (馬場状態) enrichment.
#
# The producer parses gate from the shutuba row's Waku cell
# (`_extract_wakuban`) and going from the RaceData01 section
# (`parse_race_condition`). The snapshot builder carries both through so the
# live edition's gate_snapshot_at / condition_snapshot_at flip from "pending"
# to a real timestamp the moment a graded card actually carries the data —
# rather than stamping a fresh-looking time on empty fields.
# Tokens are pinned to firm/good/soft/heavy (matches jravan.GOING_LABELS
# + form_starts.going) so the lake and the app agree on the going vocabulary.
# ---------------------------------------------------------------------------


def test_build_runner_passes_gate_through():
    """build_runner carries gate (wakuban) alongside umaban; None when absent
    (Thursday pre-entries layout has the cell JS-filled)."""
    r = build_runner({"umaban": 3, "name": "X", "gate": 6})
    assert r["gate"] == 6
    bare = build_runner({"umaban": 3, "name": "X"})
    assert bare["gate"] is None


def test_build_race_passes_going_through():
    """build_race carries going (normalized by the adapter); None until JRA
    posts the RaceData01 section on race-morning."""
    with_going = build_race(
        {
            "race_no": 11,
            "going": "firm",
            "runners": [{"umaban": 1, "win_odds": 5.0}],
        }
    )
    assert with_going["going"] == "firm"
    legacy = build_race({"race_no": 1, "runners": [{"umaban": 1}]})
    assert legacy["going"] is None


def test_merge_entries_and_odds_passes_gate_through():
    """merge_entries_and_odds carries gate (option-a JOCKEY GAP pattern) so the
    entries-scrape gate survives into the runner-input shape build_runner
    expects. None when the entries scrape didn't parse one."""
    entries = [
        {"horse_number": 1, "horse_name": "A", "est_odds": 4.0, "gate": 5},
        {"horse_number": 2, "horse_name": "B", "est_odds": None},
    ]
    merged = merge_entries_and_odds(entries, {1: 2.8})
    assert merged[0]["gate"] == 5
    assert merged[1]["gate"] is None


def test_parse_race_condition_normalizes_each_token():
    """All four JRA going tokens normalize to the lake vocabulary. Order in the
    regex alternation matters: 稍重 and 不良 must be tried before the single-char
    重 and 良, otherwise 重 would match the second char of 稍重 and yield soft
    for a 稍重 (good) track."""
    assert parse_race_condition("馬場:良") == {"going": "firm"}
    assert parse_race_condition("馬場:稍重") == {"going": "good"}
    assert parse_race_condition("馬場:重") == {"going": "soft"}
    assert parse_race_condition("馬場:不良") == {"going": "heavy"}
    # Full-width colon tolerated (netkeiba occasionally serves one).
    assert parse_race_condition("馬場：稍重") == {"going": "good"}
    # Whitespace around the token tolerated.
    assert parse_race_condition("馬場: 稍重") == {"going": "good"}


def test_parse_race_condition_returns_none_when_absent():
    """Before race-morning the 馬場 cell isn't on the page — no fabrication."""
    assert parse_race_condition("") is None
    assert parse_race_condition("<html>no going here</html>") is None
    # An unrelated 馬場 mention without a recognized token is a non-match too.
    assert parse_race_condition("馬場:—") is None
    # The regex needs the 馬場 prefix — a bare 稍重 elsewhere on the page must
    # NOT match (it could be a jockey note or weather copy).
    assert parse_race_condition("稍重馬場の京都競馬場") is None


def test_parse_race_condition_picks_first_match_in_real_shutuba_fragment():
    """Real netkeiba RaceData02 fragment (captured 2026-06-14 Hanshin result
    page). Going sits in ``<span class="Item03">/ 馬場: TOKEN</span>`` alongside
    weather + surface/distance. The regex anchors on ``馬場:`` (half-width
    colon, no space) and tolerates the surrounding slash separators."""
    # Real RaceData02 fragment shape (trimmed from the captured fixture):
    fragment = (
        '<div class="RaceData01">\n'
        '15:40発走 /<!-- <span class="Turf"> --><span> 芝2200m</span> (右 B)\n'
        '/ 天候:雨<span class="Icon_Weather Weather03"></span>\n'
        '<span class="Item03">/ 馬場:重</span>\n'
        "</div>"
    )
    assert parse_race_condition(fragment) == {"going": "soft"}


def test_parse_race_condition_against_real_result_fixture():
    """End-to-end: the captured 202609030411 result page (2026-06-14 Hanshin,
    heavy going that day) parses to going=soft. Pre-race-day shutuba pages
    have no 馬場 cell yet → None, no fabrication."""
    result_html = (FIXTURES / "result_202609030411.html").read_text(encoding="utf-8")
    assert parse_race_condition(result_html) == {"going": "soft"}

    shutuba_html = (FIXTURES / "shutuba_202609030611.html").read_text(encoding="utf-8")
    assert parse_race_condition(shutuba_html) is None


def test_extract_wakuban_against_real_shutuba_fixture():
    """The 18-runner shutuba fixture parses gates for every row (no None) —
    confirms the Waku cell regex matches real netkeiba HTML, not just the
    trimmed test fragments. The same regex backs the entries-scrape gate that
    flows through merge_entries_and_odds → build_runner → live edition."""
    html = (FIXTURES / "shutuba_202609030611.html").read_text(encoding="utf-8")
    runners = parse_entries_payload(html, "202609030611")
    assert len(runners) == 18
    # Every runner carries a non-null gate from the Waku cell.
    assert all(r.get("gate") is not None for r in runners)
    # Gates are 1..8 (JRA bracket ladder for an 18-horse field) — sanity check
    # the parser isn't picking up the umaban or another cell by accident.
    gates = sorted(r["gate"] for r in runners)
    assert gates[0] == 1
    assert gates[-1] <= 8



