"""Tests for the JRA-VAN master parser + silver builders (KS 騎手マスタ /
CH 調教師マスタ).

Fixtures are REAL bronze records (KS 00666 武豊, KS 05339 Ｃ．ルメール,
CH 01007 柴田政人, CH 01098 野中賢二) captured from the 2026-06-26 master
pull, plus one synthesized placeholder row per spec (jockey_id/trainer_id
'00000') so the DATA_TRAP rule is exercised -- the live bronze carries 0
placeholder rows in this pull, so we mint one by overwriting the id bytes
of a real record to keep the byte length intact.

The records arrive at the bronze as cp1252-decoded strings (English Windows
ACP), NOT cp932 (Japanese ACP) -- see ``masters.cp1252_roundtrip`` DATA_TRAP.
``recover_raw_bytes`` undoes the wrong decode; these tests guard the
round-trip and the placeholder rule.
"""
from __future__ import annotations

import gzip
import json as _json
from pathlib import Path

import pytest

from keibamon_core.adapters.jravan import (
    ENCODING,
    RECORD_LENGTHS,
    RECORD_LAYOUTS,
    _CP1252_HIGH_REVERSE,
    parse_master,
    recover_raw_bytes,
)

FIXTURE_RAW = Path(__file__).parent / "fixtures" / "jravan"


def _fixture_rows(subdir: str):
    p = FIXTURE_RAW / subdir
    for gz in sorted(p.glob("*.ndjson.gz")):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    yield _json.loads(line)


# --------------------------------------------------------------------------- #
# recover_raw_bytes -- the cp1252 round-trip
# --------------------------------------------------------------------------- #
def test_recover_raw_bytes_ascii_passthrough() -> None:
    """ASCII bytes survive the cp1252 decode unmodified."""
    assert recover_raw_bytes("KS220110530") == b"KS220110530"


def test_recover_raw_bytes_latin1_passthrough() -> None:
    """U+0080..U+00FF (latin-1 supplement) pass through as single bytes."""
    # These are the chars that cp1252 leaves as the original byte (the 5
    # holes 0x81/0x8D/0x8F/0x90/0x9D in the cp1252 table decode as the raw
    # byte under errors="replace"-style fallbacks; latin-1 has them as chars).
    assert recover_raw_bytes("\x81\x8f\x9d") == b"\x81\x8f\x9d"


def test_recover_raw_bytes_cp1252_high_reverse() -> None:
    """The 27 cp1252 high chars map back to their original cp1252 bytes."""
    # Round-trip every entry in the reverse map.
    for cp, byte in _CP1252_HIGH_REVERSE.items():
        char = chr(cp)
        assert recover_raw_bytes(char) == bytes([byte])
    # Spot-check the marquee cases: U+0152 Œ → 0x8C, U+2014 — → 0x97.
    assert recover_raw_bytes("\u0152") == b"\x8c"
    assert recover_raw_bytes("\u2014") == b"\x97"
    assert recover_raw_bytes("\u201c") == b"\x93"


def test_recover_raw_bytes_rejects_unmapped() -> None:
    """A char outside latin-1 + cp1252's high range is impossible under the
    documented bronze decode; failing loudly is the contract."""
    with pytest.raises(ValueError, match="unmapped codepoint"):
        recover_raw_bytes("hiragana-\u3042")


def test_recover_raw_bytes_round_trip_real_ks_record() -> None:
    """A real KS record's recovered bytes decode cleanly as cp932."""
    rows = [r for r in _fixture_rows("masters") if r["record_id"] == "KS"]
    raw = rows[0]["raw"]
    # If this round-trip is sound, the recovered bytes decode as cp932 with
    # no U+FFFD replacement chars (which errors="replace" would emit).
    recovered = recover_raw_bytes(raw.rstrip("\r\n"))
    decoded = recovered.decode(ENCODING)  # strict -- no errors arg
    assert "\ufffd" not in decoded
    # The first two bytes are still "KS".
    assert decoded[:2] == "KS"


# --------------------------------------------------------------------------- #
# parse_master -- byte-offset slicing on recovered bytes
# --------------------------------------------------------------------------- #
def _ks_records():
    return [r for r in _fixture_rows("masters") if r["record_id"] == "KS"]


def _ch_records():
    return [r for r in _fixture_rows("masters") if r["record_id"] == "CH"]


def test_parse_master_real_jockey_yutaka_take() -> None:
    """KS jockey_id 00666 resolves to 武 豊 (Yutaka Take) -- the canonical
    marquee-rider spot-check from the prompt's verifier instructions."""
    rows = {r["raw"][11:16]: r for r in _ks_records() if r["raw"][11:16] != "00000"}
    p = parse_master(rows["00666"]["raw"], RECORD_LAYOUTS["KS"],
                     expected_len=RECORD_LENGTHS["KS"])
    assert p["record_spec"] == "KS"
    assert p["jockey_id"] == "00666"
    # cp1252 round-trip yields clean cp932: 武\u3000豊 (surname-space-given).
    assert p["name"] is not None and "武" in p["name"] and "豊" in p["name"]
    assert p["sex_code"] == 1  # 1 = male
    assert p["data_kubun"] in (1, 2)  # 1=new or 2=update (not 0=delete)


def test_parse_master_real_jockey_lemaire() -> None:
    """KS jockey_id 05339 resolves to Ｃ．ルメール (Christophe Lemaire)."""
    rows = {r["raw"][11:16]: r for r in _ks_records() if r["raw"][11:16] != "00000"}
    p = parse_master(rows["05339"]["raw"], RECORD_LAYOUTS["KS"],
                     expected_len=RECORD_LENGTHS["KS"])
    assert p["jockey_id"] == "05339"
    assert "ルメール" in p["name"]


