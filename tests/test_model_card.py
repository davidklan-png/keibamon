"""Tests for the immutable pre-market model card (weekend/model_card.py) and the
device-guarded ``post`` stage (weekend/pipeline.py).

Fixture pattern: each freeze is given race-scoped feature/entry rows directly
via the optional kwargs, so the tests are deterministic and do not need to
stand up a market_baseline gold dataset. The lake itself is a tmp_path
``LakePaths`` so the append-only model_card parquet round-trips through real IO
-- the immutability guarantee is checked against actual re-read bytes, not an
in-memory list.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

from keibamon_core.lake import read_parquet_if_exists
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline
from keibamon_core.weekend.model_card import (
    MODEL_CARD_TABLE,
    freeze_model_card,
    posted_before_market,
)


# --- fixtures ----------------------------------------------------------------


class _FixturePredictor:
    """Deterministic Predictor for tests.

    Holds a ``{horse_id: score}`` map and returns the score per row's own
    horse_id. Used both for the well-behaved case (distinct horse_ids) and the
    DATA_TRAPS case (two runners share horse_id='0000000000').
    """

    name = "fixture_predictor"

    def __init__(self, scores: dict[str, float]):
        self._scores = scores

    def score_race(self, race: dict[str, Any], feature_rows: list[dict[str, Any]]) -> dict[str, float]:
        return {row["horse_id"]: self._scores.get(row["horse_id"], 0.0) for row in feature_rows}


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    return LakePaths(root=tmp_path)


def _feature_rows(race_id: str, runners: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One feature row per runner. Defaults the Model 0 column the devigged
    baseline predictor would consume; tests that don't depend on the predictor
    reading it can ignore it."""
    out = []
    for r in runners:
        out.append({
            "race_id": race_id,
            "horse_id": r["horse_id"],
            "horse_number": r["horse_number"],
            "devigged_market_prob": r.get("devigged_market_prob"),
            "win_odds": r.get("win_odds"),
        })
    return out


def _entries(race_id: str, runners: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"race_id": race_id, "horse_id": r["horse_id"],
         "horse_number": r["horse_number"], "gate": r["gate"]}
        for r in runners
    ]


# --- model_p + fair odds -----------------------------------------------------


def test_model_p_sums_to_one_and_fair_odds_inverts(lake: LakePaths):
    rid = "jra-20260620-09-11"
    runners = [
        {"horse_id": "2018101234", "horse_number": 1, "gate": 1},
        {"horse_id": "2019105678", "horse_number": 2, "gate": 2},
        {"horse_id": "2020109012", "horse_number": 3, "gate": 3},
    ]
    scores = {"2018101234": 0.5, "2019105678": 0.3, "2020109012": 0.2}  # already sums to 1.0
    predictor = _FixturePredictor(scores)

    rows = freeze_model_card(
        lake, rid, predictor=predictor,
        feature_rows=_feature_rows(rid, runners),
        entries=_entries(rid, runners),
        first_market_available_at=None,
        posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
    )

    assert len(rows) == 3
    total = sum(r["model_p"] for r in rows)
    assert abs(total - 1.0) < 1e-9, f"model_p must sum to 1.0, got {total}"
    for r in rows:
        assert r["model_fair_odds"] == pytest.approx(1.0 / r["model_p"])
        assert r["predictor_name"] == "fixture_predictor"
        assert r["card_version"] == 1


def test_model_p_normalizes_when_scores_do_not_sum_to_one(lake: LakePaths):
    """A fundamental predictor may emit raw ratings (not probabilities). The
    within-race normalization must still produce a distribution."""
    rid = "jra-20260620-09-11"
    runners = [
        {"horse_id": "A", "horse_number": 1, "gate": 1},
        {"horse_id": "B", "horse_number": 2, "gate": 2},
    ]
    predictor = _FixturePredictor({"A": 12.0, "B": 6.0})  # raw ratings, not probs

    rows = freeze_model_card(
        lake, rid, predictor=predictor,
        feature_rows=_feature_rows(rid, runners),
        entries=_entries(rid, runners),
        first_market_available_at=None,
        posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
    )
    by_hn = {r["horse_number"]: r for r in rows}
    assert by_hn[1]["model_p"] == pytest.approx(2.0 / 3.0)
    assert by_hn[2]["model_p"] == pytest.approx(1.0 / 3.0)
    assert by_hn[1]["model_fair_odds"] == pytest.approx(1.5)


