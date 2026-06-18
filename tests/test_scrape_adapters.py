"""Tests for the scrape-sourced ingestion adapters (ADR-0004 prereq).

Covers:
- entries / results / payouts parsers + record builders
- partition-aware upsert (the load-bearing constraint)
- cross-validation gate's four oracles
- placeholder horse_id pair handling
- available_at event-time semantics
- idempotent re-ingest

Suite target: baseline 147 + 10 new = 157 passed, 1 skipped.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.adapters import (
    netkeiba_entries,
    netkeiba_http,
    netkeiba_payouts,
    netkeiba_results,
)
from keibamon_core.ingestion import jravan_silver
from keibamon_core.ingestion.curve_log import crosswalk_race_id
from keibamon_core.ingestion.scrape_upsert import scrape_upsert
from keibamon_core.ingestion.settlement import Bet, settle, settle_many
from keibamon_core.lake import read_dataset, write_dataset
from keibamon_core.paths import LakePaths

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"
JST = timezone(timedelta(hours=9))

# Canonical ids used across the suite.
NK_RACE_ID = "r-2026-0620-hanshin-11"
RACE_ID = "jra-20260620-09-11"  # Hanshin = jyo 09 (per the project's NON-STANDARD mapping)


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _load_gate_module():
    """Load tools/validate_scrape_vs_jravan.py for direct oracle testing.

    Registers the module in sys.modules BEFORE exec_module so dataclass
    processing of the gate's OracleResult/SettleEquivResult classes can
    resolve their annotations (otherwise Python's dataclasses machinery
    fails when ``from __future__ import annotations`` is in effect and the
    module isn't yet in sys.modules).
    """
    import importlib.util
    import sys

    mod_name = "validate_scrape_vs_jravan_under_test"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(
        mod_name,
        Path(__file__).resolve().parent.parent / "tools" / "validate_scrape_vs_jravan.py",
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod  # register BEFORE exec_module
    spec.loader.exec_module(mod)
    return mod


def _jravan_entry_record_columns() -> set[str]:
    """Get JV-Link's exact entry-record column set by calling the source of truth.

    The scrape adapter's output MUST be byte-identical to this. We invoke the
    real builder rather than hardcoding so a future change to
    ``jravan_silver._entry_record`` automatically propagates to the assertion.
    """
    sample = {
        "year": 2026,
        "month_day": "0620",
        "jyo_code": "09",
        "race_num": "11",
        "ketto_num": "2016101001",
        "bamei": "X",
        "umaban": 1,
        "wakuban": 1,
        "jockey_code": "05123",
        "trainer_code": "01045",
        "carried_weight_kg": 56.0,
        "body_weight": 480,
        "_meta": {
            "source_name": "jravan",
            "source_record_id": "x",
            "raw_uri": "p",
            "content_hash": "h",
            "ingested_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
            "published_time": None,
            "available_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
        },
    }
    return set(jravan_silver._entry_record(sample).keys())


# --- Step 1: parser + silver-shape tests -------------------------------------


def test_parse_entries_fixture_to_silver_shape(tmp_path: Path) -> None:
    """Adapter's silver rows match jravan_silver._entry_record's column set exactly."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    n = netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("entries_basic.json")
    )
    assert n == 4  # the fixture declares 4 runners

    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    assert len(rows) == 4
    expected_cols = _jravan_entry_record_columns()
    for row in rows:
        # year/venue are partition cols (read_dataset materializes them) -- they
        # are NOT in _entry_record's data-column set, so subtract them.
        assert set(row.keys()) - {"year", "venue"} == expected_cols
        assert row["source_name"] == "netkeiba"
        assert row["horse_number"] in (1, 2, 3, 8)

    # The placeholder-id guard: horse 3 has a blank ketto_num in the fixture.
    horse3 = next(r for r in rows if r["horse_number"] == 3)
    assert horse3["horse_id"] == "0000000000"
    assert horse3["horse_name"] == "Foreign Invite"