def test_parse_master_real_trainer() -> None:
    """CH trainer_id 01007 resolves to a clean Japanese trainer name."""
    rows = {r["raw"][11:16]: r for r in _ch_records() if r["raw"][11:16] != "00000"}
    p = parse_master(rows["01007"]["raw"], RECORD_LAYOUTS["CH"],
                     expected_len=RECORD_LENGTHS["CH"])
    assert p["record_spec"] == "CH"
    assert p["trainer_id"] == "01007"
    # Real Japanese name parses (柴田 政人 as of the 2026-06-26 pull).
    assert p["name"] is not None and "柴田" in p["name"]


def test_parse_master_byte_length_mismatch_raises() -> None:
    """A truncated master record must fail loudly so offsets can't silently
    misalign -- mirrors the parse_fixed contract."""
    with pytest.raises(ValueError, match="byte-length"):
        parse_master("KSshort", RECORD_LAYOUTS["KS"],
                     expected_len=RECORD_LENGTHS["KS"])


# --------------------------------------------------------------------------- #
# Silver builders + DATA_TRAP placeholder rule
# --------------------------------------------------------------------------- #
def _write_master_bronze(tmp_path):
    """Wire fixture master records into a tmp lake's bronze."""
    from keibamon_core.paths import LakePaths

    lake = LakePaths(root=tmp_path / "data")
    snap = lake.bronze_source_dir("jravan") / "20260101T000000"
    snap.mkdir(parents=True)
    for spec in ("KS", "CH"):
        rows = [r for r in _fixture_rows("masters") if r["record_id"] == spec]
        with gzip.open(snap / f"{spec}.fixture.0001.ndjson.gz", "wt",
                       encoding="utf-8") as fh:
            for r in rows:
                fh.write(_json.dumps(r, ensure_ascii=False) + "\n")
    return lake


def test_build_jockey_master(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import (
        build_jockey_master, PLACEHOLDER_LABEL,
    )
    from keibamon_core.lake import read_dataset

    lake = _write_master_bronze(tmp_path)
    counts = build_jockey_master(lake)
    # 2 real + 1 placeholder = 3 unique ids.
    assert counts == {"jockey_master": 3}

    rows = read_dataset(lake.normalized / "jockey_master.parquet")
    by_id = {r["jockey_id"]: r for r in rows}
    # Marquee names resolve cleanly.
    assert "武" in by_id["00666"]["name"] and "豊" in by_id["00666"]["name"]
    assert "ルメール" in by_id["05339"]["name"]
    # DATA_TRAP: placeholder id '00000' is labelled, never named.
    assert by_id["00000"]["name"] == PLACEHOLDER_LABEL
    assert by_id["00000"]["name_kana"] == PLACEHOLDER_LABEL


def test_build_trainer_master(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import (
        build_trainer_master, PLACEHOLDER_LABEL,
    )
    from keibamon_core.lake import read_dataset

    lake = _write_master_bronze(tmp_path)
    counts = build_trainer_master(lake)
    assert counts == {"trainer_master": 3}

    rows = read_dataset(lake.normalized / "trainer_master.parquet")
    by_id = {r["trainer_id"]: r for r in rows}
    assert "柴田" in by_id["01007"]["name"]
    # DATA_TRAP: placeholder rule applies symmetrically to CH.
    assert by_id["00000"]["name"] == PLACEHOLDER_LABEL


def test_master_name_normalization_trims_padding() -> None:
    """The spec pads name to full byte width with full-width spaces; the
    builder strips trailing padding and converts the surname separator
    U+3000 to an ASCII space so downstream tools handle it cleanly."""
    from keibamon_core.ingestion.jravan_silver import _normalize_master_name

    # Trailing U+3000 padding stripped, internal U+3000 → space.
    assert _normalize_master_name("武\u3000豊\u3000\u3000\u3000") == "武 豊"
    # Half-width space padding also stripped.
    assert _normalize_master_name("秋元 松雄   ") == "秋元 松雄"
    # All-padding field collapses to None (not empty string).
    assert _normalize_master_name("\u3000\u3000\u3000") is None
    # None in, None out.
    assert _normalize_master_name(None) is None


def test_master_dedup_latest_wins(tmp_path) -> None:
    """Multiple KS rows for the same jockey_id (delta updates) collapse to
    one silver row, last-write-wins by file order."""
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jockey_master
    from keibamon_core.lake import read_dataset

    lake = _write_master_bronze(tmp_path)
    # Append a second snapshot with a duplicate of jockey 00666 (different
    # raw content so dedup is observable through make_date).
    snap2 = lake.bronze_source_dir("jravan") / "20260102T000000"
    snap2.mkdir(parents=True)
    real_records = [r for r in _fixture_rows("masters")
                    if r["record_id"] == "KS" and r["raw"][11:16] == "00666"]
    # Fabricate a "newer" record by bumping the make_date bytes [3:11].
    newer = dict(real_records[0])
    newer_raw = newer["raw"][:3] + "20260101" + newer["raw"][11:]
    newer["raw"] = newer_raw
    with gzip.open(snap2 / "KS.fixture.0001.ndjson.gz", "wt",
                   encoding="utf-8") as fh:
        fh.write(_json.dumps(newer, ensure_ascii=False) + "\n")

    build_jockey_master(lake)
    rows = read_dataset(lake.normalized / "jockey_master.parquet")
    take = [r for r in rows if r["jockey_id"] == "00666"][0]
    # Latest snapshot wins: make_date reflects the second record's 2026-01-01
    # (date8 converter returns ISO-style 'YYYY-MM-DD' string).
    assert take["make_date"] == "2026-01-01"
