"""Tests for the JRA-VAN silver parser (adapters/jravan + ingestion/jravan_silver).

Fixtures are REAL bronze records (1 RA + 6 SE for one 1986 Nakayama race),
captured from the 20260613 snapshot, so the byte-offset maths is exercised
against genuine Shift-JIS data, not a synthetic record.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from keibamon_core.adapters.jravan import (
    ENCODING,
    RECORD_LENGTHS,
    JravanSourceAdapter,
    parse_fixed,
    RECORD_LAYOUTS,
    track_code_to_surface,
)

FIXTURE_RAW = Path(__file__).parent / "fixtures" / "jravan"


@pytest.fixture()
def adapter() -> JravanSourceAdapter:
    return JravanSourceAdapter(FIXTURE_RAW)


def test_fixture_loads_expected_records(adapter: JravanSourceAdapter) -> None:
    rows = list(adapter.iter_raw(spec="RACE"))
    kinds = [r["record_id"] for r in rows]
    assert kinds.count("RA") == 1
    assert kinds.count("SE") == 6


def test_record_byte_lengths_match_spec(adapter: JravanSourceAdapter) -> None:
    """Every record must re-encode to its canonical JV-Data byte length."""
    for row in adapter.iter_raw(spec="RACE"):
        rec = row["record_id"]
        if rec in RECORD_LENGTHS:
            assert len(row["raw"].rstrip("\r\n").encode(ENCODING)) == RECORD_LENGTHS[rec]


def test_byte_offsets_beat_char_offsets_for_bamei(adapter: JravanSourceAdapter) -> None:
    """The whole reason for byte-slicing: a char-indexed slice misaligns the
    horse name, a byte-indexed slice gets it right. This guards the regression
    the old stub had."""
    se = next(r for r in adapter.iter_raw(spec="RACE") if r["record_id"] == "SE")
    parsed = JravanSourceAdapter.parse_record(se)
    # Byte-accurate parse yields a clean katakana name (no leading garbage).
    assert parsed["bamei"] and "　" not in parsed["bamei"].strip()
    assert all(ord(c) > 0x3000 or c.isalnum() for c in parsed["bamei"])

    # A naive CHAR slice at the same numeric offsets would NOT equal the
    # byte-accurate result, because the record has full-width chars before it.
    raw = se["raw"]
    char_sliced = raw[40:76].strip()
    byte_sliced = raw.encode(ENCODING)[40:76].decode(ENCODING).strip()
    assert char_sliced != byte_sliced  # proves the offset systems diverge


def test_se_header_and_ids_parse(adapter: JravanSourceAdapter) -> None:
    se = next(r for r in adapter.iter_raw(spec="RACE") if r["record_id"] == "SE")
    p = JravanSourceAdapter.parse_record(se)
    assert p["record_spec"] == "SE"
    assert p["year"] == 1986
    assert p["jyo_code"] == "06"
    assert 1 <= p["umaban"] <= 30
    assert p["ketto_num"].isdigit() and len(p["ketto_num"]) == 10
    assert p["_meta"]["content_hash"]  # provenance carried through


def test_ra_race_fields_parse(adapter: JravanSourceAdapter) -> None:
    """Confirmed RA offsets yield real, typed race attributes."""
    ra = next(r for r in adapter.iter_raw(spec="RACE") if r["record_id"] == "RA")
    p = JravanSourceAdapter.parse_record(ra)
    assert p["distance_m"] == 1800
    assert p["track_code"] == "24"          # 2009: 24 = 平地ダート右回り
    assert track_code_to_surface(p["track_code"]) == "dirt"
    assert p["post_time"] == "1000"         # 発走時刻 hhmm


def test_se_results_and_phantom_last4f(adapter: JravanSourceAdapter) -> None:
    """SE result fields parse, and the last-4F phantom trap holds for every row
    while last-3F is populated -- the exact gotcha the spec warns about."""
    rows = [
        JravanSourceAdapter.parse_record(r)
        for r in adapter.iter_raw(spec="RACE")
        if r["record_id"] == "SE"
    ]
    assert all(p["last_4f"] is None for p in rows)        # phantom default '000'
    assert all(p["last_3f"] is not None for p in rows)    # real split present
    # internal consistency: the official winner has the fastest finish time.
    placed = [p for p in rows if p["finish_position"] and p["finish_time"]]
    winner = min(rows, key=lambda p: p["finish_position"] or 99)
    assert winner["finish_position"] == 1
    assert winner["finish_time"] == min(p["finish_time"] for p in placed)
    assert all(0 < p["carried_weight_kg"] < 70 for p in rows)  # sane kg, not 0.1kg


def _odds_fixture_rows():
    import gzip
    import json as _json
    p = FIXTURE_RAW / "odds"
    for gz in sorted(p.glob("*.ndjson.gz")):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    yield _json.loads(line)


def test_odds_combinatorics_are_exact() -> None:
    """A clean field-size proof: an N-horse race yields exactly C(N,2) quinella
    and C(N,3) trio entries, which only holds if combo stride/parsing is right."""
    from math import comb

    by_spec = {r["record_id"]: r for r in _odds_fixture_rows()}
    o1 = JravanSourceAdapter.parse_odds_record(by_spec["O1"])
    n = o1["starter_count"]
    wins = [e for e in o1["entries"] if e["bet_type"] == "win"]
    assert len(wins) == n  # one win-odds row per starter

    o2 = JravanSourceAdapter.parse_odds_record(by_spec["O2"])
    assert len([e for e in o2["entries"] if e["bet_type"] == "quinella"]) == comb(n, 2)
    o5 = JravanSourceAdapter.parse_odds_record(by_spec["O5"])
    assert len([e for e in o5["entries"] if e["bet_type"] == "trio"]) == comb(n, 3)


def test_win_favorite_has_lowest_odds() -> None:
    o1 = JravanSourceAdapter.parse_odds_record(next(
        r for r in _odds_fixture_rows() if r["record_id"] == "O1"))
    wins = [e for e in o1["entries"] if e["bet_type"] == "win" and e["popularity"]]
    fav = min(wins, key=lambda e: e["popularity"])
    assert fav["popularity"] == 1
    assert fav["odds"] == min(e["odds"] for e in wins)
    place = [e for e in o1["entries"] if e["bet_type"] == "place"]
    assert all(e["odds_low"] <= e["odds_high"] for e in place)


def test_parse_odds_record_ignores_non_odds() -> None:
    assert JravanSourceAdapter.parse_odds_record({"record_id": "RA", "raw": "RA..."}) is None


# --------------------------------------------------------------------------- #
# HR payouts + DM/TM mining
# --------------------------------------------------------------------------- #
def _fixture_rows(subdir: str):
    import gzip
    import json as _json
    for gz in sorted((FIXTURE_RAW / subdir).glob("*.ndjson.gz")):
        with gzip.open(gz, "rt", encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    yield _json.loads(line)


def test_hr_payout_parses_and_matches_winner() -> None:
    """HR is the same 1986 race as the RA/SE fixture; its win-payout combo must
    equal the SE official winner's umaban -- a cross-record consistency check."""
    hr = next(r for r in _fixture_rows("payout") if r["record_id"] == "HR")
    p = JravanSourceAdapter.parse_grouped_record(hr)
    win = [e for e in p["entries"] if e["pool"] == "win"]
    assert len(win) == 1 and win[0]["payout"] > 0
    # SE winner from the main RA/SE fixture:
    ses = [JravanSourceAdapter.parse_record(r)
           for r in JravanSourceAdapter(FIXTURE_RAW).iter_raw(spec="RACE")
           if r["record_id"] == "SE"]
    winner = min(ses, key=lambda s: s["finish_position"] or 99)
    assert int(win[0]["combo"]) == winner["umaban"]
    # place pays 2-3 horses, each a real yen amount
    place = [e for e in p["entries"] if e["pool"] == "place"]
    assert 2 <= len(place) <= 3 and all(e["payout"] > 0 for e in place)