def test_parse_results_fixture_finish_position_none_on_no_placing(tmp_path: Path) -> None:
    """A chakujun=0 (no official placing) must map to finish_position=None.

    Mirrors jravan_silver._result_record's `pos if pos else None` handling.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    netkeiba_results.build_results(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("results_basic.json")
    )
    rows = read_dataset(lake.silver_dataset("jravan_race_results"))
    dnf = next(r for r in rows if r["horse_number"] == 3)
    assert dnf["finish_position"] is None
    assert dnf["finish_time_seconds"] is None
    # The placed runners carry their finishes.
    winner = next(r for r in rows if r["horse_number"] == 8)
    assert winner["finish_position"] == 1
    assert winner["finish_time_seconds"] == 92.4  # "1:32.4" -> 92.4s
    assert winner["win_odds"] == 2.9  # "290" -> 2.9 decimal odds
    assert winner["popularity"] == 1


def test_parse_payouts_fixture_dead_heat_emits_multiple_rows(tmp_path: Path) -> None:
    """A dead-heat combo emits one row per (combo, payout) on the source page.
    settlement._load_official_payouts MAX-collapses duplicates on read -- the
    parser must NOT dedupe them upstream.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    netkeiba_payouts.build_payouts(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("payouts_dead_heat.json")
    )
    rows = read_dataset(lake.silver_dataset("jravan_payouts"))
    place_rows = sorted(
        (r for r in rows if r["pool"] == "place"), key=lambda r: r["combo"]
    )
    assert len(place_rows) == 3  # 05, 07, 09 -- a triple dead-heat for 2nd
    # The two dead-heat payouts share ninki=2 but are distinct combos with
    # identical payout_yen -- they survive as separate rows.
    payouts_07_09 = sorted(r["payout_yen"] for r in place_rows if r["combo"] in ("07", "09"))
    assert payouts_07_09 == [150, 150]

    # settle_many's MAX-collapse picks up the right payout per combo.
    settled = settle_many(lake, [Bet(RACE_ID, "place", "07", stake_yen=100)])
    assert settled[0].returned_yen == 150


def test_placeholder_horse_id_pair_keyed_by_horse_number(tmp_path: Path) -> None:
    """Two runners sharing the '0000000000' placeholder horse_id must stay
    distinct, keyed by horse_number. Settlement's scratch join must not
    cross-map one runner's result to satisfy the other's lookup.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("entries_placeholder_pair.json")
    )
    # Result row for horse 5 ONLY -- horse 6 is a scratch.
    write_dataset(
        [
            {
                "race_id": RACE_ID,
                "horse_id": "0000000000",
                "horse_number": 5,
                "finish_position": 1,
                "finish_time_seconds": 95.0,
                "margin": None,
                "win_odds": 2.1,
                "popularity": 1,
                "last_3f_seconds": None,
                "source_name": "jravan",
                "source_record_id": None,
                "raw_uri": None,
                "content_hash": None,
                "ingested_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "09",
            }
        ],
        lake.silver_dataset("jravan_race_results"),
    )
    # And a payout for combo "05" only.
    write_dataset(
        [
            {
                "race_id": RACE_ID,
                "pool": "win",
                "combo": "05",
                "payout_yen": 210,
                "popularity": 1,
                "source_name": "jravan",
                "source_record_id": None,
                "raw_uri": None,
                "content_hash": None,
                "ingested_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "09",
            }
        ],
        lake.silver_dataset("jravan_payouts"),
    )

    # Bet on the runner -- pays out.
    s5 = settle(lake, Bet(RACE_ID, "win", "05", stake_yen=100))
    assert s5.payout_yen == 210
    # Bet on the scratch -- refund, NOT cross-mapped to horse 5's result.
    s6 = settle(lake, Bet(RACE_ID, "win", "06", stake_yen=100))
    assert s6.reason == "refund"
    assert s6.returned_yen == 100


def test_available_at_is_event_time_not_download_time(tmp_path: Path) -> None:
    """available_at = published event time (JST->UTC), NEVER scrape time.

    The fixture's published_time is 09:00 JST (00:00 UTC). The captured_at
    download time is 21:00 UTC. The silver row must carry 00:00 UTC, not 21:00
    UTC -- this is the available_at_bulk_download PIT lesson applied to scrape.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    captured_at = datetime(2026, 6, 20, 21, 0, tzinfo=timezone.utc)
    netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID,
        payload_text=_load("entries_basic.json"),
        captured_at=captured_at,
    )
    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    expected_available_at = datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)  # 09:00 JST = 00:00 UTC
    for row in rows:
        assert row["available_at"] == expected_available_at
        assert row["available_at"] != captured_at  # never the scrape time
        assert row["published_time"] == expected_available_at


