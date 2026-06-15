"""Tests for HC (坂路/slope) + WC (ウッドチップ/woodchip) training-time parsing.

Fixtures are REAL bronze records from the 20260613 snapshot — exact byte sequences
that exercise every timing field, the all-zero (not-measured) sentinel, and the
horse_id='0000000000' placeholder trap.
"""
from __future__ import annotations

import pytest

from keibamon_core.adapters.jravan import (
    RECORD_LENGTHS,
    RECORD_LAYOUTS,
    JravanSourceAdapter,
    parse_fixed,
)

# --- Real bronze records (content bytes, CRLF excluded) ---------------------
HC_NONZERO = "HC12023080802003010206551999100288000000004941580336170166"  # 58 bytes
HC_ALLZERO = "HC12023080802003010206551997102363000000000000000000000000"  # 58 bytes, old/empty
HC_DELETE = "HC02023080802003010206551999100288000000004941580336170166"  # data_kubun=0
HC_PLACEHOLDER = "HC12023080802003010206550000000000000000000000000000000000"  # horse_id=0000000000
HC_RITTO = "HC12023080812021072705302000106328000000004771570320160160"  # center=1 (Ritto)
WC_NONZERO = "WC12023080802021072705042015103384300000000000000000000000000000000000000000000066318304801620318158160"
# WC sample 2 with center byte (position 11) flipped 0→1 for Ritto partition test
WC_RITTO = "WC12023080812021072705042018103284300000000000000000000000000000000000000000000064718004671620305157148"


def _bronze_row(raw: str, record_id: str, spec: str, idx: int = 0) -> dict:
    """Wrap a raw record string in the bronze NDJSON envelope."""
    return {
        "source_name": "jravan",
        "source_record_id": f"{record_id}:{idx:016x}",
        "raw_uri": f"{record_id}VM.fixture.jvd",
        "content_hash": f"{idx:064x}",
        "ingested_at": "2026-06-12T23:32:35.602344Z",
        "published_time": "20260613102933",
        "available_at": "20260613102933",  # bulk download time — must NOT be used for PIT
        "record_id": record_id,
        "spec": spec,
        "raw": raw + "\r\n",
    }


def _write_training_bronze(tmp_path, hc_records: list[str], wc_records: list[str]):
    """Write HC/WC records into a tmp lake as SLOP/WOOD bronze snapshots."""
    import gzip
    import json as _json

    from keibamon_core.paths import LakePaths

    lake = LakePaths(root=tmp_path / "data")
    snap = lake.bronze_source_dir("jravan") / "20260101T000000"
    snap.mkdir(parents=True)

    if hc_records:
        with gzip.open(snap / "SLOP.fixture.0001.ndjson.gz", "wt", encoding="utf-8") as fh:
            for i, raw in enumerate(hc_records):
                fh.write(_json.dumps(_bronze_row(raw, "HC", "SLOP", i)) + "\n")
    if wc_records:
        with gzip.open(snap / "WOOD.fixture.0001.ndjson.gz", "wt", encoding="utf-8") as fh:
            for i, raw in enumerate(wc_records):
                fh.write(_json.dumps(_bronze_row(raw, "WC", "WOOD", i)) + "\n")
    return lake


# --------------------------------------------------------------------------- #
# Parser tests
# --------------------------------------------------------------------------- #
def test_hc_record_length_matches_spec() -> None:
    assert len(HC_NONZERO.encode("cp932")) == RECORD_LENGTHS["HC"]


def test_wc_record_length_matches_spec() -> None:
    assert len(WC_NONZERO.encode("cp932")) == RECORD_LENGTHS["WC"]


def test_hc_parses_timing_fields() -> None:
    p = parse_fixed(HC_NONZERO, RECORD_LAYOUTS["HC"], expected_len=RECORD_LENGTHS["HC"])
    assert p["record_spec"] == "HC"
    assert p["horse_id"] == "1999100288"
    assert p["center"] == "0"  # 美浦 Miho
    assert p["train_date"] == "2003-01-02"
    assert p["train_time"] == "0655"
    # Timing fields (tenths of a second → ÷10)
    assert p["f3_total"] == 49.4
    assert p["lap_600_400"] == 15.8
    assert p["f2_total"] == 33.6
    assert p["lap_400_200"] == 17.0
    assert p["last_1f"] == 16.6  # the money field
    # f4_total was 0000 → not measured → None
    assert p["f4_total"] is None
    assert p["lap_800_600"] is None


def test_hc_allzero_times_are_null() -> None:
    """All-zero old record: every timing field must be None, not 0.0."""
    p = parse_fixed(HC_ALLZERO, RECORD_LAYOUTS["HC"], expected_len=RECORD_LENGTHS["HC"])
    assert p["horse_id"] == "1997102363"
    for f in ("f4_total", "lap_800_600", "f3_total", "lap_600_400",
              "f2_total", "lap_400_200", "last_1f"):
        assert p[f] is None, f"{f} should be None for all-zero record"