def test_mining_dm_is_time_tm_is_score() -> None:
    """Guards the inverted-ID gotcha: DM carries predicted TIME, TM a 0-100 SCORE."""
    rows = {r["record_id"]: r for r in _fixture_rows("mining")}
    dm = JravanSourceAdapter.parse_grouped_record(rows["DM"])
    tm = JravanSourceAdapter.parse_grouped_record(rows["TM"])
    assert all(e["kind"] == "mining_time" for e in dm["entries"])
    assert all(40 < e["pred_time"] < 320 for e in dm["entries"])   # sane race seconds
    assert all(e.get("err_plus") is not None for e in dm["entries"])
    assert all(e["kind"] == "mining_score" for e in tm["entries"])
    assert all(0 < e["score"] <= 100 for e in tm["entries"])       # 0-100 scale


def _write_bronze(tmp_path, fixtures: dict[str, str]):
    """Write fixture subdirs into a tmp lake's bronze using spec-prefixed
    filenames so the adapter's spec-glob finds them. ``fixtures`` maps
    spec name (e.g. 'RACE') -> fixture subdir to pull records from."""
    import gzip
    import json as _json
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


def test_build_payouts(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_payouts
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"RACE": "payout"})
    counts = build_jravan_payouts(lake)
    assert counts["jravan_payouts"] >= 4  # win + 2-3 place + bracket
    rows = read_dataset(lake.silver_dataset("jravan_payouts"))
    assert {"win", "place"} <= {r["pool"] for r in rows}
    assert all(r["payout_yen"] > 0 and r["race_id"].startswith("jra-1986") for r in rows)
    assert all(r["year"] == 1986 and r["venue"] == "06" for r in rows)


