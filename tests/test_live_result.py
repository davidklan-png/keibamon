"""ADR-0007 R1+R2 — tests for ``keibamon_core.live.result.build_result``.

Pins the contract the producer emits against what
``workers/social/src/settle.ts`` (the canonical resolver) reads. The shape
is:

    { placings: [{pos, umabans}], scratched: [umabans], payouts: [{pool, combo, yen}] }

The test scenarios cover every code path in build_result:

  1. Clean race (the real 2026 宝塚記念 G1 fixture) — 18 runners, 17 with
     numeric placings, 1 中止 (DNF, no refund).
  2. Dead heat — two runners share pos=2.
  3. Scratch — 取消 / 除外 surface in `scratched`; resolver refunds.
  4. DNF (no refund) — 中止 does NOT surface in `scratched`.
  5. DQ — 失格 keeps the parsed placing (POST-ADJUDICATION order; JRA
     settles on the corrected cell int, not gate order — R2 Task 3 fix).
     5b. Demotion fixture (降着 after 審議) — tests/fixtures/r1/
     demotion_shingi_result.json; corrected order survives into placings.
  6. Pool mapping — all 8 silver pools → 6 resolver BetTypes (win/place
     dropped; bracket_quinella passes through, reformatted to dash-joined).
  7. Empty result — no placings → {} (race not official).
  8. Combo shape — dash-joined umabans, raw form preserved.
  9. Official-confirmation gate (R2 Task 1) — provisional page (placings
     but NO payouts) → {}; provisional→confirmed transition; win/place-
     only page → {} (the six-pool filter leaves payouts_out empty).
  10. gates (bracket lookup) — omitted when no finisher carries `waku`;
      two horses can share a bracket (multiset, not a set).
"""
from __future__ import annotations

from pathlib import Path

from keibamon_core.adapters.netkeiba_payouts import parse_payouts_payload
from keibamon_core.adapters.netkeiba_results import parse_results_payload
from keibamon_core.live.result import build_result

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"
FIXTURES_R1 = Path(__file__).parent / "fixtures" / "r1"


def _fixture_payload() -> str:
    return (FIXTURES / "result_202609030411.html").read_text()


# --- 1. Clean race against the real fixture -----------------------------------


def test_build_result_clean_race_from_real_fixture() -> None:
    """The 2026 宝塚記念 G1 had 18 runners, 17 with placings, 1 中止 (horse 15).
    The result block should carry 17 placings, NO scratched, and the 6 exotic
    pools the resolver supports (win/place filtered out; bracket_quinella now
    passes through, reformatted to dash-joined)."""
    payload = _fixture_payload()
    finishers = parse_results_payload(payload, "202609030411")
    payouts = parse_payouts_payload(payload, "202609030411")

    result = build_result(finishers, payouts)

    # Placings: 17 numeric positions (1..17; pos=18 absent because 中止).
    placings = result["placings"]
    assert [p["pos"] for p in placings] == list(range(1, 18))
    # Winner is umaban 16 (メイショウタバル) — verified in test_scrape_adapters.
    assert placings[0] == {"pos": 1, "umabans": [16]}
    assert placings[1] == {"pos": 2, "umabans": [5]}
    assert placings[2] == {"pos": 3, "umabans": [1]}
    # All placing entries are single-umaban lists on a clean race.
    assert all(len(p["umabans"]) == 1 for p in placings)

    # Scratched: empty (the DNF horse 15 was 中止, not 取消 — no refund).
    assert result.get("scratched", []) == []

    # Payouts: the resolver-relevant 6 pools. The fixture has 1 quinella, 3
    # wide (per pair), 1 each of exacta/trio/trifecta/bracket_quinella.
    pools = [p["pool"] for p in result["payouts"]]
    assert pools.count("quinella") == 1
    assert pools.count("wide") == 3
    assert pools.count("exacta") == 1
    assert pools.count("trio") == 1
    assert pools.count("trifecta") == 1
    assert pools.count("bracket_quinella") == 1
    # win/place still don't leak into the resolver block.
    assert not any(p in pools for p in ("win", "place"))

    # Combo shape: dash-joined umabans, FINISH ORDER for exacta/trifecta,
    # SOURCE ORDER for unordered pools (resolver canonicalizes ascending).
    quinella = next(p for p in result["payouts"] if p["pool"] == "quinella")
    assert quinella == {"pool": "quinella", "combo": "5-16", "yen": 620}

    exacta = next(p for p in result["payouts"] if p["pool"] == "exacta")
    assert exacta == {"pool": "exacta", "combo": "16-5", "yen": 1360}

    trifecta = next(p for p in result["payouts"] if p["pool"] == "trifecta")
    assert trifecta == {"pool": "trifecta", "combo": "16-5-1", "yen": 6040}

    # bracket_quinella: winner (umaban 16) is waku 8, 2nd (umaban 5) is
    # waku 3 -- reformatted from the source's concatenated "38" to "3-8".
    bracket_q = next(p for p in result["payouts"] if p["pool"] == "bracket_quinella")
    assert bracket_q == {"pool": "bracket_quinella", "combo": "3-8", "yen": 380}

    # gates: per-finisher umaban -> waku lookup, built from the real fixture.
    gates_by_umaban = {g["umaban"]: g["waku"] for g in result["gates"]}
    assert gates_by_umaban[16] == 8
    assert gates_by_umaban[5] == 3


