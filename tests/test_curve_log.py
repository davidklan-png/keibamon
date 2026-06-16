"""Tests for the settle logger (ingestion/curve_log.py)."""
from datetime import datetime, timedelta, timezone

from keibamon_core.ingestion.curve_log import (
    build_curve_records,
    crosswalk_race_id,
    devig,
    settle_curve_records,
    snapshot_rows_from_timeseries,
    summarize,
)

T0 = datetime(2026, 6, 14, 5, 0, tzinfo=timezone.utc)


def _snap(rid, hn, win, mins):
    return {"race_id": rid, "horse_number": hn, "win_odds": win,
            "available_at": (T0 + timedelta(minutes=mins)).isoformat()}


def test_crosswalk_feed_id_to_canonical():
    assert crosswalk_race_id("r-2026-0614-hanshin-11") == "jra-20260614-09-11"
    assert crosswalk_race_id("r-2026-0614-tokyo-01") == "jra-20260614-05-01"


def test_crosswalk_is_idempotent_on_canonical_ids():
    # official jravan_rt ids are already canonical and must pass through
    assert crosswalk_race_id("jra-20260614-09-11") == "jra-20260614-09-11"


def test_snapshot_rows_from_timeseries_maps_sel_and_filters():
    ts = [
        {"race_id": "jra-20260614-09-11", "sel": "05", "win_odds": 2.1,
         "available_at": "t1", "source_name": "jravan_rt", "pool": "win"},
        {"race_id": "jra-20260614-09-11", "sel": "05", "win_odds": None,
         "available_at": "t1", "source_name": "jravan_rt", "pool": "place"},   # wrong pool
        {"race_id": "jra-20260614-09-11", "sel": "07", "win_odds": 9.9,
         "available_at": "t1", "source_name": "netkeiba", "pool": "win"},      # wrong source
    ]
    out = snapshot_rows_from_timeseries(ts, source="jravan_rt", pool="win")
    assert len(out) == 1
    assert out[0] == {"race_id": "jra-20260614-09-11", "horse_number": 5,
                      "win_odds": 2.1, "available_at": "t1"}


def test_official_curve_settles_without_crosswalk(tmp_path):
    # canonical-id win curve (as it comes from jravan_rt) freezes + settles cleanly
    from datetime import datetime, timedelta, timezone
    t0 = datetime(2026, 6, 14, 6, 0, tzinfo=timezone.utc)
    ts = []
    for hn in range(1, 9):
        for m in (0, 30):
            ts.append({"race_id": "jra-20260614-09-11", "sel": f"{hn:02d}",
                       "win_odds": 10.0 - m / 10, "available_at": (t0 + timedelta(minutes=m)).isoformat(),
                       "source_name": "jravan_rt", "pool": "win"})
    snaps = snapshot_rows_from_timeseries(ts, source="jravan_rt")
    recs = build_curve_records(snaps, lead_min=10)
    assert recs and all(r["race_id"] == "jra-20260614-09-11" for r in recs)
    settled = settle_curve_records(recs, {("jra-20260614-09-11", 5): (1, 6.0)})
    w = next(r for r in settled if r["horse_number"] == 5)
    assert w["won"] is True and w["settle_odds"] == 6.0


def test_devig_sums_to_one():
    # real odds carry an overround (takeout): 1/2 + 1/3 + 1/5 = 1.033 > 1
    probs, over = devig({1: 2.0, 2: 3.0, 3: 5.0})
    assert abs(sum(probs.values()) - 1.0) < 1e-9   # normalized to a proper distribution
    assert over > 1.0                              # raw inverse sum = the overround


