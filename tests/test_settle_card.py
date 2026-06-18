"""Tests for weekend stage 4: settle_card + calibration.

Two scopes:

  1. ``settle_card`` -- the integration path. Uses real ``jravan_payouts`` /
     ``jravan_race_results`` / ``jravan_race_entries`` silver datasets (written
     via the Hive-partitioned ``write_dataset`` path that production uses), so
     settlement's scratch detection, payout lookup, and the placeholder-safe
     join are exercised end to end. The frozen ``model_card`` is built via
     :func:`freeze_model_card` so its append-only / immutability contract is
     preserved.
  2. ``calibration`` -- pure functions. Tests inject settled-row dicts directly
     so the math is verifiable by hand (no I/O).

Throughout: ``model_card`` must stay byte-identical across every settle call
(D2 immutability -- outcomes live in the sibling table).
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from keibamon_core.lake import read_parquet_if_exists, write_dataset, write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline
from keibamon_core.weekend.calibration import (
    TopPickROI,
    calibration_report,
)
from keibamon_core.weekend.model_card import MODEL_CARD_TABLE, freeze_model_card
from keibamon_core.weekend.settle_card import (
    MODEL_CARD_SETTLED_TABLE,
    settle_card,
)


# --- shared fixtures ---------------------------------------------------------


class _FixturePredictor:
    """Deterministic predictor for tests; scores from a {horse_id: score} map."""

    name = "fixture_predictor"

    def __init__(self, scores: dict[str, float]):
        self._scores = scores

    def score_race(self, race: dict[str, Any], feature_rows: list[dict[str, Any]]) -> dict[str, float]:
        return {row["horse_id"]: self._scores.get(row["horse_id"], 0.0) for row in feature_rows}


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path)


def _device_role_file(tmp_path: Path, role: str = "mac-dev") -> Path:
    role_file = tmp_path / ".device"
    role_file.write_text(f"role = {role}\n")
    return role_file


def _populate_card(
    lake: LakePaths,
    race_id: str,
    runners: list[dict[str, Any]],
    *,
    predictor_scores: dict[str, float],
    posted_before_market: bool = True,
) -> list[dict[str, Any]]:
    """Freeze a model_card for one race via freeze_model_card.

    ``runners`` is a list of ``{horse_id, horse_number, gate}`` dicts. The PIT
    flag (posted_before_market) is set via the market snapshot time passed to
    freeze_model_card.
    """
    rid = race_id
    feature_rows = [
        {"race_id": rid, "horse_id": r["horse_id"], "horse_number": r["horse_number"],
         "devigged_market_prob": None, "win_odds": None}
        for r in runners
    ]
    entries = [
        {"race_id": rid, "horse_id": r["horse_id"], "horse_number": r["horse_number"],
         "gate": r["gate"]}
        for r in runners
    ]
    posted_at = datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc)
    # posted_at < first_market -> posted_before_market=True.
    # posted_at > first_market -> posted_before_market=False.
    first_market = (
        datetime(2026, 6, 20, 2, 0, tzinfo=timezone.utc)
        if posted_before_market
        else datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)
    )
    return freeze_model_card(
        lake, rid,
        predictor=_FixturePredictor(predictor_scores),
        feature_rows=feature_rows,
        entries=entries,
        posted_at=posted_at,
        first_market_available_at=first_market,
    )


def _write_silver(lake: LakePaths, table: str, rows: list[dict[str, Any]]) -> None:
    """Write rows to a Hive-partitioned silver dataset (year+venue required)."""
    if not rows:
        return
    write_dataset(rows, lake.silver_dataset(table))


def _year_venue(rid: str) -> tuple[int, str]:
    """Parse 'jra-YYYYMMDD-jyo-NN' -> (year, jyo)."""
    parts = rid.split("-")
    return int(parts[1][:4]), parts[2]


# --- settlement integration --------------------------------------------------


def test_official_payout_row_pays_at_official_amount(lake: LakePaths):
    """settle_many looks up the win combo in jravan_payouts and scales per 100 yen."""
    rid = "jra-20260620-09-11"
    year, venue = _year_venue(rid)
    runners = [
        {"horse_id": "AAA", "horse_number": 1, "gate": 1},
        {"horse_id": "BBB", "horse_number": 2, "gate": 2},
    ]
    # Top pick is hn=1 (higher score).
    _populate_card(lake, rid, runners, predictor_scores={"AAA": 0.6, "BBB": 0.4})

    _write_silver(lake, "jravan_race_entries", [
        {"race_id": rid, "horse_id": "AAA", "horse_number": 1, "year": year, "venue": venue},
        {"race_id": rid, "horse_id": "BBB", "horse_number": 2, "year": year, "venue": venue},
    ])
    _write_silver(lake, "jravan_race_results", [
        # hn=1 won at official final odds 5.0
        {"race_id": rid, "horse_id": "AAA", "horse_number": 1,
         "finish_position": 1, "win_odds": 5.0, "year": year, "venue": venue},
        {"race_id": rid, "horse_id": "BBB", "horse_number": 2,
         "finish_position": 2, "win_odds": 9.0, "year": year, "venue": venue},
    ])
    _write_silver(lake, "jravan_payouts", [
        # JRA payouts are per 100 yen stake. 500 -> 5.0 decimal.
        {"race_id": rid, "pool": "win", "combo": "01",
         "payout_yen": 500, "year": year, "venue": venue},
    ])

    settled = settle_card(lake, [rid])
    by_hn = {int(r["horse_number"]): r for r in settled}
    top = by_hn[1]
    assert top["is_top_pick"] is True
    assert top["won"] is True
    assert top["finish_position"] == 1
    assert top["payout_yen"] == 500              # scaled 1:1 with stake_yen=100
    assert top["stake_yen"] == 100
    assert top["refund_yen"] == 0
    assert top["settle_reason"] == "official_payout"
    assert top["final_odds"] == 5.0
    # Non-top-pick row carries the outcome but no settlement columns.
    non_top = by_hn[2]
    assert non_top["is_top_pick"] is False
    assert non_top["stake_yen"] == 0
    assert non_top["payout_yen"] == 0
    assert non_top["settle_reason"] == "no_bet"
    assert non_top["finish_position"] == 2 and non_top["won"] is False


def test_missing_payout_for_a_starter_is_a_loss(lake: LakePaths):
    """Modeling-spine.md step 1: a missing payout row is a loss, not a refund,
    when the selected runner actually started (is in results)."""
    rid = "jra-20260620-09-11"
    year, venue = _year_venue(rid)
    runners = [{"horse_id": "AAA", "horse_number": 1, "gate": 1}]
    _populate_card(lake, rid, runners, predictor_scores={"AAA": 1.0})

    _write_silver(lake, "jravan_race_entries", [
        {"race_id": rid, "horse_id": "AAA", "horse_number": 1, "year": year, "venue": venue},
    ])
    _write_silver(lake, "jravan_race_results", [
        # Started, finished 2nd -- NOT scratched.
        {"race_id": rid, "horse_id": "AAA", "horse_number": 1,
         "finish_position": 2, "win_odds": 9.0, "year": year, "venue": venue},
    ])
    # No payouts row at all for this race.
    _write_silver(lake, "jravan_payouts", [])

    settled = settle_card(lake, [rid])
    top = next(r for r in settled if r["is_top_pick"])
    assert top["settle_reason"] == "loss"
    assert top["payout_yen"] == 0
    assert top["refund_yen"] == 0
    assert top["stake_yen"] == 100              # the hypothetical bet still cost 100 yen


def test_scratched_top_pick_with_shared_placeholder_id_is_refund(lake: LakePaths):
    """DATA_TRAPS: two runners share horse_id='0000000000'. The top pick (hn=1)
    is in entries but absent from results (scratched); the other runner (hn=2)
    IS in results (winner). The placeholder-safe join must NOT cross-match hn=2's
    result to hn=1 -- hn=1 should be a refund, not a win or a loss."""
    rid = "jra-20260620-09-11"
    year, venue = _year_venue(rid)
    runners = [
        {"horse_id": "0000000000", "horse_number": 1, "gate": 1},
        {"horse_id": "0000000000", "horse_number": 2, "gate": 2},
    ]
    # hn=1 is the top pick.
    _populate_card(lake, rid, runners, predictor_scores={"0000000000": 0.6})

    _write_silver(lake, "jravan_race_entries", [
        {"race_id": rid, "horse_id": "0000000000", "horse_number": 1, "year": year, "venue": venue},
        {"race_id": rid, "horse_id": "0000000000", "horse_number": 2, "year": year, "venue": venue},
    ])
    # ONLY hn=2 finished. hn=1 is absent -> scratch.
    _write_silver(lake, "jravan_race_results", [
        {"race_id": rid, "horse_id": "0000000000", "horse_number": 2,
         "finish_position": 1, "win_odds": 3.0, "year": year, "venue": venue},
    ])
    # Payout only for hn=2 (the winner). No payout for hn=1.
    _write_silver(lake, "jravan_payouts", [
        {"race_id": rid, "pool": "win", "combo": "02",
         "payout_yen": 300, "year": year, "venue": venue},
    ])

    settled = settle_card(lake, [rid])
    by_hn = {int(r["horse_number"]): r for r in settled}
    top = by_hn[1]
    assert top["is_top_pick"] is True
    assert top["settle_reason"] == "refund"
    assert top["refund_yen"] == 100
    assert top["payout_yen"] == 0
    # If the cross-match bug were present, hn=1 would inherit hn=2's finish (1)
    # and the row would carry won=True with a payout, not a refund.
    assert top["won"] is False
    assert top["finish_position"] is None


def test_model_card_is_byte_identical_after_settle(lake: LakePaths):
    """D2: settle_card reads model_card but must never write it. Snapshot the
    bytes before, settle, re-read, and assert no diff."""
    rid = "jra-20260620-09-11"
    year, venue = _year_venue(rid)
    _populate_card(
        lake, rid,
        runners=[{"horse_id": "AAA", "horse_number": 1, "gate": 1}],
        predictor_scores={"AAA": 1.0},
    )
    model_card_before = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))

    settle_card(
        lake, [rid],
        results={(rid, 1): (1, 4.0)},  # injected results, no payouts needed
        settle_fn=lambda lk, bets: [],  # bypass payouts to isolate immutability
    )

    model_card_after = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    assert model_card_after == model_card_before, (
        "model_card was mutated by settle_card -- it must stay byte-identical; "
        "outcomes live in model_card_settled"
    )


def test_resettle_is_idempotent_on_key(lake: LakePaths):
    """Re-running settle_card with the same inputs upserts in place, no dupes."""
    rid = "jra-20260620-09-11"
    _populate_card(
        lake, rid,
        runners=[{"horse_id": "AAA", "horse_number": 1, "gate": 1}],
        predictor_scores={"AAA": 1.0},
    )
    results = {(rid, 1): (1, 4.0)}

    settle_card(lake, [rid], results=results, settle_fn=lambda lk, bets: [])
    settle_card(lake, [rid], results=results, settle_fn=lambda lk, bets: [])

    rows = read_parquet_if_exists(lake.silver_table(MODEL_CARD_SETTLED_TABLE))
    # One row per (race_id, horse_number, card_version). Re-settle replaced in place.
    keys = {(r["race_id"], int(r["horse_number"]), int(r["card_version"])) for r in rows}
    assert keys == {(rid, 1, 1)}


# --- calibration: pure-function math ----------------------------------------


def _row(
    rid: str, hn: int, model_p: float, *, won: bool, top_pick: bool,
    pbm: bool = True, payout: int = 0, refund: int = 0,
    stake: int | None = None, reason: str = "loss", cv: int = 1,
) -> dict[str, Any]:
    """Build a settled row dict with sensible defaults for calibration tests."""
    return {
        "race_id": rid, "horse_number": hn, "card_version": cv,
        "model_p": model_p, "posted_before_market": pbm,
        "is_top_pick": top_pick, "won": won,
        "stake_yen": (stake if stake is not None else (100 if top_pick else 0)),
        "payout_yen": payout, "refund_yen": refund, "settle_reason": reason,
    }


def test_calibration_log_loss_matches_hand_computation():
    """2 races, clean. Winner model_p known -> -log(p_w) averaged by hand."""
    rows = [
        _row("r1", 1, 0.5, won=True,  top_pick=True,  payout=200, reason="official_payout"),
        _row("r1", 2, 0.5, won=False, top_pick=False),
        _row("r2", 1, 0.7, won=False, top_pick=True,  reason="loss"),
        _row("r2", 2, 0.3, won=True,  top_pick=False),
    ]
    rep = calibration_report(rows)
    assert rep.clean is not None
    # Race 1 winner p=0.5 -> -log(0.5); Race 2 winner p=0.3 -> -log(0.3); mean.
    expected = (math.log(2) + math.log(1 / 0.3)) / 2
    assert rep.clean.probability.model_log_loss == pytest.approx(expected)


def test_calibration_brier_matches_hand_computation():
    """Per-runner Brier = mean of (p - y)^2."""
    rows = [
        _row("r1", 1, 0.5, won=True,  top_pick=True,  payout=200, reason="official_payout"),
        _row("r1", 2, 0.5, won=False, top_pick=False),
    ]
    rep = calibration_report(rows)
    # (0.5 - 1)^2 + (0.5 - 0)^2 = 0.25 + 0.25 = 0.5; mean over 2 runners = 0.25
    assert rep.clean.probability.model_brier == pytest.approx(0.25)


def test_calibration_top_pick_roi_official_payout():
    """Top-pick ROI = (sum payout + sum refund) / sum stake - 1."""
    rows = [
        _row("r1", 1, 0.5, won=True,  top_pick=True,  payout=200, reason="official_payout"),
        _row("r1", 2, 0.5, won=False, top_pick=False),
        _row("r2", 1, 0.5, won=False, top_pick=True,  reason="loss"),
        _row("r2", 2, 0.5, won=True,  top_pick=False),
    ]
    rep = calibration_report(rows)
    # 2 bets of 100 each; total payout 200; ROI = 200/200 - 1 = 0.0
    assert rep.clean.top_pick_roi.roi == pytest.approx(0.0)
    assert rep.clean.top_pick_roi.n == 2
    assert rep.clean.top_pick_roi.wins == 1
    # n=2 is well below thin_roi_min (50); flagged.
    assert rep.clean.top_pick_roi.thin is True
    assert rep.clean.top_pick_roi.beats_takeout is False


def test_calibration_market_bar_is_reported_when_supplied():
    rows = [
        _row("r1", 1, 0.5, won=True,  top_pick=True,  payout=200, reason="official_payout"),
        _row("r1", 2, 0.5, won=False, top_pick=False),
    ]
    market = {("r1", 1): 0.4, ("r1", 2): 0.6}
    rep = calibration_report(rows, market_prob_by_key=market)
    # Market log-loss: winner hn=1 had market_p=0.4 -> -log(0.4).
    assert rep.clean.probability.market_log_loss == pytest.approx(-math.log(0.4))
    # Model log-loss: winner hn=1 had model_p=0.5 -> -log(0.5).
    assert rep.clean.probability.model_log_loss == pytest.approx(math.log(2))
    # delta = model - market (positive here -> model worse than market on this race).
    assert rep.clean.probability.model_log_loss_delta_vs_market == pytest.approx(
        math.log(2) - (-math.log(0.4))
    )


def test_calibration_market_bar_is_none_when_not_supplied():
    rows = [_row("r1", 1, 0.5, won=True, top_pick=True, payout=200, reason="official_payout")]
    rep = calibration_report(rows)
    assert rep.clean.probability.market_log_loss is None
    assert rep.clean.probability.model_log_loss_delta_vs_market is None


def test_posted_before_market_slicing_keeps_buckets_separate():
    """ADR-0003 D3: clean (posted_before_market=True) and contaminated (False)
    are reported separately; the report never blends them."""
    rows = [
        # Clean race
        _row("r1", 1, 0.5, won=True,  top_pick=True,  pbm=True, payout=200, reason="official_payout"),
        _row("r1", 2, 0.5, won=False, top_pick=False, pbm=True),
        # Contaminated race
        _row("r2", 1, 0.5, won=False, top_pick=True,  pbm=False, reason="loss"),
        _row("r2", 2, 0.5, won=True,  top_pick=False, pbm=False),
    ]
    rep = calibration_report(rows)
    assert rep.clean is not None and rep.contaminated is not None
    assert rep.clean.n_runners == 2
    assert rep.contaminated.n_runners == 2
    # Clean: r1 only; contaminated: r2 only.
    assert rep.clean.n_races == 1
    assert rep.contaminated.n_races == 1
    # Headline = clean slice.
    assert rep.headline is rep.clean


def test_thin_bin_is_flagged_not_averaged_into_headline():
    """A probability bin with fewer than thin_bin_min rows is flagged thin;
    its raw numbers are still reported (so the count is visible) but the flag
    lets the dashboard avoid flattering a sparse bucket."""
    # All 3 rows in the [0.4, 0.5) bin -- below thin_bin_min=30 by default.
    rows = [
        _row("r1", 1, 0.45, won=True,  top_pick=True,  payout=200, reason="official_payout"),
        _row("r1", 2, 0.45, won=False, top_pick=False),
        _row("r2", 1, 0.45, won=False, top_pick=True,  reason="loss"),
    ]
    rep = calibration_report(rows)
    # The [0.4, 0.5) bin is populated but thin.
    bins_with_rows = [b for b in rep.clean.bins if b.n > 0]
    assert len(bins_with_rows) == 1
    assert bins_with_rows[0].thin is True
    assert bins_with_rows[0].n == 3
    assert bins_with_rows[0].mean_prob == pytest.approx(0.45)


def test_empty_input_returns_none_slices():
    rep = calibration_report([])
    assert rep.clean is None
    assert rep.contaminated is None
    assert rep.n_total == 0


# --- pipeline.settle ---------------------------------------------------------


def test_pipeline_settle_runs_full_chain_and_summarizes(lake: LakePaths, tmp_path: Path, monkeypatch):
    """End-to-end: device guard -> curve_log settle -> settle_card -> report.
    Uses settle_fn injection to bypass payouts; the assertion here is the wiring
    + the immutability invariant, not the payout math (covered above)."""
    rid = "jra-20260620-09-11"
    _populate_card(
        lake, rid,
        runners=[{"horse_id": "AAA", "horse_number": 1, "gate": 1}],
        predictor_scores={"AAA": 1.0},
    )
    model_card_before = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))

    # Inject a fake settle_fn (returns losses) and a fake push_fn so no CF_* needed.
    monkeypatch.setattr(
        "keibamon_core.weekend.pipeline.settle_card",
        lambda lk, rids, **kw: settle_card(
            lk, rids,
            results={("jra-20260620-09-11", 1): (1, 4.0)},
            settle_fn=lambda _lk, bets: [],
        ),
    )

    summary = pipeline.settle(
        lake, [rid],
        role_file=_device_role_file(tmp_path),
        push_fn=lambda snapshot, **kw: {"result": {"meta": {"changes": 1}}},
    )
    assert summary["races"] == 1
    assert summary["model_card_settled_rows"] == 1
    assert summary["clean"] is not None
    assert summary["d1"]["status"] == "ok"

    # model_card untouched across the whole pipeline.
    model_card_after = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    assert model_card_after == model_card_before

    # model_card_settled was actually written.
    settled = read_parquet_if_exists(lake.silver_table(MODEL_CARD_SETTLED_TABLE))
    assert len(settled) == 1


def test_pipeline_settle_refuses_on_wrong_device(lake: LakePaths, tmp_path: Path):
    """Device guard runs BEFORE any settle work."""
    role_file = tmp_path / ".device"
    role_file.write_text("role = capture-pc\n")
    with pytest.raises(pipeline.WrongDeviceError, match="must run on"):
        pipeline.settle(lake, ["jra-20260620-09-11"], role_file=role_file)


def test_pipeline_settle_skips_d1_when_creds_missing(lake: LakePaths, tmp_path: Path, monkeypatch):
    """Missing CF_* creds -> skipped status, lake writes already landed."""
    rid = "jra-20260620-09-11"
    _populate_card(
        lake, rid,
        runners=[{"horse_id": "AAA", "horse_number": 1, "gate": 1}],
        predictor_scores={"AAA": 1.0},
    )
    monkeypatch.setattr(
        "keibamon_core.weekend.pipeline.settle_card",
        lambda lk, rids, **kw: settle_card(
            lk, rids,
            results={("jra-20260620-09-11", 1): (1, 4.0)},
            settle_fn=lambda _lk, bets: [],
        ),
    )
    for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)

    summary = pipeline.settle(lake, [rid], role_file=_device_role_file(tmp_path))
    assert summary["d1"]["status"] == "skipped"
    assert "CF_ACCOUNT_ID" in summary["d1"]["reason"]
    # Lake write still landed.
    assert read_parquet_if_exists(lake.silver_table(MODEL_CARD_SETTLED_TABLE))