# --- 2. Dead heat expands the placings entry ----------------------------------


def test_build_result_dead_heat_two_umabans_at_pos_2() -> None:
    """同着: two horses tied at pos=2. placings[1].umabans carries both."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 7, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": ""},
    ]
    payouts = [
        {"pool": "quinella", "combo_raw": "5-16", "payout_yen": 1840},
        {"pool": "quinella", "combo_raw": "5-7", "payout_yen": 1840},
        {"pool": "exacta", "combo_raw": "5-16", "payout_yen": 3120},
        {"pool": "exacta", "combo_raw": "5-7", "payout_yen": 3120},
    ]
    result = build_result(finishers, payouts)

    assert result["placings"] == [
        {"pos": 1, "umabans": [5]},
        {"pos": 2, "umabans": [7, 16]},  # ascending — deterministic
        {"pos": 3, "umabans": [1]},
    ]
    # Both quinella payouts land — the resolver sums all matching rows.
    quinella_yen = sum(
        p["yen"] for p in result["payouts"] if p["pool"] == "quinella"
    )
    assert quinella_yen == 1840 + 1840


# --- 3. Scratch surfaces in `scratched` and triggers resolver refund ---------


def test_build_result_scratch_markers_go_to_scratched() -> None:
    """取消 / 除外 at the gate → JRA refunds all lines touching that umaban.
    build_result must surface them so the resolver returns state:'refunded'."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": ""},
        # Two scratched at the gate:
        {"horse_number": 4, "finish_position": None, "finish_position_raw": "取消"},
        {"horse_number": 11, "finish_position": None, "finish_position_raw": "除外"},
    ]
    # One quinella row satisfies the R2 confirmation gate (審議 withholds
    # payouts; a present payout row implies the order is 確定).
    payouts = [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}]
    result = build_result(finishers, payouts)

    assert sorted(result["scratched"]) == [4, 11]
    # Scratched umabans are NOT in any placing.
    flat = {u for p in result["placings"] for u in p["umabans"]}
    assert 4 not in flat
    assert 11 not in flat


# --- 4. DNF (中止) does NOT trigger refund ------------------------------------


def test_build_result_dnf_does_not_trigger_refund() -> None:
    """A horse that started but didn't finish (中止) is NOT scratched -- JRA
    pays out on the placings as if the horse finished last. Resolver must NOT
    refund lines containing that umaban."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": ""},
        {"horse_number": 15, "finish_position": None, "finish_position_raw": "中止"},
    ]
    # Quinella row passes the R2 confirmation gate; DNF behavior is orthogonal.
    result = build_result(finishers, [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}])

    # The DNF horse is NOT in scratched -- no refund.
    assert result.get("scratched", []) == []
    # ...and NOT in any placing (it didn't place).
    flat = {u for p in result["placings"] for u in p["umabans"]}
    assert 15 not in flat


# --- 5. DQ (失格) / 降着 keep the post-adjudication placing -------------------


def test_build_result_dq_keeps_post_adjudication_placing() -> None:
    """失格 (disqualified post-race): JRA settles tickets on the
    POST-ADJUDICATION order, not the gate order. netkeiba's 着順 cell shows
    the corrected int position; the parser reads it through unchanged.
    (R1 originally documented this as "gate order" — corrected in R2 Task 3.)
    Here horse 1's cell shows pos=3 (the post-DQ position) with the 失格
    marker in finish_position_raw; build_result must carry pos=3 into
    `placings` and NOT treat it as a scratch."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": "失格"},
    ]
    result = build_result(finishers, [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}])

    # Horse 1 carries pos=3 — the post-adjudication position the cell shows.
    pos3 = next(p for p in result["placings"] if p["pos"] == 3)
    assert pos3 == {"pos": 3, "umabans": [1]}
    # DQ is NOT a scratch.
    assert result.get("scratched", []) == []


