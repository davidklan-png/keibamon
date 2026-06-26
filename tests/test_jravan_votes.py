"""Tests for H1 票数 (per-pool yen vote counts) -> silver/jravan_votes.

Fixture is a REAL bronze H1 record for a 2023 Sapporo race (16 starters, all 7
pools populated: win=16, place=16, bracket_quinella=36, quinella=wide=120,
exacta=240, trio=560) plus one synthesized data_kubun='0' delete variant,
captured from the 2026-06-26 master pull. The byte-offset maths only checks out
against genuine Shift-JIS data (H1 records are 28953 data bytes each), so a
real record exercises the same parser path the production build runs.
"""
from __future__ import annotations

import gzip
import json as _json
from pathlib import Path

import pytest

from keibamon_core.adapters.jravan import JravanSourceAdapter, _votes_x100

FIXTURE_RAW = Path(__file__).parent / "fixtures" / "jravan"


def _fixture_rows(subdir: str):
    for gz in sorted((FIXTURE_RAW / subdir).glob("*.ndjson.gz")):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    yield _json.loads(line)


def _write_bronze(tmp_path, fixtures: dict[str, str]):
    """Write fixture subdirs into a tmp lake's bronze using spec-prefixed
    filenames so the adapter's spec-glob finds them."""
    from keibamon_core.paths import LakePaths

    lake = LakePaths(root=tmp_path / "data")
    snap = lake.bronze_source_dir("jravan") / "20260101T000000"
    snap.mkdir(parents=True)
    for spec, subdir in fixtures.items():
        rows = list(_fixture_rows(subdir))
        with gzip.open(snap / f"{spec}.fixture.0001.ndjson.gz", "wt", encoding="utf-8") as fh:
            for r in rows:
                fh.write(_json.dumps(r, ensure_ascii=False) + "\n")
    return lake


# --------------------------------------------------------------------------- #
# _votes_x100 converter
# --------------------------------------------------------------------------- #
def test_votes_x100_converter() -> None:
    """11-digit 票数 (単位百円) -> yen. Sentinel 0 / blank -> None."""
    assert _votes_x100("00123456789") == 12_345_678_900   # 123456789 tickets × ¥100
    # '00000000000' = 発売前取消し / cancelled before sale -> None (no liquidity)
    assert _votes_x100("00000000000") is None
    # whitespace = 発売なし / pool not registered -> None
    assert _votes_x100("           ") is None
    assert _votes_x100("") is None
    # non-digit garbage -> None (defensive)
    assert _votes_x100("abc") is None


# --------------------------------------------------------------------------- #
# parse_grouped_record on a real H1
# --------------------------------------------------------------------------- #
def test_parse_h1_record() -> None:
    real = next(r for r in _fixture_rows("votes")
                if r["raw"].encode("cp932")[2:3] != b"0")  # the non-delete record
    rec = JravanSourceAdapter.parse_grouped_record(real)
    assert rec is not None
    assert rec["record_spec"] == "H1"
    pools = {e["pool"] for e in rec["entries"]}
    # Real 16-starter race carries all 7 pools; at minimum win + place.
    assert {"win", "place"} <= pools
    assert len(pools) >= 3
    # Every win entry has a real yen vote count (> 0).
    wins = [e for e in rec["entries"] if e["pool"] == "win"]
    assert wins and all(e["vote_yen"] and e["vote_yen"] > 0 for e in wins)
    # The favorite (popularity=1) is present among the win entries.
    assert any(e["popularity"] == 1 for e in wins)


# --------------------------------------------------------------------------- #
# build_jravan_votes end-to-end
# --------------------------------------------------------------------------- #
def test_build_votes(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_votes
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"RACE": "votes"})
    counts = build_jravan_votes(lake)
    # The real 16-starter race yields 1108 entries (win 16 + place 16 + BQ 36 +
    # quinella 120 + wide 120 + exacta 240 + trio 560); the dk=0 delete is dropped.
    assert counts["jravan_votes"] == 1108

    rows = read_dataset(lake.silver_dataset("jravan_votes"))
    assert {"win", "place"} <= {r["pool"] for r in rows}
    assert all(r["vote_yen"] and r["vote_yen"] > 0 for r in rows)
    assert all(r["race_id"].startswith("jra-") for r in rows)
    # partition columns
    assert all(r["year"] == 2023 and r["venue"] == "01" for r in rows)
    # PIT sanity: available_at is EVENT-time (the 2023 race date), NOT the 2026
    # bulk-download time (H1.make_date_drift DATA_TRAP).
    assert all(r["available_at"].year == 2023 for r in rows)


def test_votes_drops_data_kubun_zero(tmp_path) -> None:
    """The synthesized data_kubun='0' delete record must not reach silver."""
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_votes
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"RACE": "votes"})
    # The fixture carries 1 real (dk=5) + 1 delete (dk=0). If the delete leaked,
    # it would double the entry count (each has 1108 entries -> 2216).
    counts = build_jravan_votes(lake)
    assert counts["jravan_votes"] == 1108  # not 2216
    rows = read_dataset(lake.silver_dataset("jravan_votes"))
    # Every row traces back to the dk=5 record's content hash, never the delete's.
    content_hashes = {r["content_hash"] for r in rows}
    assert len(content_hashes) == 1


def test_votes_dedup_latest_wins(tmp_path) -> None:
    """Two H1 records for the same (race, pool, combo) collapse to one silver
    row; the latest snapshot's provenance wins (dict-overwrite semantics)."""
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_votes
    from keibamon_core.lake import read_dataset
    from keibamon_core.paths import LakePaths

    real = next(r for r in _fixture_rows("votes")
                if r["raw"].encode("cp932")[2:3] != b"0")
    lake = LakePaths(root=tmp_path / "data")
    # Two snapshots each carrying the same race (distinct make_date so the rows
    # are observably different; source_record_id marks which snapshot won).
    for i, snap_name in enumerate(("20260101T000000", "20260102T000000")):
        snap = lake.bronze_source_dir("jravan") / snap_name
        snap.mkdir(parents=True)
        dup = _json.loads(_json.dumps(real))
        raw_bytes = bytearray(dup["raw"].encode("cp932"))
        raw_bytes[3:11] = b"2026010" + str(i + 1).encode()  # 8-byte make_date
        dup["raw"] = raw_bytes.decode("cp932")
        dup["source_record_id"] = f"H1:snap{i}"
        with gzip.open(snap / "RACE.fixture.0001.ndjson.gz", "wt", encoding="utf-8") as fh:
            fh.write(_json.dumps(dup, ensure_ascii=False) + "\n")

    counts = build_jravan_votes(lake)
    rows = read_dataset(lake.silver_dataset("jravan_votes"))
    # Dedup collapses the two records to one set of 1108 rows -- NOT 2216.
    assert counts["jravan_votes"] == 1108
    # Latest-wins: every row carries the second snapshot's provenance marker.
    assert all(r["source_record_id"] == "H1:snap1" for r in rows)