# --- posted_before_market flag -----------------------------------------------


def test_posted_before_market_helper_true_when_no_market():
    assert posted_before_market(datetime(2026, 6, 20, tzinfo=timezone.utc), None) is True


def test_posted_before_market_helper_true_before_first_snapshot():
    posted = datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc)
    first = datetime(2026, 6, 20, 2, 0, tzinfo=timezone.utc)
    assert posted_before_market(posted, first) is True


def test_posted_before_market_helper_false_at_or_after_first_snapshot():
    posted = datetime(2026, 6, 20, 3, 0, tzinfo=timezone.utc)
    first = datetime(2026, 6, 20, 2, 0, tzinfo=timezone.utc)
    assert posted_before_market(posted, first) is False


def test_freeze_stamps_posted_before_market_in_both_directions(lake: LakePaths):
    rid = "jra-20260620-09-11"
    runners = [{"horse_id": "A", "horse_number": 1, "gate": 1}]
    predictor = _FixturePredictor({"A": 1.0})
    first_market = datetime(2026, 6, 20, 2, 0, tzinfo=timezone.utc)

    pre = freeze_model_card(
        lake, rid, predictor=predictor,
        feature_rows=_feature_rows(rid, runners),
        entries=_entries(rid, runners),
        first_market_available_at=first_market,
        posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
    )
    assert pre[0]["posted_before_market"] is True
    assert pre[0]["first_market_available_at"] == first_market.isoformat()

    # Different race so we don't bump card_version on the assertion path.
    rid2 = "jra-20260620-05-01"
    post = freeze_model_card(
        lake, rid2, predictor=predictor,
        feature_rows=_feature_rows(rid2, runners),
        entries=_entries(rid2, runners),
        first_market_available_at=first_market,
        posted_at=datetime(2026, 6, 20, 3, 0, tzinfo=timezone.utc),
    )
    assert post[0]["posted_before_market"] is False

    # No market snapshot at all -> trivially pre-market.
    rid3 = "jra-20260620-05-02"
    nomarket = freeze_model_card(
        lake, rid3, predictor=predictor,
        feature_rows=_feature_rows(rid3, runners),
        entries=_entries(rid3, runners),
        first_market_available_at=None,
        posted_at=datetime(2026, 6, 20, 9, 0, tzinfo=timezone.utc),
    )
    assert nomarket[0]["posted_before_market"] is True
    assert nomarket[0]["first_market_available_at"] is None


# --- D2 immutability ---------------------------------------------------------


def test_immutability_re_post_bumps_version_and_preserves_v1_bytes(lake: LakePaths):
    rid = "jra-20260620-09-11"
    runners = [
        {"horse_id": "A", "horse_number": 1, "gate": 1},
        {"horse_id": "B", "horse_number": 2, "gate": 2},
    ]
    predictor = _FixturePredictor({"A": 0.6, "B": 0.4})

    common = dict(
        predictor=predictor,
        feature_rows=_feature_rows(rid, runners),
        entries=_entries(rid, runners),
        first_market_available_at=None,
        posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
    )

    v1 = freeze_model_card(lake, rid, **common)
    assert {r["card_version"] for r in v1} == {1}

    # Snapshot the v1 rows exactly as they sit on disk right now.
    v1_on_disk_before = [
        dict(r) for r in read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
        if r["race_id"] == rid and r["card_version"] == 1
    ]
    assert len(v1_on_disk_before) == 2

    v2 = freeze_model_card(lake, rid, **common)
    assert {r["card_version"] for r in v2} == {2}

    # Re-read; v1 rows must be byte-identical to the snapshot taken before v2.
    all_rows = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    v1_on_disk_after = [
        dict(r) for r in all_rows
        if r["race_id"] == rid and r["card_version"] == 1
    ]
    assert len(v1_on_disk_after) == 2
    assert v1_on_disk_after == v1_on_disk_before, (
        "D2 violation: re-posting mutated a v1 row"
    )

    # And the table now holds both versions, distinct, with the new version on top.
    versions = sorted({r["card_version"] for r in all_rows if r["race_id"] == rid})
    assert versions == [1, 2]