def test_source_name_netkeiba_stamped(tmp_path: Path) -> None:
    """Every scrape row carries source_name='netkeiba'; JV-Link rows in the same
    table stay 'jravan'. This is the provenance contract ADR-0004 requires."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()

    # JV-Link rows written directly (the licensed-feed write path).
    write_dataset(
        [
            {
                "race_id": RACE_ID,
                "horse_id": "2016101001",
                "horse_name": "JV Horse",
                "horse_number": 1,
                "gate": 1,
                "jockey_id": "0",
                "trainer_id": "0",
                "carried_weight_kg": 56.0,
                "body_weight_kg": 480,
                "source_name": "jravan",
                "source_record_id": "jv:1",
                "raw_uri": "jv://raw",
                "content_hash": "jvhash",
                "ingested_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
                "year": 2026,
                "venue": "09",
            }
        ],
        lake.silver_dataset("jravan_race_entries"),
    )
    # Scrape rows via the adapter.
    netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("entries_basic.json")
    )

    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    by_source = {"jravan": [], "netkeiba": []}
    for r in rows:
        by_source.setdefault(r["source_name"], []).append(r)
    assert len(by_source["jravan"]) == 1, "JV-Link row should survive the upsert"
    assert len(by_source["netkeiba"]) == 4, "scrape rows should be added"
    # Even though horse_number=1 appears in BOTH sources, the rows are distinct
    # because they carry different source_name + source_record_id.
    assert {r["source_name"] for r in rows} == {"jravan", "netkeiba"}


# --- Step 7: partition-aware upsert (the load-bearing constraint) -------------


def test_scrape_upsert_partition_aware_no_clobber(tmp_path: Path) -> None:
    """Regression test for the load-bearing constraint: upserting rows for ONE
    race in a (year, venue) partition must NOT clobber rows for OTHER races in
    that same partition. write_dataset's delete_matching would do exactly that
    without the partition-aware RMW in scrape_upsert.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()

    # 5 JV-Link entries for race A in (2026, '05').
    race_a = "jra-20260601-05-11"
    jv_rows = [
        {
            "race_id": race_a,
            "horse_id": f"jv-{i}",
            "horse_name": f"JV A{i}",
            "horse_number": i,
            "gate": i,
            "jockey_id": "0",
            "trainer_id": "0",
            "carried_weight_kg": 56.0,
            "body_weight_kg": 480,
            "source_name": "jravan",
            "source_record_id": f"jv:{i}",
            "raw_uri": "jv://raw",
            "content_hash": "jvhash",
            "ingested_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
            "published_time": None,
            "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
            "year": 2026,
            "venue": "05",
        }
        for i in range(1, 6)
    ]
    write_dataset(jv_rows, lake.silver_dataset("jravan_race_entries"))

    # 3 scrape entries for race B in the SAME (2026, '05') partition.
    race_b = "jra-20260601-05-12"
    scrape_rows = [
        {
            "race_id": race_b,
            "horse_id": f"nk-{i}",
            "horse_name": f"NK B{i}",
            "horse_number": i,
            "gate": i,
            "jockey_id": "0",
            "trainer_id": "0",
            "carried_weight_kg": 56.0,
            "body_weight_kg": 480,
            "source_name": "netkeiba",
            "source_record_id": f"nk:{i}",
            "raw_uri": "nk://raw",
            "content_hash": "nkhash",
            "ingested_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
            "published_time": None,
            "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
            "year": 2026,
            "venue": "05",
        }
        for i in range(1, 4)
    ]
    added = scrape_upsert(
        lake, "jravan_race_entries", scrape_rows, natural_key=("race_id", "horse_number")
    )
    assert added == 3

    all_rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    assert len(all_rows) == 8, "race A's 5 rows + race B's 3 rows = 8 (no clobber)"
    race_ids = {r["race_id"] for r in all_rows}
    assert race_ids == {race_a, race_b}, "both races survive"
    race_a_rows = [r for r in all_rows if r["race_id"] == race_a]
    assert len(race_a_rows) == 5, "race A's rows are untouched"
    assert {r["horse_id"] for r in race_a_rows} == {f"jv-{i}" for i in range(1, 6)}


