"""Smoke tests for tools/jravan/named_pattern_of_life.py.

These tests exercise the constants and the markdown emitter's structure on a
synthetic pattern_of_life parquet. Running the full pipeline (PLUNGE_SQL over
83M rows of real bronze) is too heavy for unit tests; the SQL itself is
integration-tested by the artifact it produces and verified spot-wise in the
markdown (top graded-winner resolution + placeholder rule + exotic-odds gap).
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "named_pattern_of_life", ROOT / "tools" / "jravan" / "named_pattern_of_life.py"
)
# tools/ isn't a package; load by path so the test doesn't depend on import path.
pol_mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pol_mod)


def test_constants_match_anomaly_scan() -> None:
    """The thresholds are calibrated against the standalone anomaly scan;
    drift here would silently change the flag-rate baseline."""
    assert pol_mod.BASELINE_FLAG_RATE == pytest.approx(0.028)
    assert pol_mod.Z_FLAG_THRESHOLD == 1.5
    assert pol_mod.MIN_FLAGGED >= 5  # suppress small-sample noise
    assert pol_mod.MIN_RACES >= 30
    # Bands span the plausible odds range without gaps.
    edges = pol_mod.BAND_EDGES
    assert edges[0] == 0.0
    assert edges[-1] == float("inf")
    assert all(b > a for a, b in zip(edges, edges[1:]))


def test_placeholder_id_is_filtered_by_design() -> None:
    """The CONNECTION_SQL filters '00000' upstream so the placeholder never
    reaches the artifact. Guard the WHERE clause so a future refactor can't
    accidentally start minting named placeholder rows."""
    sql = pol_mod.CONNECTION_SQL
    assert "jockey_id <> '00000'" in sql
    assert "trainer_id <> '00000'" in sql


def test_left_join_to_masters() -> None:
    """The whole point of STEP 2: names come via LEFT JOIN so unresolved ids
    surface as NULL, not invented. Guard the join shape."""
    sql = pol_mod.CONNECTION_SQL
    assert "LEFT JOIN" in sql
    assert "jockey_master.parquet" in sql
    assert "trainer_master.parquet" in sql


def test_markdown_carries_framing_caveats(tmp_path: Path) -> None:
    """The honest-framing caveats from STEP 3 must appear verbatim in the
    report -- they are non-negotiable."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        pytest.skip("pyarrow required")

    # Synthetic 1-row pattern_of_life parquet (just enough schema for the
    # markdown emitter to query).
    lake = tmp_path
    norm = lake / "normalized"
    norm.mkdir()
    schema_rows = [{
        "role": "jockey",
        "connection_id": "00666",
        "flagged_count": 50,
        "won_rate_flagged": 0.20,
        "flop_rate_flagged": 0.60,
        "total_races": 600,
        "flag_rate": 0.083,
        "flag_z": 8.91,
        "jockey_name": "武 豊",
        "jockey_name_kana": "ﾀｹ ﾕﾀｶ",
        "trainer_name": None,
        "trainer_name_kana": None,
    }]
    table = pa.Table.from_pylist(schema_rows)
    pol_path = norm / "pattern_of_life.parquet"
    pq.write_table(table, pol_path)

    # runner_z parquet (only COUNT(*) is read; a single row is enough).
    rz = lake / "pattern_of_life_runner_z.parquet"
    rz_table = pa.Table.from_pylist(
        [{"plunge_z": 2.0}, {"plunge_z": 0.5}]  # 1 flagged at z>1.5, 1 not
    )
    pq.write_table(rz_table, rz)

    out = pol_mod.emit_markdown(lake, pol_path, top_n=10)
    text = out.read_text(encoding="utf-8")
    # The four non-negotiable caveats from the prompt STEP 3 + the doc.
    # (Whitespace-normalize so source line-wraps in the template don't break
    # substring checks.)
    flat = " ".join(text.split())
    assert "Over-representation" in flat and "misconduct" in flat
    assert "favorite-longshot" in flat.lower() or "FLB" in flat
    assert "Multiple testing" in flat
    assert "Flag, not verdict" in flat
    # The top connection renders with its name resolved via LEFT JOIN.
    assert "武 豊" in text
    assert "00666" in text
    # The methodological note is present.
    assert "Methodological note" in text


def test_runner_z_sql_scales_over_entire_window() -> None:
    """T-30 selection must use a 30-min target with a 60-min lookback cap so
    thin early boards can't leak into the T-30 reading. Guard the SQL."""
    sql = pol_mod.PLUNGE_SQL
    assert "INTERVAL 30 minutes" in sql
    assert "INTERVAL 60 minutes" in sql
    # Robust z uses MAD scaled by 1.4826 (textbook normal-consistency factor).
    assert "1.4826" in sql
    assert "MAD" in sql.upper() or "mad(" in sql.lower()