# --- DATA_TRAPS: horse_id='0000000000' must not cross-map --------------------


def test_two_runners_sharing_placeholder_horse_id_do_not_cross_map(lake: LakePaths):
    """DATA_TRAPS: horse_id='0000000000' is non-unique. Two runners share it but
    have distinct (horse_number, gate). The model_card must carry one row per
    horse_number with each row's OWN gate -- never the wrong runner's gate."""
    rid = "jra-20260620-09-11"
    # Two runners, both carrying the placeholder horse_id, with swapped
    # horse_number/gate pairs so a horse_id-keyed lookup would cross-map them.
    runners = [
        {"horse_id": "0000000000", "horse_number": 1, "gate": 1},
        {"horse_id": "0000000000", "horse_number": 2, "gate": 2},
    ]
    # Predictor returns one score per horse_id; both runners see the same score
    # (that's the predictor's known limitation -- not the mapping bug we test).
    predictor = _FixturePredictor({"0000000000": 0.5})

    rows = freeze_model_card(
        lake, rid, predictor=predictor,
        feature_rows=_feature_rows(rid, runners),
        entries=_entries(rid, runners),
        first_market_available_at=None,
        posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
    )

    by_hn = {int(r["horse_number"]): r for r in rows}
    assert set(by_hn) == {1, 2}, "model_card must carry one row per horse_number"

    # Each horse_number pairs with its OWN gate -- no cross-map.
    assert by_hn[1]["gate"] == 1, "horse_number 1 must keep gate 1, not 2"
    assert by_hn[2]["gate"] == 2, "horse_number 2 must keep gate 2, not 1"


def test_distinct_horse_ids_keep_distinct_scores(lake: LakePaths):
    """Counterpart to the placeholder case: when horse_ids are distinct, each
    runner's model_p reflects its OWN score -- the predictor CAN distinguish
    them, and the model_card carries that distinction."""
    rid = "jra-20260620-09-11"
    runners = [
        {"horse_id": "AAA", "horse_number": 1, "gate": 1},
        {"horse_id": "BBB", "horse_number": 2, "gate": 2},
    ]
    predictor = _FixturePredictor({"AAA": 0.75, "BBB": 0.25})

    rows = freeze_model_card(
        lake, rid, predictor=predictor,
        feature_rows=_feature_rows(rid, runners),
        entries=_entries(rid, runners),
        first_market_available_at=None,
        posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
    )
    by_hn = {int(r["horse_number"]): r for r in rows}
    assert by_hn[1]["model_p"] == pytest.approx(0.75)
    assert by_hn[2]["model_p"] == pytest.approx(0.25)


# --- error path: empty feature rows -----------------------------------------


def test_freeze_raises_when_no_feature_rows(lake: LakePaths):
    with pytest.raises(ValueError, match="no feature rows"):
        freeze_model_card(
            lake, "jra-20260620-09-11",
            predictor=_FixturePredictor({}),
            feature_rows=[],
            entries=[],
            first_market_available_at=None,
        )


# --- pipeline.post: lake-first, D1-after ------------------------------------


def _device_role_file(tmp_path: Path, role: str = "mac-dev") -> Path:
    role_file = tmp_path / ".device"
    role_file.write_text(f"role = {role}\n")
    return role_file


def test_post_writes_lake_first_then_pushes_to_d1(lake: LakePaths, tmp_path: Path, monkeypatch):
    """ADR-0003 D4: lake write lands before any network call. The push_fn must
    observe rows already on disk."""
    rid = "jra-20260620-09-11"
    runners = [
        {"horse_id": "A", "horse_number": 1, "gate": 1},
        {"horse_id": "B", "horse_number": 2, "gate": 2},
    ]
    predictor = _FixturePredictor({"A": 0.6, "B": 0.4})

    # Inject feature/entry data via a small one-shot freeze override. Because
    # pipeline.post calls freeze_model_card directly (no kwargs to pass
    # feature_rows through), we monkeypatch freeze_model_card in the pipeline
    # namespace with a wrapper that supplies them.
    real_freeze = pipeline.freeze_model_card

    def _patched_freeze(lk, race_id, *, predictor, **kw):
        return real_freeze(
            lk, race_id, predictor=predictor,
            feature_rows=_feature_rows(race_id, runners),
            entries=_entries(race_id, runners),
            first_market_available_at=None,
            posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
        )

    monkeypatch.setattr(pipeline, "freeze_model_card", _patched_freeze)

    push_calls: list[dict] = []

    def _push_fn(snapshot, *, key="model_cards", **kw):
        # Verify the lake row already landed BEFORE the push ran.
        on_disk = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
        push_calls.append({"key": key, "rows_on_disk_before_push": len(on_disk), "snapshot": snapshot})
        return {"result": {"meta": {"changes": 1}}}

    result = pipeline.post(
        lake, [rid], predictor=predictor,
        role_file=_device_role_file(tmp_path),
        push_fn=_push_fn,
    )

    assert result["races_posted"] == 1
    assert result["rows_written"] == 2
    assert result["d1"]["status"] == "ok"
    assert len(push_calls) == 1
    assert push_calls[0]["rows_on_disk_before_push"] == 2  # lake-first verified


