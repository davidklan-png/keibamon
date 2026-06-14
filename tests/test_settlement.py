from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.ingestion.jravan_silver import build_jravan_payouts
from keibamon_core.ingestion.settlement import Bet, settle
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