def test_build_result_demotion_fixture_produces_corrected_placings() -> None:
    """Realistic 降着 (demotion after 審議) scenario, fixture-driven. Horse 7
    crossed 1st but impeded horse 3 in the stretch; stewards demote 7 to 2nd
    (降着) and promote 3 to 1st. JRA settles tickets on the POST-ADJUDICATION
    order, so:

      - quinella pays on 3-7 (the corrected top-2 unordered)
      - exacta pays on 3-7 (3 first, 7 second — the corrected finish order)
      - trifecta pays on 3-7-11

    The producer carries the corrected positions into `placings`, and the
    demoted horse (umaban 7) stays at pos=2 with its 降着 marker — NOT moved
    to scratched. This verifies R2 Task 3's correction of R1 v1's "gate
    order" docstring claim. Reads the expected output from
    tests/fixtures/r1/demotion_shingi_result.json.

    Verification gap: the fixture is SYNTHETIC — constructed from JRA rule
    semantics. The result.html parser was not re-verified against a real
    降着 result.html capture; a real page may format the Rank cell
    differently (bare int, '2(降)' suffix, separate annotation column).
    See DATA_TRAPS['result_block.dq_post_adjudication_verification_gap'].
    """
    import json

    fixture_path = FIXTURES_R1 / "demotion_shingi_result.json"
    expected = json.loads(fixture_path.read_text())

    # Parser output: demoted horse carries corrected position (2) + 降着 marker.
    finishers = [
        {"horse_number": 3, "finish_position": 1, "finish_position_raw": ""},       # promoted from 2nd
        {"horse_number": 7, "finish_position": 2, "finish_position_raw": "降着"},    # demoted from 1st
        {"horse_number": 11, "finish_position": 3, "finish_position_raw": ""},
        # Other finishers (4th-8th) omitted — beyond top-3, don't affect placings.
    ]
    # Payouts reflect the corrected order; build_result passes them through.
    payouts = [
        {"pool": "quinella", "combo_raw": "3-7", "payout_yen": 620},
        {"pool": "wide", "combo_raw": "3-7", "payout_yen": 260},
        {"pool": "wide", "combo_raw": "3-11", "payout_yen": 340},
        {"pool": "wide", "combo_raw": "7-11", "payout_yen": 410},
        {"pool": "exacta", "combo_raw": "3-7", "payout_yen": 1360},
        {"pool": "trio", "combo_raw": "3-7-11", "payout_yen": 1230},
        {"pool": "trifecta", "combo_raw": "3-7-11", "payout_yen": 6040},
    ]
    result = build_result(finishers, payouts)

    # Placings match the fixture's expected output (post-adjudication order).
    assert result["placings"] == expected["placings"]
    # Payouts pass through verbatim.
    assert result["payouts"] == expected["payouts"]
    # 降着 is NOT a scratch — JRA settles on the corrected order, not a refund.
    assert result.get("scratched", []) == []
    # Specifically: the demoted horse stays at pos=2.
    pos2 = next(p for p in result["placings"] if p["pos"] == 2)
    assert pos2 == {"pos": 2, "umabans": [7]}


# --- 6. Pool mapping drops win/place, passes bracket_quinella through --------