def test_wc_parses_timing_fields() -> None:
    p = parse_fixed(WC_NONZERO, RECORD_LAYOUTS["WC"], expected_len=RECORD_LENGTHS["WC"])
    assert p["record_spec"] == "WC"
    assert p["horse_id"] == "2015103384"
    assert p["center"] == "0"  # Miho
    assert p["train_date"] == "2021-07-27"  # woodchip launch date
    assert p["train_time"] == "0504"
    assert p["course_code"] == 3
    # Upper distances are 0000 (not run) → None
    for f in ("f10_total", "f9_total", "f8_total", "f7_total", "f6_total", "f5_total"):
        assert p[f] is None
    # Lower distances have values
    assert p["f4_total"] == 66.3
    assert p["f4_lap"] == 18.3
    assert p["f3_total"] == 48.0
    assert p["last_1f"] == 16.0


def test_wc_lap_math_is_consistent() -> None:
    """Cumulative totals must differ by the lap between adjacent furlongs."""
    p = parse_fixed(WC_NONZERO, RECORD_LAYOUTS["WC"], expected_len=RECORD_LENGTHS["WC"])
    assert abs(p["f4_total"] - p["f3_total"] - p["f4_lap"]) < 0.01
    assert abs(p["f3_total"] - p["f2_total"] - p["f3_lap"]) < 0.01


# --------------------------------------------------------------------------- #
# Silver build tests
# --------------------------------------------------------------------------- #
def test_build_training_round_trips(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_training
    from keibamon_core.lake import read_dataset

    lake = _write_training_bronze(tmp_path, [HC_NONZERO, HC_RITTO], [WC_NONZERO])
    counts = build_jravan_training(lake)
    assert counts["jravan_training"] == 3
    rows = read_dataset(lake.silver_dataset("jravan_training"))

    hc = [r for r in rows if r["course_type"] == "slope"]
    wc = [r for r in rows if r["course_type"] == "woodchip"]
    assert len(hc) == 2
    assert len(wc) == 1

    # HC with non-zero times
    hc_nz = next(r for r in hc if r["horse_id"] == "1999100288")
    assert hc_nz["last_1f"] == 16.6
    assert hc_nz["f3_total"] == 49.4  # unified column name (was lap_600_400 for the lap)
    assert hc_nz["f3_lap"] == 15.8    # HC lap_600_400 → unified f3_lap
    assert hc_nz["center"] == "Miho"
    assert hc_nz["year"] == 2003

    # WC
    wc_row = wc[0]
    assert wc_row["last_1f"] == 16.0
    assert wc_row["f4_total"] == 66.3
    assert wc_row["course_code"] == 3
    assert wc_row["center"] == "Miho"
    assert wc_row["year"] == 2021


def test_training_available_at_is_event_time_not_download(tmp_path) -> None:
    """PIT trap guard: available_at must be train_date+train_time (JST→UTC),
    NEVER the bulk-download make_date (2023) or available_at (2026)."""
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_training
    from keibamon_core.lake import read_dataset

    lake = _write_training_bronze(tmp_path, [HC_NONZERO], [])
    build_jravan_training(lake)
    rows = read_dataset(lake.silver_dataset("jravan_training"))
    assert len(rows) == 1

    available = rows[0]["available_at"]
    # train_date=2003-01-02, train_time=0655 JST → 2003-01-01 21:55 UTC
    assert available.year == 2003
    assert available.month == 1
    assert available.day == 1  # JST 01/02 06:55 → UTC 01/01 21:55
    assert available.hour == 21
    assert available.minute == 55
    # Must NOT be the download time
    assert available.year != 2026


def test_training_filters_placeholder_and_delete(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_training
    from keibamon_core.lake import read_dataset

    lake = _write_training_bronze(
        tmp_path,
        [HC_NONZERO, HC_DELETE, HC_PLACEHOLDER],  # 1 valid + 1 delete + 1 placeholder
        [],
    )
    counts = build_jravan_training(lake)
    assert counts["jravan_training"] == 1  # only the valid HC survives
    rows = read_dataset(lake.silver_dataset("jravan_training"))
    assert rows[0]["horse_id"] == "1999100288"


def test_training_silver_is_idempotent(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_training
    from keibamon_core.lake import read_dataset

    lake = _write_training_bronze(tmp_path, [HC_NONZERO], [WC_NONZERO])
    c1 = build_jravan_training(lake)
    c2 = build_jravan_training(lake)
    assert c1 == c2  # re-running yields the same count (delete_matching idempotency)
    rows = read_dataset(lake.silver_dataset("jravan_training"))
    assert len(rows) == 2


def test_training_partitioned_by_year_and_center(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_training
    from keibamon_core.lake import read_dataset

    lake = _write_training_bronze(tmp_path, [HC_NONZERO, HC_RITTO], [WC_NONZERO])
    build_jravan_training(lake)
    base = lake.silver_dataset("jravan_training")
    # Standard hive layout: year=YYYY/venue=<center_code>/
    miho_dirs = list(base.glob("year=*/venue=0/*.parquet"))
    ritto_dirs = list(base.glob("year=*/venue=1/*.parquet"))
    assert miho_dirs, "Miho (venue=0) partition must exist"
    assert ritto_dirs, "Ritto (venue=1) partition must exist"
    # Verify the center data column is populated correctly
    rows = read_dataset(lake.silver_dataset("jravan_training"))
    centers = {r["center"] for r in rows}
    assert "Miho" in centers
    assert "Ritto" in centers