def test_idempotent_re_ingest_adds_no_duplicates(tmp_path: Path) -> None:
    """Re-ingesting an unchanged payload adds zero rows (dedup on natural_key + available_at)."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    n1 = netkeiba_payouts.build_payouts(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("payouts_basic.json")
    )
    assert n1 > 0
    n2 = netkeiba_payouts.build_payouts(
        lake, NK_RACE_ID, RACE_ID, payload_text=_load("payouts_basic.json")
    )
    assert n2 == 0, "second identical ingest should add zero rows"
    rows = read_dataset(lake.silver_dataset("jravan_payouts"))
    assert len(rows) == n1


# --- Step 5: cross-validation gate -------------------------------------------


def _write_payouts(rows: list[dict], lake: LakePaths, source: str, race_id: str, pool: str,
                   combo: str, payout: int, *, popularity: int | None = 1) -> None:
    rows.append({
        "race_id": race_id, "pool": pool, "combo": combo, "payout_yen": payout,
        "popularity": popularity, "source_name": source, "source_record_id": f"{source}:{combo}",
        "raw_uri": f"{source}://raw", "content_hash": f"{source}hash",
        "ingested_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
        "published_time": None,
        "available_at": datetime(2026, 6, 20, tzinfo=timezone.utc),
        "year": 2026, "venue": "09",
    })


def test_cross_validation_oracle_passes_on_identical_rows(tmp_path: Path) -> None:
    """JV-Link + scrape rows for one race with identical payouts/results/entries
    -> every oracle returns 0 mismatches, settle equivalence PASS."""
    mod = _load_gate_module()

    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    # Write the SAME win/place payouts from both sources for one race.
    rows: list[dict] = []
    for combo, pay in [("01", 200), ("02", 350), ("03", 800)]:
        _write_payouts(rows, lake, "jravan", RACE_ID, "win", combo, pay)
        _write_payouts(rows, lake, "netkeiba", RACE_ID, "win", combo, pay)
    _write_payouts(rows, lake, "jravan", RACE_ID, "place", "01", 110)
    _write_payouts(rows, lake, "netkeiba", RACE_ID, "place", "01", 110)
    write_dataset(rows, lake.silver_dataset("jravan_payouts"))

    overlap = mod._overlap_race_ids(lake)
    assert overlap == [RACE_ID]
    pay = mod._payouts_oracle(lake, overlap)
    res = mod._results_oracle(lake, overlap)
    ent = mod._entries_oracle(lake, overlap)
    seq = mod._settle_equivalence(lake, overlap)

    assert pay.mismatches == 0
    assert res.mismatches == 0  # no results at all -> no mismatches
    assert ent.mismatches == 0  # no entries at all -> no mismatches
    assert seq.divergent == 0


def test_cross_validation_oracle_flags_injected_mismatch(tmp_path: Path) -> None:
    """A 10-yen scrape/JV-Link payout divergence -> 1 mismatch, FAIL, and the
    printed diff names the (race_id, pool, combo)."""
    mod = _load_gate_module()

    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    rows: list[dict] = []
    # JV-Link says 200; scrape says 210 (10-yen divergence).
    _write_payouts(rows, lake, "jravan", RACE_ID, "win", "01", 200)
    _write_payouts(rows, lake, "netkeiba", RACE_ID, "win", "01", 210)
    # Another combo where they agree, to show only the diff is flagged.
    _write_payouts(rows, lake, "jravan", RACE_ID, "win", "02", 350)
    _write_payouts(rows, lake, "netkeiba", RACE_ID, "win", "02", 350)
    write_dataset(rows, lake.silver_dataset("jravan_payouts"))

    overlap = mod._overlap_race_ids(lake)
    assert overlap == [RACE_ID]
    pay = mod._payouts_oracle(lake, overlap)
    assert pay.mismatches == 1
    assert pay.audited == 2  # two distinct (race, pool, combo) keys
    # The diff names the divergent key (combo 01), NOT the agreeing combo 02.
    assert pay.sample_diffs, "oracle must surface the divergent key in sample_diffs"
    diff_str = pay.sample_diffs[0]
    assert RACE_ID in diff_str
    assert "'win'" in diff_str
    assert "'01'" in diff_str
    assert "'02'" not in diff_str  # the agreeing combo isn't flagged

    seq = mod._settle_equivalence(lake, overlap)
    assert seq.divergent >= 1, "settle equivalence must also diverge on the mismatched combo"


# --- Bonus: meta tests on the http + upsert primitives -----------------------


def test_archive_raw_is_idempotent_on_identical_payload(tmp_path: Path) -> None:
    """archive_raw writes once; a second call with the same payload returns the
    same path and adds no file (mirrors polling/poller.py:poll_once)."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    payload = '{"data": {}}'
    cap = datetime(2026, 6, 20, 12, 0, tzinfo=timezone.utc)
    p1 = netkeiba_http.archive_raw(lake, "netkeiba_payouts", NK_RACE_ID, "payouts", payload, cap)
    p2 = netkeiba_http.archive_raw(lake, "netkeiba_payouts", NK_RACE_ID, "payouts", payload, cap)
    assert p1 == p2
    kind_dir = p1.parent
    payloads = sorted(kind_dir.glob("*.json"))
    assert len(payloads) == 1


def test_crosswalk_roundtrip_canonical_id_passthrough() -> None:
    """crosswalk_race_id passes canonical jra- ids through untouched and maps
    netkeiba synthetic r- ids correctly (Hanshin = jyo 09 per project mapping)."""
    assert crosswalk_race_id("jra-20260620-09-11") == "jra-20260620-09-11"
    assert crosswalk_race_id(NK_RACE_ID) == RACE_ID
