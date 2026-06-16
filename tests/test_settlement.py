from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.ingestion.jravan_silver import build_jravan_payouts
from keibamon_core.ingestion.settlement import Bet, settle, settle_many
from keibamon_core.lake import read_dataset, write_dataset
from keibamon_core.paths import LakePaths

FIXTURE_RAW = Path(__file__).parent / "fixtures" / "jravan"


def test_settlement_reproduces_official_win_payout_fixture(tmp_path: Path) -> None:
    lake = _write_payout_fixture(tmp_path)
    build_jravan_payouts(lake)
    payouts = [
        row
        for row in read_dataset(lake.silver_dataset("jravan_payouts"))
        if row["pool"] == "win"
    ]
    assert payouts

    for payout in payouts:
        settled = settle(
            lake,
            Bet(
                race_id=payout["race_id"],
                pool="win",
                selection=payout["combo"],
                stake_yen=100,
            ),
        )
        assert settled.returned_yen == payout["payout_yen"]
        assert settled.official_payout_yen == payout["payout_yen"]


def test_settlement_refunds_scratched_single_runner(tmp_path: Path) -> None:
    lake = LakePaths(root=tmp_path / "data")
    write_dataset(
        [
            {
                "race_id": "jra-20260601-05-11",
                "horse_id": "h1",
                "horse_number": 1,
                "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "05",
            }
        ],
        lake.silver_dataset("jravan_race_entries"),
    )
    settled = settle(lake, Bet("jra-20260601-05-11", "win", "01", stake_yen=500))
    assert settled.reason == "refund"
    assert settled.returned_yen == 500


def test_settle_many_reuses_one_scan_for_a_batch(tmp_path: Path) -> None:
    """Many bets settle through one connection + one payouts scan, with each
    bet's payout scaled to its own stake. Dead-heat rows would collapse to the
    MAX payout (matches the per-bet ORDER BY payout_yen DESC LIMIT 1 behavior)."""
    lake = LakePaths(root=tmp_path / "data")
    race_ids = [f"jra-2026060{d:02d}-05-11" for d in (1, 2, 3)]
    payouts = []
    for rid, combo, yen in [
        (race_ids[0], "01", 200),
        (race_ids[1], "05", 1500),
        (race_ids[2], "12", 480),
    ]:
        payouts.append(
            {
                "race_id": rid,
                "pool": "win",
                "combo": combo,
                "payout_yen": yen,
                "popularity": 1,
                "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "05",
            }
        )
    write_dataset(payouts, lake.silver_dataset("jravan_payouts"))

    bets = [
        Bet(race_ids[0], "win", "01", stake_yen=100),
        Bet(race_ids[1], "win", "5", stake_yen=200),  # selection normalizes to "05"
        Bet(race_ids[2], "win", "12", stake_yen=50),
        Bet(race_ids[0], "win", "02", stake_yen=100),  # no payout row -> loss
    ]
    results = settle_many(lake, bets)
    assert [r.returned_yen for r in results] == [200, 3000, 240, 0]
    assert [r.reason for r in results] == [
        "official_payout",
        "official_payout",
        "official_payout",
        "loss",
    ]
    assert results[1].official_payout_yen == 1500


def test_settle_many_handles_placeholder_scratch_without_cross_match(
    tmp_path: Path,
) -> None:
    """Two placeholder-id horses in one race: a scratch on #5 must NOT be
    hidden by #6's result row when only horse_id is available. Requires
    horse_number on results (DATA_TRAPS['SE.ketto_num=0000000000'])."""
    lake = LakePaths(root=tmp_path / "data")
    race_id = "jra-20260601-05-11"
    write_dataset(
        [
            # Both placeholder horses, only #6 has a result row.
            {
                "race_id": race_id,
                "horse_id": "0000000000",
                "horse_number": 5,
                "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "05",
            },
            {
                "race_id": race_id,
                "horse_id": "0000000000",
                "horse_number": 6,
                "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "05",
            },
        ],
        lake.silver_dataset("jravan_race_entries"),
    )
    write_dataset(
        [
            {
                "race_id": race_id,
                "horse_id": "0000000000",
                "horse_number": 6,
                "finish_position": 1,
                "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "05",
            },
        ],
        lake.silver_dataset("jravan_race_results"),
    )
    bets = [
        Bet(race_id, "win", "05", stake_yen=100),  # entry without result -> refund
        Bet(race_id, "win", "06", stake_yen=100),  # entry with result -> loss (no payout)
    ]
    results = settle_many(lake, bets)
    assert results[0].reason == "refund"
    assert results[0].returned_yen == 100
    assert results[1].reason == "loss"
    assert results[1].returned_yen == 0


def _write_payout_fixture(tmp_path: Path) -> LakePaths:
    lake = LakePaths(root=tmp_path / "data")
    snap = lake.bronze_source_dir("jravan") / "20260101T000000"
    snap.mkdir(parents=True)
    with gzip.open(snap / "RACE.fixture.0001.ndjson.gz", "wt", encoding="utf-8") as out:
        for src in sorted((FIXTURE_RAW / "payout").glob("*.ndjson.gz")):
            with gzip.open(src, "rt", encoding="utf-8") as fh:
                for line in fh:
                    if line.strip():
                        out.write(json.dumps(json.loads(line), ensure_ascii=False) + "\n")
    return lake
