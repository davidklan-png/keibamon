"""Tests for the scrape-sourced ingestion adapters (ADR-0004 prereq).

Drives REAL captured payloads end-to-end so the parsers are pinned against
the actual wire format netkeiba serves (per the user's "one real-payload
test per adapter" rule -- the synthetic JSON fixtures are GONE; they stayed
green over a parser that never hit the real wire, which is exactly the bug
ADR-0004's Friday dry run caught).

Real fixtures (all live captures from ADR-0004's dry run):
  - ``shutuba_202605030611.html`` -- 2026-06-21 Tokyo R11 Fuchu Himba S, G3,
    16 declared runners. Used for entries + race-header.
  - ``shutuba_202609030611.html`` -- 2026-06-21 Hanshin R11 Shirasagi S, G3,
    18 declared runners. Second entries fixture (cross-venue check).
  - ``result_202609030411.html`` -- 2026-06-14 Hanshin R11 宝塚記念 G1.
    Carries 18 finishers (incl. one DNF/中止) and the full payout table.

Covers:
- entries / results / payouts parsers + record builders (real HTML)
- partition-aware upsert (the load-bearing constraint)
- cross-validation gate's four oracles
- placeholder horse_id handling (synthesized -- no real fixture has one yet)
- available_at event-time semantics (falls back to scrape-day midnight)
- idempotent re-ingest
"""
from __future__ import annotations

from datetime import datetime, timezone
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

# 2026-06-21 Tokyo R11 (Fuchu Himba S, G3). Numeric id encodes kai/nichi;
# canonical id is the lake key.
NK_RACE_ID = "202605030611"
RACE_ID = "jra-20260621-05-11"  # Tokyo = jyo 05


def _load(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _load_gate_module():
    """Load tools/validate_scrape_vs_jravan.py for direct oracle testing.

    Registers the module in sys.modules BEFORE exec_module so dataclass
    processing of the gate's OracleResult/SettleEquivResult classes can
    resolve their annotations.
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
    """Get JV-Link's exact entry-record column set by calling the source of truth."""
    sample = {
        "year": 2026,
        "month_day": "0621",
        "jyo_code": "05",
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
            "ingested_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
            "published_time": None,
            "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
        },
    }
    return set(jravan_silver._entry_record(sample).keys())


# --- Step 1: parser + silver-shape tests (REAL HTML) -------------------------


def test_parse_entries_real_shutuba_fixture_to_silver_shape(tmp_path: Path) -> None:
    """Drive the entries parser against the real Tokyo R11 shutuba capture.
    The fixture declares 16 runners; the parser must extract every one with
    the byte-identical-to-JV-Link column set the cross-validation gate keys
    on."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    n = netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID,
        payload_text=_load("shutuba_202605030611.html"),
    )
    assert n == 16  # the Fuchu Himba S declared 16 runners (verified Friday)

    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    assert len(rows) == 16
    expected_cols = _jravan_entry_record_columns()
    for row in rows:
        # year/venue are partition cols (read_dataset materializes them) --
        # they are NOT in _entry_record's data-column set, so subtract them.
        assert set(row.keys()) - {"year", "venue"} == expected_cols
        assert row["source_name"] == "netkeiba"

    # Spot-check runner 1 (マカナ, the fixture's first declared horse).
    horse1 = next(r for r in rows if r["horse_number"] == 1)
    assert horse1["horse_id"] == "2022100019"
    assert horse1["horse_name"] == "マカナ"
    assert horse1["gate"] == 1
    assert horse1["carried_weight_kg"] == 50.0  # 馬券 weight futan from the cell


def test_parse_entries_hanshin_fixture_yields_18_runners(tmp_path: Path) -> None:
    """Second real capture -- 2026-06-21 Hanshin R11 (Shirasagi S). The page
    declares 18 runners (one more than Tokyo R11); the parser must surface
    all 18 with distinct horse_numbers. Cross-venue check that the parser
    isn't over-fit to Tokyo's page structure."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    n = netkeiba_entries.build_entries(
        lake, "202609030611", "jra-20260621-09-11",
        payload_text=_load("shutuba_202609030611.html"),
    )
    assert n == 18
    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    assert len(rows) == 18
    assert sorted(r["horse_number"] for r in rows) == list(range(1, 19))