def test_decision_is_point_in_time_never_peeks_past_t():
    # A late snapshot after the decision time must NOT set decision_odds.
    rid = "r-2026-0614-hanshin-11"
    rows = []
    for hn in range(1, 9):
        rows += [_snap(rid, hn, 5.0, 0), _snap(rid, hn, 4.0, 30)]  # open 5.0, close 4.0
    # last_cap = T0+30; lead 10 -> t = T0+20, so only the T0 (open) snap is <= t
    recs = build_curve_records(rows, lead_min=10)
    r = recs[0]
    assert r["open_odds"] == 5.0
    assert r["close_odds"] == 4.0
    assert r["decision_odds"] == 5.0          # the post-t snapshot was excluded
    assert datetime.fromisoformat(r["decision_at"]) == T0


def test_settle_pays_official_final_not_decision_price():
    rid = "r-2026-0614-hanshin-11"
    rows = []
    for hn in range(1, 9):
        rows += [_snap(rid, hn, 10.0, 0), _snap(rid, hn, 8.0, 30)]
    recs = build_curve_records(rows, lead_min=10)   # decision_odds = 10.0, close = 8.0
    # winner #1 finished 1st, official final odds 6.0 (firmed past the close)
    results = {("jra-20260614-09-11", 1): (1, 6.0),
               ("jra-20260614-09-11", 2): (2, 9.0)}
    settled = settle_curve_records(recs, results)
    w = next(r for r in settled if r["horse_number"] == 1)
    assert w["won"] is True and w["top3"] is True
    assert w["settle_odds"] == 6.0            # official final, not 10.0 seen at t
    assert w["settled_payout"] == 6.0
    loser = next(r for r in settled if r["horse_number"] == 2)
    assert loser["won"] is False and loser["settled_payout"] == 0.0
    assert loser["top3"] is True              # finished 2nd


def test_unsettled_race_passes_through():
    rid = "r-2026-0614-hanshin-11"
    rows = [_snap(rid, hn, 5.0, 0) for hn in range(1, 9)]
    recs = build_curve_records(rows)
    settled = settle_curve_records(recs, results={})  # no results yet
    assert all(r["settled"] is False for r in settled)


def test_build_curve_records_stamps_going_context():
    rid = "r-2026-0614-hanshin-11"
    rows = [_snap(rid, hn, 5.0, m) for hn in range(1, 9) for m in (0, 30)]
    ctx = {rid: {"weather": "rain", "going": "soft", "going_wetness": 3,
                 "going_transition": True}}
    recs = build_curve_records(rows, lead_min=10, race_context=ctx)
    assert recs
    assert all(r["going"] == "soft" and r["going_wetness"] == 3
               and r["going_transition"] is True and r["weather"] == "rain" for r in recs)


def test_summarize_going_split_and_expected_wins():
    rows = [
        {"settled": True, "drift_dir": "firming", "going_transition": True,
         "won": True, "settled_payout": 4.0, "p_decision": 0.3},
        {"settled": True, "drift_dir": "firming", "going_transition": False,
         "won": False, "settled_payout": 0.0, "p_decision": 0.2},
    ]
    by_drift = summarize(rows)
    assert by_drift["firming"]["n"] == 2 and by_drift["firming"]["wins"] == 1
    assert by_drift["firming"]["expected_mkt"] == 0.5    # market expected 0.5 wins
    split = summarize(rows, by=("drift_dir", "going_transition"))
    assert split[("firming", True)]["n"] == 1 and split[("firming", True)]["wins"] == 1
    assert split[("firming", False)]["wins"] == 0


def test_summarize_groups_by_drift_and_computes_roi():
    rows = [
        {"settled": True, "drift_dir": "firming", "won": True, "settled_payout": 4.0},
        {"settled": True, "drift_dir": "firming", "won": False, "settled_payout": 0.0},
        {"settled": True, "drift_dir": None, "won": False, "settled_payout": 0.0},
        {"settled": False, "drift_dir": "firming", "won": True, "settled_payout": 9.0},  # ignored
    ]
    s = summarize(rows)
    assert s["firming"]["n"] == 2
    assert s["firming"]["win_rate"] == 0.5
    assert s["firming"]["roi"] == 1.0          # mean payout 2.0 -> ROI +1.0
    assert s["neutral"]["n"] == 1 and s["neutral"]["roi"] == -1.0
