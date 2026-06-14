"""Tests for residual odds-drift detection (polling/drift.py)."""
from keibamon_core.polling.drift import residual_edges


def _field(moves):
    """moves: {key: (open, current)} -> rows for residual_edges."""
    return [(k, cur, opn) for k, (opn, cur) in moves.items()]


def test_pool_fill_compression_is_not_flagged():
    # Whole field shortens ~30% (early pool filling). No runner stands out.
    moves = {i: (10.0, 7.0) for i in range(8)}
    assert residual_edges(_field(moves)) == {}


def test_lone_firmer_against_flat_field_flags_money_in():
    moves = {i: (10.0, 10.0) for i in range(7)}   # flat field
    moves[99] = (10.0, 6.0)                        # one horse firms hard
    edges = residual_edges(_field(moves))
    assert set(edges) == {99}
    assert edges[99].direction == "firming"
    assert edges[99].resid_pct < 0
    assert "vs field" in edges[99].label and edges[99].label.startswith("▼")


def test_lone_drifter_against_flat_field_flags_money_out():
    moves = {i: (10.0, 10.0) for i in range(7)}
    moves[99] = (10.0, 16.0)                        # one horse drifts out
    edges = residual_edges(_field(moves))
    assert set(edges) == {99}
    assert edges[99].direction == "draining"
    assert edges[99].label.startswith("▲")


def test_below_min_field_returns_nothing():
    moves = {i: (10.0, 6.0) for i in range(3)}      # too few to trust a baseline
    assert residual_edges(_field(moves)) == {}


def test_scratched_runner_excluded_from_field_and_flags():
    moves = {i: (10.0, 10.0) for i in range(7)}
    moves[5] = (999.9, 999.9)                        # scratched / no-bet
    moves[99] = (10.0, 6.0)
    edges = residual_edges(_field(moves))
    assert 5 not in edges
    assert 99 in edges


def test_statistically_big_but_tiny_move_is_ignored():
    # Field perfectly flat (scale ~0); one horse moves only ~3% -> z huge but
    # immaterial. The min_resid gate must suppress it.
    moves = {i: (10.0, 10.0) for i in range(7)}
    moves[99] = (10.0, 9.7)
    assert residual_edges(_field(moves)) == {}