def test_build_mining(tmp_path) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_mining
    from keibamon_core.lake import read_dataset

    lake = _write_bronze(tmp_path, {"MING": "mining"})
    counts = build_jravan_mining(lake)
    assert counts["jravan_mining"] > 0
    rows = read_dataset(lake.silver_dataset("jravan_mining"))
    times = [r for r in rows if r["model"] == "time"]
    scores = [r for r in rows if r["model"] == "score"]
    assert times and scores
    assert all(r["pred_time_seconds"] and r["pred_time_seconds"] > 0 for r in times)
    assert all(0 < r["score"] <= 100 for r in scores)
    assert all(r["horse_number"] >= 1 for r in rows)


def test_bad_length_raises() -> None:
    """A truncated record must fail loudly, not silently shift fields."""
    with pytest.raises(ValueError, match="byte-length"):
        parse_fixed("SE7tooshort", RECORD_LAYOUTS["SE"], expected_len=RECORD_LENGTHS["SE"])


def test_unknown_record_returns_none() -> None:
    assert JravanSourceAdapter.parse_record({"record_id": "ZZ", "raw": "ZZ..."}) is None


def test_build_silver_round_trips(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("pyarrow")
    from keibamon_core.ingestion.jravan_silver import build_jravan_silver
    from keibamon_core.lake import read_dataset
    from keibamon_core.paths import LakePaths

    # Point the lake's bronze at the fixtures, silver at a temp dir.
    lake = LakePaths(root=tmp_path / "data")
    # symlink fixtures into the lake's bronze location so the adapter finds them
    bronze = lake.bronze_source_dir("jravan")
    bronze.mkdir(parents=True)
    for snap in FIXTURE_RAW.iterdir():
        (bronze / snap.name).symlink_to(snap.resolve())

    counts = build_jravan_silver(lake)
    assert counts["jravan_races"] == 1
    assert counts["jravan_race_entries"] == 6
    assert counts["jravan_race_results"] == 6

    races = read_dataset(lake.silver_dataset("jravan_races"))
    assert races[0]["race_id"].startswith("jra-1986")
    assert races[0]["racecourse"] == "Nakayama"
    assert races[0]["surface"] == "dirt"
    assert races[0]["distance_m"] == 1800
    assert races[0]["scheduled_post_time"] is not None
    # going + weather overlay (step 0): surface-relevant going for this dirt race
    assert races[0]["weather"] == "fine"
    assert races[0]["going_dirt"] == 3 and races[0]["going_turf"] is None
    assert races[0]["going_wetness"] == 3 and races[0]["going"] == "soft"
    # partition columns are present and correctly typed (venue keeps leading zero)
    assert races[0]["year"] == 1986 and races[0]["venue"] == "06"
    # available_at is EVENT-time (post/race), not the bulk-download time -> PIT works
    assert races[0]["available_at"] == races[0]["scheduled_post_time"]
    assert races[0]["available_at"].year == 1986

    entries = read_dataset(lake.silver_dataset("jravan_race_entries"))
    assert all(e["race_id"] == races[0]["race_id"] for e in entries)
    assert all(e["horse_id"] and e["horse_name"] for e in entries)
    assert all(e["jockey_id"] and 0 < e["carried_weight_kg"] < 70 for e in entries)

    results = read_dataset(lake.silver_dataset("jravan_race_results"))
    winners = [r for r in results if r["finish_position"] == 1]
    assert len(winners) == 1 and winners[0]["finish_time_seconds"] > 0
    assert all(r["available_at"].year == 1986 for r in results)  # event-time, not 2026
