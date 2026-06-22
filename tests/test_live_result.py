"""ADR-0007 R1 — tests for ``keibamon_core.live.result.build_result``.

Pins the contract the producer emits against what
``workers/social/src/settle.ts`` (the canonical resolver) reads. The shape
is:

    { placings: [{pos, umabans}], scratched: [umabans], payouts: [{pool, combo, yen}] }

The five test scenarios cover every code path in build_result:

  1. Clean race (the real 2026 宝塚記念 G1 fixture) — 18 runners, 17 with
     numeric placings, 1 中止 (DNF, no refund).
  2. Dead heat — two runners share pos=2.
  3. Scratch — 取消 / 除外 surface in `scratched`; resolver refunds.
  4. DNF (no refund) — 中止 does NOT surface in `scratched`.
  5. DQ — 失格 keeps the parsed placing (gate order; JRA pays at gate).
  6. Pool mapping — all 8 silver pools → 5 resolver BetTypes.
  7. Empty result — no placings → {} (race not official).
  8. Combo shape — dash-joined umabans, raw form preserved.
"""
from __future__ import annotations

from pathlib import Path

from keibamon_core.adapters.netkeiba_payouts import parse_payouts_payload
from keibamon_core.adapters.netkeiba_results import parse_results_payload
from keibamon_core.live.result import build_result

FIXTURES = Path(__file__).parent / "fixtures" / "netkeiba"


def _fixture_payload() -> str:
    return (FIXTURES / "result_202609030411.html").read_text()


# --- 1. Clean race against the real fixture -----------------------------------


def test_build_result_clean_race_from_real_fixture() -> None:
    """The 2026 宝塚記念 G1 had 18 runners, 17 with placings, 1 中止 (horse 15).
    The result block should carry 17 placings, NO scratched, and the 5 exotic
    pools the resolver supports (win/place/bracket_quinella filtered out)."""
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

    # Payouts: the resolver-relevant 5 pools. The fixture has 1 quinella, 3
    # wide (per pair), 1 each of exacta/trio/trifecta.
    pools = [p["pool"] for p in result["payouts"]]
    assert pools.count("quinella") == 1
    assert pools.count("wide") == 3
    assert pools.count("exacta") == 1
    assert pools.count("trio") == 1
    assert pools.count("trifecta") == 1
    # No win/place/bracket_quinella leaks into the resolver block.
    assert not any(p in pools for p in ("win", "place", "bracket_quinella"))

    # Combo shape: dash-joined umabans, FINISH ORDER for exacta/trifecta,
    # SOURCE ORDER for unordered pools (resolver canonicalizes ascending).
    quinella = next(p for p in result["payouts"] if p["pool"] == "quinella")
    assert quinella == {"pool": "quinella", "combo": "5-16", "yen": 620}

    exacta = next(p for p in result["payouts"] if p["pool"] == "exacta")
    assert exacta == {"pool": "exacta", "combo": "16-5", "yen": 1360}

    trifecta = next(p for p in result["payouts"] if p["pool"] == "trifecta")
    assert trifecta == {"pool": "trifecta", "combo": "16-5-1", "yen": 6040}


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
    payouts: list[dict] = []
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
    result = build_result(finishers, [])

    # The DNF horse is NOT in scratched -- no refund.
    assert result.get("scratched", []) == []
    # ...and NOT in any placing (it didn't place).
    flat = {u for p in result["placings"] for u in p["umabans"]}
    assert 15 not in flat


# --- 5. DQ (失格) keeps the gate-order placing -------------------------------


def test_build_result_dq_keeps_gate_order_placing() -> None:
    """失格 (disqualified post-race) keeps the original gate-order placing for
    ticket settlement (JRA pays at gate, then applies DQ penalties separately).
    The parsed int placing MUST survive into `placings`."""
    finishers = [
        {"horse_number": 5, "finish_position": 1, "finish_position_raw": ""},
        {"horse_number": 16, "finish_position": 2, "finish_position_raw": ""},
        {"horse_number": 1, "finish_position": 3, "finish_position_raw": "失格"},
    ]
    result = build_result(finishers, [])

    # Horse 1 keeps pos=3 — placings stand at gate order.
    pos3 = next(p for p in result["placings"] if p["pos"] == 3)
    assert pos3 == {"pos": 3, "umabans": [1]}
    # DQ is NOT a scratch.
    assert result.get("scratched", []) == []


# --- 6. Pool mapping drops win/place/bracket_quinella ------------------------


def test_build_result_pool_mapping_drops_unsupported_pools() -> None:
    """The resolver only handles the 5 exotic BetTypes. win/place/bracket_quinella
    must be filtered out of the payouts block (the resolver ignores them anyway,
    but keeping the block tight avoids downstream confusion)."""
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
    assert set(pools) == {"quinella", "wide", "exacta", "trio", "trifecta"}
    assert "win" not in pools
    assert "place" not in pools
    assert "bracket_quinella" not in pools


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
    result = build_result(finishers, [])
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