def test_post_skips_d1_when_creds_missing_but_keeps_lake_write(lake: LakePaths, tmp_path: Path, monkeypatch):
    """CLAUDE.md: CF_* creds don't persist across Mac shells. Missing creds must
    not raise and must not lose the lake write."""
    rid = "jra-20260620-09-11"
    runners = [{"horse_id": "A", "horse_number": 1, "gate": 1}]
    predictor = _FixturePredictor({"A": 1.0})

    real_freeze = pipeline.freeze_model_card
    monkeypatch.setattr(
        pipeline, "freeze_model_card",
        lambda lk, race_id, *, predictor, **kw: real_freeze(
            lk, race_id, predictor=predictor,
            feature_rows=_feature_rows(race_id, runners),
            entries=_entries(race_id, runners),
            first_market_available_at=None,
            posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
        ),
    )
    for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"):
        monkeypatch.delenv(k, raising=False)

    result = pipeline.post(
        lake, [rid], predictor=predictor,
        role_file=_device_role_file(tmp_path),
    )
    assert result["rows_written"] == 1
    assert result["d1"]["status"] == "skipped"
    assert "CF_ACCOUNT_ID" in result["d1"]["reason"]

    # Lake write still landed.
    on_disk = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    assert len(on_disk) == 1


def test_post_d1_failure_does_not_lose_lake_write(lake: LakePaths, tmp_path: Path, monkeypatch):
    """If the push raises, the lake write that already landed must survive."""
    rid = "jra-20260620-09-11"
    runners = [{"horse_id": "A", "horse_number": 1, "gate": 1}]
    predictor = _FixturePredictor({"A": 1.0})

    real_freeze = pipeline.freeze_model_card
    monkeypatch.setattr(
        pipeline, "freeze_model_card",
        lambda lk, race_id, *, predictor, **kw: real_freeze(
            lk, race_id, predictor=predictor,
            feature_rows=_feature_rows(race_id, runners),
            entries=_entries(race_id, runners),
            first_market_available_at=None,
            posted_at=datetime(2026, 6, 20, 1, 0, tzinfo=timezone.utc),
        ),
    )
    monkeypatch.setenv("CF_ACCOUNT_ID", "x")
    monkeypatch.setenv("CF_D1_DATABASE_ID", "y")
    monkeypatch.setenv("CF_API_TOKEN", "z")

    def _raising_push(snapshot, **kw):
        raise RuntimeError("D1 exploded")

    result = pipeline.post(
        lake, [rid], predictor=predictor,
        role_file=_device_role_file(tmp_path),
        push_fn=_raising_push,
    )
    assert result["rows_written"] == 1
    assert result["d1"]["status"] == "failed"
    assert "D1 exploded" in result["d1"]["error"]

    # The lake write survived the D1 failure.
    on_disk = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    assert len(on_disk) == 1


def test_post_refuses_on_wrong_device(lake: LakePaths, tmp_path: Path):
    """The device guard runs BEFORE any lake work. A non-mac-dev role raises."""
    role_file = tmp_path / ".device"
    role_file.write_text("role = capture-pc\n")
    with pytest.raises(pipeline.WrongDeviceError, match="must run on"):
        pipeline.post(
            lake, ["jra-20260620-09-11"],
            predictor=_FixturePredictor({}),
            role_file=role_file,
        )
