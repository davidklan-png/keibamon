"""Tests for JG 競走馬除外情報 (pre-race declarations + exclusions) ->
silver/jravan_declarations.

Fixture is 8 REAL bronze JG records (one per (shutan_kubun, jogai_jotai_kubun)
combo covering all 6 shutan values {1,2,4,5,6,9} and all 3 jogai values
{0,1,2}) + 1 synthesized ketto_num='0000000000' placeholder + 1 synthesized
data_kubun='0' delete, captured from the 2026-06-26 master pull. JG records are
78 data bytes and arrive as clean cp932 (name "ヤプシ" decodes correctly).
"""
from __future__ import annotations

import gzip
import json as _json
from pathlib import Path

import pytest

from keibamon_core.adapters.jravan import JravanSourceAdapter

FIXTURE_RAW = Path(__file__).parent / "fixtures" / "jravan"


def _fixture_rows(subdir: str):
    for gz in sorted((FIXTURE_RAW / subdir).glob("*.ndjson.gz")):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    yield _json.loads(line)


def _write_bronze(tmp_path, fixtures: dict[str, str]):
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
# parse_record on a real JG
# --------------------------------------------------------------------------- #
def test_parse_jg_record() -> None:
    real = next(r for r in _fixture_rows("declarations")
                if r["raw"].encode("cp932")[2:3] != b"0"   # not the delete
                and r["raw"].encode("cp932")[27:37] != b"0000000000")  # not placeholder
    p = JravanSourceAdapter.parse_record(real)
    assert p is not None
    assert p["record_spec"] == "JG"
    assert p["ketto_num"].isdigit() and len(p["ketto_num"]) == 10
    assert p["bamei"] and p["bamei"].strip()  # clean cp932 name decodes
    assert p["vote_accept_order"] is not None  # 001/002/003
    assert p["shutan_kubun"] in ("1", "2", "4", "5", "6", "9")
    assert p["jogai_jotai_kubun"] in ("0", "1", "2")
    assert p["_meta"]["content_hash"]  # provenance carried through


# --------------------------------------------------------------------------- #
# build_jravan_declarations end-to-end
# --------------------------------------------------------------------------- #
def test_build_declarations(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_declarations
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"RACE": "declarations"})
    counts = build_jravan_declarations(lake)
    # Fixture: 8 real (dk=1) + 1 placeholder (dk=1) survive; 1 delete (dk=0) dropped.
    assert counts["jravan_declarations"] == 9

    rows = read_dataset(lake.silver_dataset("jravan_declarations"))
    # All 6 shutan_kubun values appear across the rows.
    assert {r["shutan_kubun"] for r in rows} == {"1", "2", "4", "5", "6", "9"}
    # is_excluded is True iff shutan in {2,5,6,9} OR jogai in {1,2}.
    for r in rows:
        shutan, jogai = r["shutan_kubun"], r["jogai_jotai_kubun"]
        expected = shutan in {"2", "5", "6", "9"} or jogai in {"1", "2"}
        assert r["is_excluded"] is expected
    # exclusion_kind matches the label map; prefers shutan, falls back to jogai.
    by_shutan = {r["shutan_kubun"]: r for r in rows if r["shutan_kubun"] in {"2", "5", "6", "9"}}
    assert by_shutan["2"]["exclusion_kind"] == "excluded_close"
    assert by_shutan["5"]["exclusion_kind"] == "revote_excluded"
    assert by_shutan["6"]["exclusion_kind"] == "withdrawn_no_num"
    assert by_shutan["9"]["exclusion_kind"] == "withdrawn"
    # Non-excluded rows have null exclusion_kind.
    assert all(r["exclusion_kind"] is None for r in rows if not r["is_excluded"])
    # partition columns
    assert all(isinstance(r["year"], int) and r["venue"] for r in rows)
    # PIT sanity: available_at is event-time, not the 2026 bulk-download stamp.
    assert all(r["available_at"].year >= 2020 for r in rows)


def test_jg_placeholder_preserved(tmp_path) -> None:
    """The synthesized ketto_num='0000000000' placeholder row lands in silver
    (NOT filtered) so downstream joins can still see the scratch via
    (race_id, horse_id) -- JG.ketto_num=0000000000 DATA_TRAP."""
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_declarations
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"RACE": "declarations"})
    build_jravan_declarations(lake)
    rows = read_dataset(lake.silver_dataset("jravan_declarations"))
    placeholders = [r for r in rows if r["horse_id"] == "0000000000"]
    assert len(placeholders) == 1
    assert placeholders[0]["ketto_num"] == "0000000000"


def test_jg_drops_data_kubun_zero(tmp_path) -> None:
    """The synthesized data_kubun='0' delete record must not reach silver."""
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_declarations
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"RACE": "declarations"})
    build_jravan_declarations(lake)
    rows = read_dataset(lake.silver_dataset("jravan_declarations"))
    # 8 real + 1 placeholder survive (9); the delete would make 10 if it leaked.
    assert len(rows) == 9
    # The delete was a copy of the shutan='9' record; verify exactly one
    # shutan='9' row survives (not two).
    assert sum(1 for r in rows if r["shutan_kubun"] == "9") == 1