def test_parse_results_real_fixture_finish_position_none_on_dnf(
    tmp_path: Path,
) -> None:
    """Drive the results parser against the real 2026-06-14 宝塚記念 G1
    capture. The race had one 中止 (DNF) -- horse 15 -- which must map to
    finish_position=None. Mirrors jravan_silver._result_record's handling
    of 'no official placing'."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    netkeiba_results.build_results(
        lake, "202609030411", "jra-20260614-09-11",
        payload_text=_load("result_202609030411.html"),
    )
    rows = read_dataset(lake.silver_dataset("jravan_race_results"))
    assert len(rows) == 18  # 18 finishers including the DNF
    # The DNF (horse 15, マイユニバース) -- finish_position must be None.
    dnf = next(r for r in rows if r["horse_number"] == 15)
    assert dnf["finish_position"] is None
    assert dnf["finish_time_seconds"] is None
    # The winner (horse 16, メイショウタバル) -- finish_position=1, time=2:12.1.
    winner = next(r for r in rows if r["horse_number"] == 16)
    assert winner["finish_position"] == 1
    assert winner["finish_time_seconds"] == 132.1  # 2:12.1 -> 132.1s
    assert winner["win_odds"] == 3.9  # decimal odds straight from the cell
    assert winner["popularity"] == 2
    assert winner["last_3f_seconds"] == 35.3


def test_parse_payouts_real_fixture_emits_all_eight_pools(tmp_path: Path) -> None:
    """The 宝塚記念 fixture carries the full payout table (one row per pool).
    For the multi-combo Fukusho row (top-3 finishers 16/5/1), the parser must
    fan out into THREE distinct rows -- one per (combo, payout). For Wide
    (three winning pairs 5-16/1-16/1-5), THREE rows. Single-combo pools
    (win/bracket_quinella/quinella/exacta/trio/trifecta) emit one row each."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    netkeiba_payouts.build_payouts(
        lake, "202609030411", "jra-20260614-09-11",
        payload_text=_load("result_202609030411.html"),
    )
    rows = read_dataset(lake.silver_dataset("jravan_payouts"))
    pools_present = {r["pool"] for r in rows}
    assert pools_present == {
        "win", "place", "bracket_quinella", "quinella",
        "wide", "exacta", "trio", "trifecta",
    }, "all eight pools must surface"

    # Multi-combo place row: 3 finishers -> 3 rows.
    place_rows = sorted(
        (r for r in rows if r["pool"] == "place"), key=lambda r: r["combo"]
    )
    assert len(place_rows) == 3
    assert {r["combo"] for r in place_rows} == {"01", "05", "16"}
    place_by_combo = {r["combo"]: r for r in place_rows}
    assert place_by_combo["16"]["payout_yen"] == 140
    assert place_by_combo["05"]["payout_yen"] == 120
    assert place_by_combo["01"]["payout_yen"] == 170

    # Multi-combo wide row: 3 winning pairs -> 3 rows.
    wide_rows = {r["combo"]: r for r in rows if r["pool"] == "wide"}
    assert len(wide_rows) == 3
    assert wide_rows["0516"]["payout_yen"] == 260
    assert wide_rows["0116"]["payout_yen"] == 490
    assert wide_rows["0105"]["payout_yen"] == 290

    # Spot-check exotics: trifecta 16-5-1 -> 6,040 yen, popularity 11.
    trifecta = next(r for r in rows if r["pool"] == "trifecta")
    assert trifecta["combo"] == "160501"
    assert trifecta["payout_yen"] == 6040
    assert trifecta["popularity"] == 11