def test_build_result_pool_mapping_drops_unsupported_pools() -> None:
    """The resolver handles 6 exotic BetTypes (as of bracket_quinella support).
    win/place must be filtered out of the payouts block (the resolver ignores
    them anyway, but keeping the block tight avoids downstream confusion).
    bracket_quinella now passes through too, reformatted to dash-joined."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
    ]
    payouts = [
        {"pool": "win", "combo_raw": "5", "payout_yen": 390},
        {"pool": "place", "combo_raw": "5", "payout_yen": 130},
        {"pool": "place", "combo_raw": "16", "payout_yen": 210},
        {"pool": "bracket_quinella", "combo_raw": "38", "payout_yen": 1190},
        {"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620},
        {"pool": "wide", "combo_raw": "5-16", "payout_yen": 260},
        {"pool": "exacta", "combo_raw": "5-16", "payout_yen": 1360},
        {"pool": "trio", "combo_raw": "1-5-16", "payout_yen": 1230},
        {"pool": "trifecta", "combo_raw": "5-16-1", "payout_yen": 6040},
    ]
    result = build_result(finishers, payouts)

    pools = [p["pool"] for p in result["payouts"]]
    assert set(pools) == {
        "quinella",
        "wide",
        "exacta",
        "trio",
        "trifecta",
        "bracket_quinella",
    }
    assert "win" not in pools
    assert "place" not in pools

    # bracket_quinella's combo is reformatted from concatenated "38" to
    # dash-joined "3-8" -- see module docstring for why this reformat lives
    # here rather than in netkeiba_payouts.
    bracket_q = next(p for p in result["payouts"] if p["pool"] == "bracket_quinella")
    assert bracket_q == {"pool": "bracket_quinella", "combo": "3-8", "yen": 1190}


# --- 7. Empty result when no placings ----------------------------------------


def test_build_result_empty_when_race_not_yet_official() -> None:
    """If the parser couldn't extract any placings (race not yet run, under
    審議, or page parse failed), the producer must OMIT the result key from
    the race dict. build_result signals that with an empty dict."""
    finishers: list[dict] = []  # nothing parsed
    result = build_result(finishers, [])
    assert result == {}

    # Even with payouts present, no placings → empty.
    result = build_result([], [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}])
    assert result == {}


def test_build_result_omits_scratched_key_when_empty() -> None:
    """When no scratches, the `scratched` key is omitted entirely (not []) so
    the JSON block stays tight. The resolver uses `result.scratched ?? []`."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
    ]
    result = build_result(finishers, [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}])
    assert "scratched" not in result


# --- 8. Combo shape preserved verbatim from the source -----------------------


def test_build_result_combo_shape_preserves_source_order() -> None:
    """The resolver canonicalizes unordered pools to ascending on its own
    (settle.ts:comboKey). The producer passes the source's dash-joined form
    through verbatim -- including exacta/trifecta finish order, which the
    resolver MUST NOT reorder."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": ""},
    ]
    payouts = [
        # Unordered pools: source order irrelevant (resolver sorts).
        {"pool": "quinella", "combo_raw": "16-5", "payout_yen": 620},
        {"pool": "trio", "combo_raw": "16-5-1", "payout_yen": 1230},
        # Ordered pools: source order is the FINISH order.
        {"pool": "exacta", "combo_raw": "5-16", "payout_yen": 1360},
        {"pool": "trifecta", "combo_raw": "5-16-1", "payout_yen": 6040},
    ]
    result = build_result(finishers, payouts)
    by_pool = {p["pool"]: p for p in result["payouts"]}
    # Quinella: source '16-5' passed through; resolver canonicalizes.
    assert by_pool["quinella"]["combo"] == "16-5"
    # Exacta: source '5-16' (1st-2nd) passed through verbatim.
    assert by_pool["exacta"]["combo"] == "5-16"
    # Trifecta: source '5-16-1' (1st-2nd-3rd) passed through verbatim.
    assert by_pool["trifecta"]["combo"] == "5-16-1"


# --- 9. Official-confirmation gate (R2 Task 1) --------------------------------
#
# JRA withholds exotic payouts until the order is 確定. netkeiba's static
# result.html carries NO 確定 vs 審議 status marker (it's stamped by
# client-side JS at runtime -- verified against the 4886-line
# result_202609030411.html fixture). So "non-empty payouts_out" is the
# only available proxy for 確定. build_result returns {} while payouts are
# absent, even if provisional placings parsed cleanly.


def test_build_result_provisional_page_returns_empty() -> None:
    """審議 page: finishers have provisional placings, but no payouts
    published. build_result must return {} so the producer omits the
    result block; race stays "open" until the next cycle sees confirmed
    payouts. Without this gate, a ticket could settle to "won", get
    shared as a HIT card, and have its placings overturned on
    adjudication."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": ""},
    ]
    # No payouts — JRA withholds them while the order is provisional.
    # (In the wire format, the Payout_Detail_Table blocks would be absent
    # and parse_payouts_payload returns [].)
    result = build_result(finishers, [])
    assert result == {}


