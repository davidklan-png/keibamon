"""Tests for the Milestone-4 form/context marts (``keibamon_core.marts.form``).

Pins the correctness invariants the lookup panel relies on:

- horse identity is the normalized NAME, never ``horse_id`` (the
  ``'0000000000'`` placeholder is non-unique -- two different horses share it
  and must NOT be merged);
- the point-in-time filter excludes the target race and anything after it
  (``available_at < as_of``), so a future win never leaks into "form to date";
- the pure card builders degrade to ``no_history`` instead of erroring.

Silver fixtures mirror ``test_marts.py``: Hive-partitioned ``jravan_*`` tables
written via ``write_dataset``.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("pyarrow")
pytest.importorskip("duckdb")

from keibamon_core.lake import read_parquet, write_dataset
from keibamon_core.lake_query import query as lake_query
from keibamon_core.marts import (
    HORSE_FORM_MART,
    JOCKEY_FORM_MART,
    build_form_marts,
    build_horse_card,
    build_jockey_card,
    distance_band,
    normalize_name,
    style_signal,
)
from keibamon_core.paths import LakePaths

# Race ids / times. Venue "05" = Tokyo (project's JYO_CODES).
_R0 = "jra-20260520-05-01"  # Alpha prior
_R1 = "jra-20260601-05-01"  # Alpha prior
_R2 = "jra-20260608-05-01"  # Beta (different horse, SAME placeholder id)
_R3 = "jra-20260628-05-11"  # target G3 (upcoming -- no result yet)
_R4 = "jra-20260710-05-01"  # Alpha FUTURE win -- must be PIT-excluded
_POST = datetime(2026, 6, 1, 6, 0, tzinfo=timezone.utc)  # 15:00 JST


def _part(rid: str) -> tuple[int, str]:
    parts = rid.split("-")
    return int(parts[1][:4]), parts[2]


def _race_row(rid: str, *, post: datetime, grade_code: str | None = None,
              distance: int = 2000, surface: str = "turf", wetness: int = 1) -> dict[str, Any]:
    return {
        "race_id": rid,
        "race_date": post.replace(hour=0, minute=0),
        "racecourse": "Tokyo",
        "country": "JP",
        "surface": surface,
        "distance_m": distance,
        "scheduled_post_time": post,
        "race_name": f"race-{rid}",
        "grade_code": grade_code,
        "last_3f_seconds": 34.0,
        "weather": "fine",
        "going_turf": "good",
        "going_dirt": None,
        "going_wetness": wetness,
        "going": "good",
        "source_name": "jravan",
        "source_record_id": f"RA:{rid}",
        "raw_uri": f"bronze/{rid}.dat",
        "content_hash": f"h-race-{rid}",
        "ingested_at": post,
        "published_time": post,
        "available_at": post,
        "year": _part(rid)[0],
        "venue": _part(rid)[1],
    }


def _entry_row(rid: str, horse_no: int, *, name: str, jockey: str,
               trainer: str = "t1") -> dict[str, Any]:
    return {
        "race_id": rid,
        # NOTE: horse_id is the '0000000000' placeholder for BOTH horses below
        # to prove the name-key grouping. Never used as the horse key.
        "horse_id": "0000000000",
        "horse_name": name,
        "horse_number": horse_no,
        "gate": horse_no,
        "jockey_id": jockey,
        "trainer_id": trainer,
        "carried_weight_kg": 57,
        "body_weight_kg": 480,
        "source_name": "jravan",
        "source_record_id": f"SE:{rid}:{horse_no}",
        "raw_uri": f"bronze/{rid}.dat",
        "content_hash": f"h-e-{rid}-{horse_no}",
        "ingested_at": _POST,
        "published_time": _POST,
        "available_at": _POST,
        "year": _part(rid)[0],
        "venue": _part(rid)[1],
    }


def _result_row(rid: str, horse_no: int, *, pos: int, last_3f: float = 33.5,
                pop: int = 1, win_odds: float = 3.0, available: datetime = _POST) -> dict[str, Any]:
    return {
        "race_id": rid,
        "horse_id": "0000000000",
        "horse_number": horse_no,
        "finish_position": pos,
        "finish_time_seconds": 95.0,
        "margin": "1",
        "win_odds": win_odds,
        "popularity": pop,
        "last_3f_seconds": last_3f,
        "source_name": "jravan",
        "source_record_id": f"SE:{rid}:{horse_no}",
        "raw_uri": f"bronze/{rid}.dat",
        "content_hash": f"h-r-{rid}-{horse_no}",
        "ingested_at": available,
        "published_time": available,
        "available_at": available,
        "year": _part(rid)[0],
        "venue": _part(rid)[1],
    }


def _write_silver(lake: LakePaths) -> None:
    races = [
        _race_row(_R0, post=datetime(2026, 5, 20, 6, tzinfo=timezone.utc), distance=1600),
        _race_row(_R1, post=datetime(2026, 6, 1, 6, tzinfo=timezone.utc), distance=2000, wetness=3),
        _race_row(_R2, post=datetime(2026, 6, 8, 6, tzinfo=timezone.utc), distance=2400),
        _race_row(_R3, post=datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc),
                  grade_code="C", distance=2000),  # G3 target (no result)
        _race_row(_R4, post=datetime(2026, 7, 10, 6, tzinfo=timezone.utc), distance=2000),
    ]
    # Alpha runs R0, R1, R3 (upcoming), R4. Beta runs R2. Same placeholder id.
    entries = [
        _entry_row(_R0, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry_row(_R1, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry_row(_R3, 1, name="Alpha", jockey="j02", trainer="tA"),  # upcoming
        _entry_row(_R4, 1, name="Alpha", jockey="j01", trainer="tA"),
        _entry_row(_R2, 3, name="Beta", jockey="j01", trainer="tB"),
        # field-size filler so R1 has a real field (2 entries)
        _entry_row(_R1, 2, name="Gamma", jockey="j03", trainer="tC"),
    ]
    results = [
        _result_row(_R0, 1, pos=2, last_3f=33.0, pop=2, win_odds=4.0,
                    available=datetime(2026, 5, 20, 6, tzinfo=timezone.utc)),
        _result_row(_R1, 1, pos=1, last_3f=33.5, pop=1, win_odds=2.5,
                    available=datetime(2026, 6, 1, 6, tzinfo=timezone.utc)),
        _result_row(_R1, 2, pos=2, last_3f=34.0, pop=2, win_odds=6.0,
                    available=datetime(2026, 6, 1, 6, tzinfo=timezone.utc)),
        _result_row(_R2, 3, pos=3, last_3f=34.5, pop=5, win_odds=15.0,
                    available=datetime(2026, 6, 8, 6, tzinfo=timezone.utc)),
        # R4 is a FUTURE Alpha win -- must be PIT-excluded for an as_of at R3.
        _result_row(_R4, 1, pos=1, last_3f=33.2, pop=1, win_odds=1.8,
                    available=datetime(2026, 7, 10, 6, tzinfo=timezone.utc)),
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))


@pytest.fixture
def lake(tmp_path: Path) -> LakePaths:
    lake = LakePaths(root=tmp_path)
    _write_silver(lake)
    return lake


# --- pure helpers ----------------------------------------------------------


def test_normalize_name_collapses_variants():
    # NFKC maps full-width alphanumerics/digits to ASCII; spaces dropped.
    assert normalize_name("Ａｌｐｈａ") == "Alpha"
    assert normalize_name(" Alpha　Bold ") == "AlphaBold"  # ideographic space -> NFKC
    assert normalize_name(None) is None
    assert normalize_name("   ") is None


def test_distance_band_thresholds():
    assert distance_band(1200) == "sprint"
    assert distance_band(1600) == "mile"
    assert distance_band(2000) == "intermediate"
    assert distance_band(3000) == "staying"
    assert distance_band(None) is None


def test_style_signal_is_a_labelled_proxy():
    # closed fast (rank 1) + won -> presser; closed fast + out of top3 -> deep_closer
    assert style_signal(1, 1, 16) == "presser"
    assert style_signal(5, 1, 16) == "deep_closer"
    # didn't close but ran top 2 -> speed (forward)
    assert style_signal(2, 12, 16) == "speed"
    # midpack
    assert style_signal(6, 8, 16) == "pace_following"
    assert style_signal(None, 1, 16) is None  # no finish -> no label


# --- mart build + identity trap --------------------------------------------


def test_build_form_marts_writes_both_marts_with_expected_shape(lake):
    counts = build_form_marts(lake)
    # 5 completed starts total (R0,R1x2,R2,R4). R3 has no result -> excluded.
    assert counts[HORSE_FORM_MART] == 5
    assert counts[JOCKEY_FORM_MART] == 5  # all have jockey_id

    horse = read_parquet(lake.mart(HORSE_FORM_MART))
    cols = set(horse[0].keys())
    # horse_id is deliberately ABSENT so it can never be used as the horse key.
    assert "horse_id" not in cols
    assert "horse_name_key" in cols
    assert "jockey_id" in cols  # handy cross-ref, not a key
    assert "style_signal" in cols and "beat_market" in cols


def test_horse_form_groups_by_name_not_horse_id_placeholder(lake):
    """Both horses carry horse_id='0000000000'; they MUST stay separate."""
    build_form_marts(lake)
    horse = read_parquet(lake.mart(HORSE_FORM_MART))
    by_key: dict[str, list] = {}
    for r in horse:
        by_key.setdefault(r["horse_name_key"], []).append(r)
    # The point: two different horses sharing horse_id='0000000000' stay
    # SEPARATE because identity is horse_name_key, not horse_id. (Gamma is the
    # R1 field-filler; its presence is fine and unrelated to the trap.)
    assert {"Alpha", "Beta"} <= set(by_key)
    assert len(by_key["Alpha"]) == 3  # R0, R1, R4 (R3 upcoming -> excluded)
    assert len(by_key["Beta"]) == 1   # R2 only


# --- duplicate-result dedup regression (verifier finding 2026-06-25) --------
#
# Silver jravan_race_results has ~1,500 dup (race_id, horse_number) groups
# (re-ingestion with different content_hash; cross-source jravan+netkeiba
# writes). Joining raw inflated career.starts / wins / top3 in the panel.
# These tests pin the dedup invariant + the NULL-finish off-by-one fix.


def test_mart_invariant_no_duplicate_pairs(lake):
    """Every (horse_name_key, race_id) appears exactly once in horse_form;
    every (jockey_id, race_id, horse_number) appears once in jockey_form.

    Pins the dedup invariant so a future join change can't reintroduce the
    double-count. Note: (jockey_id, race_id) alone is NOT unique — the
    placeholder jockey_id='00000' (DATA_TRAPS sibling of horse_id
    '0000000000') legitimately appears on multiple horses in the same race
    when entries lack a real jockey, and a real jockey substitution is
    possible. The unique-per-start key is (jockey_id, race_id, horse_number)."""
    from collections import Counter

    build_form_marts(lake)
    horse = read_parquet(lake.mart(HORSE_FORM_MART))
    jockey = read_parquet(lake.mart(JOCKEY_FORM_MART))

    hcounts = Counter((r["horse_name_key"], r["race_id"]) for r in horse if r.get("horse_name_key"))
    hdups = {k: v for k, v in hcounts.items() if v > 1}
    assert not hdups, (
        f"horse_form has {len(hdups)} duplicated (horse_name_key, race_id) "
        f"pairs; sample: {list(hdups.items())[:3]}"
    )

    jcounts = Counter(
        (r["jockey_id"], r["race_id"], r["horse_number"])
        for r in jockey
        if r.get("jockey_id")
    )
    jdups = {k: v for k, v in jcounts.items() if v > 1}
    assert not jdups, (
        f"jockey_form has {len(jdups)} duplicated (jockey_id, race_id, "
        f"horse_number) triples; sample: {list(jdups.items())[:3]}"
    )


def test_dedup_results_collapses_duplicate_result_rows(tmp_path: Path):
    """Golden dup fixture: a race whose results row was ingested twice
    (different content_hash + available_at — the re-ingestion signature)
    must count as ONE start, not two. Both rows agree it was a win; the
    mart should report 1 start / 1 win / 100%."""
    lake = LakePaths(root=tmp_path)
    lake.ensure()
    rid = "jra-20260601-05-01"
    post = datetime(2026, 6, 1, 6, tzinfo=timezone.utc)
    races = [_race_row(rid, post=post)]
    entries = [_entry_row(rid, 1, name="Dup", jockey="j99")]
    base = _result_row(rid, 1, pos=1, available=post, pop=1, win_odds=2.0)
    results = [
        base,
        # Re-ingestion: same payload, different content_hash + later available_at.
        {**base, "content_hash": "h-r-DUP2", "available_at": post.replace(hour=7)},
    ]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))

    counts = build_form_marts(lake)
    assert counts[HORSE_FORM_MART] == 1, (
        "duplicate result rows must collapse to 1 start in horse_form"
    )

    horse = read_parquet(lake.mart(HORSE_FORM_MART))
    assert len(horse) == 1
    only = horse[0]
    assert only["horse_name_key"] == "Dup"
    assert only["race_id"] == rid
    assert only["finish_position"] == 1

    card = build_horse_card(horse, horse_name="Dup", as_of=None)
    assert card["status"] == "ok"
    assert card["career"]["starts"] == 1
    assert card["career"]["wins"] == 1
    assert card["career"]["win_pct"] == 1.0


def test_null_finish_position_still_counts_as_start(tmp_path: Path):
    """A result row with finish_position=None represents a real start whose
    official finish wasn't recorded (the off-by-one drop case for
    ダノンデサイル race jra-20240414-06-11). The mart must include it so
    career.starts matches silver truth; wins/top3 degrade to 0 for that
    start, and style_signal returns None."""
    lake = LakePaths(root=tmp_path)
    lake.ensure()
    rid = "jra-20260601-05-01"
    post = datetime(2026, 6, 1, 6, tzinfo=timezone.utc)
    races = [_race_row(rid, post=post)]
    entries = [_entry_row(rid, 1, name="Unresulted", jockey="j99")]
    results = [{**_result_row(rid, 1, pos=1, available=post), "finish_position": None}]
    write_dataset(races, lake.silver_dataset("jravan_races"))
    write_dataset(entries, lake.silver_dataset("jravan_race_entries"))
    write_dataset(results, lake.silver_dataset("jravan_race_results"))

    counts = build_form_marts(lake)
    assert counts[HORSE_FORM_MART] == 1, (
        "null-finish result must still land in horse_form as a start"
    )

    horse = read_parquet(lake.mart(HORSE_FORM_MART))
    assert len(horse) == 1
    assert horse[0]["finish_position"] is None
    assert horse[0]["style_signal"] is None  # degrades cleanly
    assert horse[0]["beat_market"] is None

    card = build_horse_card(horse, horse_name="Unresulted", as_of=None)
    assert card["status"] == "ok"
    assert card["career"]["starts"] == 1   # counted as a start
    assert card["career"]["wins"] == 0     # but NOT as a win
    assert card["career"]["top3"] == 0
    assert card["career"]["win_pct"] == 0.0   # _pct(0, 1) -> 0.0 (None only when starts=0)
    assert card["career"]["top3_pct"] == 0.0


# --- point-in-time read path -----------------------------------------------


def _pit_card(lake: LakePaths, name: str, as_of: datetime) -> dict:
    """Mirror the API read: PIT-filter the mart, then build the card."""
    rows = lake_query(
        "SELECT * FROM {m} WHERE horse_name_key = ? AND available_at < ? "
        "ORDER BY available_at DESC",
        params=[normalize_name(name), as_of], m=lake.mart(HORSE_FORM_MART),
    ).to_pylist()
    return build_horse_card(rows, horse_name=name, as_of=as_of.isoformat())


def test_pit_filter_excludes_target_race_and_future(lake):
    build_form_marts(lake)
    # as_of = the G3 target's (R3) post time. Alpha's form-to-date excludes R3
    # itself (no result anyway) AND the future R4 win -> only R1 + R0 remain.
    card = _pit_card(lake, "Alpha", datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc))
    assert card["status"] == "ok"
    assert card["career"]["starts"] == 2  # R0 + R1, NOT R4
    dates = [r["available_at"] for r in card["recent_finishes"]]
    assert all(d < datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc) for d in dates)
    # the future R4 win (2026-07-10) must NOT appear anywhere in the card
    assert all("2026-07-10" not in (str(d) or "") for d in dates)


def test_pit_filter_as_of_before_any_starts_is_no_history(lake):
    build_form_marts(lake)
    card = _pit_card(lake, "Alpha", datetime(2020, 1, 1, tzinfo=timezone.utc))
    assert card["status"] == "no_history"


def test_horse_card_content_and_guardrail_copy(lake):
    build_form_marts(lake)
    card = _pit_card(lake, "Alpha", datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc))
    # splits populated
    assert "turf" in card["by_surface"]
    assert card["by_wet"]["wet"]["starts"] == 1  # R1 was wetness=3 (wet)
    # style profile over recent starts
    assert sum(card["style_profile"].values()) >= 1
    # context copy present, no banned "lock/guarantee" language
    assert "not betting advice" in card["context_note"].lower()


# --- jockey card -----------------------------------------------------------


def test_jockey_card_combos_and_no_history(lake):
    build_form_marts(lake)
    rows = lake_query(
        "SELECT * FROM {m} WHERE jockey_id = ? AND available_at < ? "
        "ORDER BY available_at DESC",
        params=["j01", datetime(2026, 6, 28, 6, 30, tzinfo=timezone.utc)],
        m=lake.mart(JOCKEY_FORM_MART),
    ).to_pylist()
    card = build_jockey_card(rows, jockey_id="j01", as_of="2026-06-28T15:30:00+09:00")
    assert card["status"] == "ok"
    # j01 rode Alpha twice (R0,R1) and Beta once (R2) within the PIT window
    assert card["career"]["starts"] == 3
    horse_combo = {c.get("horse_name_key"): c for c in card["combos"]["by_horse"]}
    assert horse_combo["Alpha"]["starts"] == 2
    assert horse_combo["Beta"]["starts"] == 1
    # trainer combo: tA (Alpha x2) and tB (Beta)
    trainers = {c["trainer_id"]: c for c in card["combos"]["by_trainer"]}
    assert trainers["tA"]["starts"] == 2
    assert trainers["tB"]["starts"] == 1

    # empty PIT window -> no_history, never an error
    empty = build_jockey_card([], jockey_id="zzz", as_of=None)
    assert empty["status"] == "no_history"