def test_parse_payouts_real_fixture_settles_through_settle_many(
    tmp_path: Path,
) -> None:
    """End-to-end: scrape payouts -> silver -> settle_many. The scrape rows
    must slot into settle_many's lookup unchanged (combos canonicalized via
    _normalize_selection). This is the load-bearing contract."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    netkeiba_payouts.build_payouts(
        lake, "202609030411", "jra-20260614-09-11",
        payload_text=_load("result_202609030411.html"),
    )
    race_id = "jra-20260614-09-11"
    # A 100-yen win bet on horse 16 (the winner) pays 390 yen (per the cell).
    settled = settle_many(lake, [Bet(race_id, "win", "16", stake_yen=100)])
    assert settled[0].returned_yen == 390
    # A 100-yen trifecta bet on 16-5-1 -> 6,040 yen.
    settled_tri = settle_many(lake, [Bet(race_id, "trifecta", "16-05-01", stake_yen=100)])
    assert settled_tri[0].returned_yen == 6040


def test_placeholder_horse_id_pair_keyed_by_horse_number(tmp_path: Path) -> None:
    """Two runners sharing the '0000000000' placeholder horse_id must stay
    distinct, keyed by horse_number. Settlement's scratch join must not
    cross-map one runner's result to satisfy the other's lookup.

    No real capture in our fixtures exercises the placeholder trap yet (the
    Fuchu Himba S page has full ketto_num for every horse). This test
    synthesizes the trap by writing entry rows directly -- the underlying
    invariant is on settlement's silver-table read path, not the parser.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    # Synthesize: two runners with the SAME placeholder horse_id but distinct
    # horse_numbers (5 and 6).
    write_dataset(
        [
            {
                "race_id": RACE_ID, "horse_id": "0000000000", "horse_name": "Pair A",
                "horse_number": 5, "gate": 5, "jockey_id": "0", "trainer_id": "0",
                "carried_weight_kg": 56.0, "body_weight_kg": 480,
                "source_name": "netkeiba", "source_record_id": "nk:5",
                "raw_uri": "nk://5", "content_hash": "h5",
                "ingested_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "year": 2026, "venue": "05",
            },
            {
                "race_id": RACE_ID, "horse_id": "0000000000", "horse_name": "Pair B",
                "horse_number": 6, "gate": 6, "jockey_id": "0", "trainer_id": "0",
                "carried_weight_kg": 56.0, "body_weight_kg": 480,
                "source_name": "netkeiba", "source_record_id": "nk:6",
                "raw_uri": "nk://6", "content_hash": "h6",
                "ingested_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "year": 2026, "venue": "05",
            },
        ],
        lake.silver_dataset("jravan_race_entries"),
    )
    # Result row for horse 5 ONLY -- horse 6 is a scratch.
    write_dataset(
        [
            {
                "race_id": RACE_ID, "horse_id": "0000000000", "horse_number": 5,
                "finish_position": 1, "finish_time_seconds": 95.0,
                "margin": None, "win_odds": 2.1, "popularity": 1,
                "last_3f_seconds": None,
                "source_name": "jravan", "source_record_id": None,
                "raw_uri": None, "content_hash": None,
                "ingested_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "year": 2026, "venue": "05",
            }
        ],
        lake.silver_dataset("jravan_race_results"),
    )
    # And a payout for combo "05" only.
    write_dataset(
        [
            {
                "race_id": RACE_ID, "pool": "win", "combo": "05", "payout_yen": 210,
                "popularity": 1,
                "source_name": "jravan", "source_record_id": None,
                "raw_uri": None, "content_hash": None,
                "ingested_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "published_time": None,
                "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "year": 2026, "venue": "05",
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


# --- available_at semantics (the PIT compromise) -----------------------------


def test_available_at_floors_captured_at_to_utc_midnight(tmp_path: Path) -> None:
    """shutuba.html carries no publish timestamp (PIT compromise). available_at
    MUST equal captured_at floored to UTC midnight -- NOT captured_at verbatim
    (so same-day re-scrapes dedupe), NOT a fabricated publish time (which
    would lose PIT honesty). Documented in the adapter's module docstring.

    The captured_at here (21:00 UTC) is AFTER the race would have been
    settled, but the silver row's available_at floors to that day's midnight
    (00:00 UTC). This is the post-cutover equivalent of "the entries became
    visible sometime on this date" -- the honest upper bound.
    """
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    captured_at = datetime(2026, 6, 19, 21, 0, tzinfo=timezone.utc)
    expected_midnight = datetime(2026, 6, 19, 0, 0, tzinfo=timezone.utc)
    netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID,
        payload_text=_load("shutuba_202605030611.html"),
        captured_at=captured_at,
    )
    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    for row in rows:
        assert row["available_at"] == expected_midnight
        assert row["available_at"] != captured_at  # never the raw scrape time
        # published_time is a STRING (matches the existing jravan_* silver
        # schema -- JV-Link bronze writes ISO strings; scrape stringifies to
        # match so the partition-aware upsert doesn't trip pyarrow's
        # type-unification). available_at stays datetime.
        assert row["published_time"] == netkeiba_http.format_provenance_iso(
            expected_midnight
        )


def test_source_name_netkeiba_stamped(tmp_path: Path) -> None:
    """Every scrape row carries source_name='netkeiba'; JV-Link rows in the same
    table stay 'jravan'. This is the provenance contract ADR-0004 requires."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()

    # JV-Link rows written directly (the licensed-feed write path). The
    # ingested_at / published_time columns are STRING-typed in the existing
    # silver schema (JV-Link bronze writes ISO strings), so hand-written
    # test rows stringify to match -- otherwise the partition-aware upsert's
    # pyarrow type-unification trips when merging with scrape rows.
    write_dataset(
        [
            {
                "race_id": RACE_ID, "horse_id": "2016101001", "horse_name": "JV Horse",
                "horse_number": 1, "gate": 1, "jockey_id": "0", "trainer_id": "0",
                "carried_weight_kg": 56.0, "body_weight_kg": 480,
                "source_name": "jravan", "source_record_id": "jv:1",
                "raw_uri": "jv://raw", "content_hash": "jvhash",
                "ingested_at": netkeiba_http.format_provenance_iso(
                    datetime(2026, 6, 21, tzinfo=timezone.utc)
                ),
                "published_time": None,
                "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
                "year": 2026, "venue": "05",
            }
        ],
        lake.silver_dataset("jravan_race_entries"),
    )
    # Scrape rows via the adapter.
    netkeiba_entries.build_entries(
        lake, NK_RACE_ID, RACE_ID,
        payload_text=_load("shutuba_202605030611.html"),
    )

    rows = read_dataset(lake.silver_dataset("jravan_race_entries"))
    by_source = {"jravan": [], "netkeiba": []}
    for r in rows:
        by_source.setdefault(r["source_name"], []).append(r)
    assert len(by_source["jravan"]) == 1, "JV-Link row should survive the upsert"
    assert len(by_source["netkeiba"]) == 16, "scrape rows should be added"
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

    # 5 JV-Link entries for race A in (2026, '05'). ingested_at stringified
    # to match the existing jravan_* silver schema (string column).
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
            "ingested_at": netkeiba_http.format_provenance_iso(
                datetime(2026, 6, 1, tzinfo=timezone.utc)
            ),
            "published_time": None,
            "available_at": datetime(2026, 6, 1, tzinfo=timezone.utc),
            "year": 2026,
            "venue": "05",
        }
        for i in range(1, 6)
    ]
    write_dataset(jv_rows, lake.silver_dataset("jravan_race_entries"))

    # 3 scrape entries for race B in the SAME (2026, '05') partition. These
    # rows mimic what the adapter produces (stringified provenance times) so
    # the merge's type-unification succeeds.
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
            "ingested_at": netkeiba_http.format_provenance_iso(
                datetime(2026, 6, 1, tzinfo=timezone.utc)
            ),
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
    """Re-ingesting an unchanged payload on the same day adds zero rows
    (dedup on natural_key + available_at). The PIT compromise's UTC-midnight
    floor is what makes this work for shutuba's no-publish-time case."""
    lake = LakePaths(root=tmp_path / "data")
    lake.ensure()
    captured = datetime(2026, 6, 19, 12, 0, tzinfo=timezone.utc)
    n1 = netkeiba_payouts.build_payouts(
        lake, "202609030411", "jra-20260614-09-11",
        payload_text=_load("result_202609030411.html"),
        captured_at=captured,
    )
    assert n1 > 0
    n2 = netkeiba_payouts.build_payouts(
        lake, "202609030411", "jra-20260614-09-11",
        payload_text=_load("result_202609030411.html"),
        captured_at=captured,  # SAME timestamp -> same floored available_at -> dedupe
    )
    assert n2 == 0, "second identical ingest on the same day should add zero rows"
    rows = read_dataset(lake.silver_dataset("jravan_payouts"))
    assert len(rows) == n1


# --- Step 5: cross-validation gate -------------------------------------------


def _write_payouts(rows: list[dict], lake: LakePaths, source: str, race_id: str, pool: str,
                   combo: str, payout: int, *, popularity: int | None = 1) -> None:
    rows.append({
        "race_id": race_id, "pool": pool, "combo": combo, "payout_yen": payout,
        "popularity": popularity, "source_name": source, "source_record_id": f"{source}:{combo}",
        "raw_uri": f"{source}://raw", "content_hash": f"{source}hash",
        # Stringified to match the existing jravan_* silver schema (string).
        "ingested_at": netkeiba_http.format_provenance_iso(
            datetime(2026, 6, 21, tzinfo=timezone.utc)
        ),
        "published_time": None,
        "available_at": datetime(2026, 6, 21, tzinfo=timezone.utc),
        "year": 2026, "venue": "05",
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
    cap = datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc)
    p1 = netkeiba_http.archive_raw(lake, "netkeiba_payouts", NK_RACE_ID, "payouts", payload, cap)
    p2 = netkeiba_http.archive_raw(lake, "netkeiba_payouts", NK_RACE_ID, "payouts", payload, cap)
    assert p1 == p2
    kind_dir = p1.parent
    payloads = sorted(kind_dir.glob("*.json"))
    assert len(payloads) == 1


def test_crosswalk_roundtrip_canonical_id_passthrough() -> None:
    """crosswalk_race_id passes canonical jra- ids through untouched and maps
    netkeiba synthetic r- ids correctly (Tokyo = jyo 05 per project mapping)."""
    assert crosswalk_race_id("jra-20260621-05-11") == "jra-20260621-05-11"