def test_build_result_win_place_payouts_only_returns_empty() -> None:
    """A page that published only win/place (Tansho/Fukusho) payouts but
    NONE of the five resolver-relevant exotics returns {}. Two cases:

      1. Field-size cancellation: JRA doesn't offer trio/trifecta on small
         fields (≤4 declared), and a mass-scratch fiasco can cancel the
         whole exotic card. Safe: the resolver has nothing to settle.
      2. A parser bug that missed the exotic Payout_Detail_Table blocks.
         Safe: same outcome (no attach) — race stays "open" until the
         parser is fixed.

    Either way, no payouts_out ⟹ no attach.
    """
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
    ]
    # Only win/place rows — both filtered out by the resolver BetType gate.
    payouts = [
        {"pool": "win", "combo_raw": "5", "payout_yen": 390},
        {"pool": "place", "combo_raw": "5", "payout_yen": 130},
        {"pool": "place", "combo_raw": "16", "payout_yen": 210},
    ]
    result = build_result(finishers, payouts)
    assert result == {}


def test_build_result_provisional_then_confirmed_transition() -> None:
    """The same race across two publish cycles. Cycle 1: provisional
    placings parsed, but payouts absent (審議) → {}. Cycle 2: payouts now
    published (確定) → full block. Idempotent overwrite: the producer
    re-publishes under key='current', so the cycle-2 block cleanly
    replaces the cycle-1 absence. The resolver never sees a provisional
    block."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": ""},
    ]
    quinella = {"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}

    # Cycle 1: provisional (審議) — no payouts published yet.
    cycle1 = build_result(finishers, [])
    assert cycle1 == {}

    # Cycle 2: confirmed (確定) — payouts now present.
    cycle2 = build_result(finishers, [quinella])
    assert cycle2["placings"] == [
        {"pos": 1, "umabans": [5]},
        {"pos": 2, "umabans": [16]},
        {"pos": 3, "umabans": [1]},
    ]
    assert cycle2["payouts"] == [{"pool": "quinella", "combo": "5-16", "yen": 620}]
    # Scratched key still omitted when empty.
    assert "scratched" not in cycle2


# --- 10. gates (bracket lookup for bracket_quinella) --------------------------


def test_build_result_omits_gates_key_when_no_waku_present() -> None:
    """Inline test fixtures across this file don't carry `waku` (it was added
    to netkeiba_results after this suite existed). build_result must omit the
    `gates` key entirely rather than emit an empty list, matching the
    `scratched` "omit when empty" pattern -- older callers/fixtures without
    bracket data must not break."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
    ]
    result = build_result(finishers, [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}])
    assert "gates" not in result


def test_build_result_gates_allows_two_horses_sharing_a_bracket() -> None:
    """Brackets are a many-to-one grouping over horse numbers -- JRA packs
    16-18 horses into 8 brackets, so two DIFFERENT horses can share the same
    waku. `gates` must preserve this as a per-umaban lookup (a dict/multiset
    shape), NOT collapse to a set of brackets, or the resolver couldn't tell
    which specific horses are in waku 3."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": "", "waku": 3},
        {"horse_number": 6, "finish_position": 2, "finish_position_raw": "", "waku": 3},
        {"horse_number": 16, "finish_position": 3, "finish_position_raw": "", "waku": 8},
    ]
    payouts = [{"pool": "bracket_quinella", "combo_raw": "38", "payout_yen": 1190}]
    result = build_result(finishers, payouts)

    gates_by_umaban = {g["umaban"]: g["waku"] for g in result["gates"]}
    assert gates_by_umaban == {5: 3, 6: 3, 16: 8}
    # Both horse 5 and horse 6 map to waku 3 -- confirms the lookup is keyed
    # by umaban, not deduplicated by waku.
    assert len(result["gates"]) == 3

    bracket_q = next(p for p in result["payouts"] if p["pool"] == "bracket_quinella")
    assert bracket_q == {"pool": "bracket_quinella", "combo": "3-8", "yen": 1190}


def test_build_result_gates_partial_waku_coverage() -> None:
    """If only some finishers carry `waku` (e.g. a parser upgrade mid-season,
    or a finisher dict built by older code), build_result includes gates only
    for the ones that have it -- it does not require all-or-nothing."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": "", "waku": 3},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},  # no waku
    ]
    result = build_result(finishers, [{"pool": "quinella", "combo_raw": "5-16", "payout_yen": 620}])
    assert result["gates"] == [{"umaban": 5, "waku": 3}]
