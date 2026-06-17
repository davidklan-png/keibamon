"""Harville / Henery / Stern ordering models for exotic-pool mispricing tests.

The JRA win pool is the source of truth for per-horse probabilities (de-vigged
within race). To price the exotic pools (exacta, quinella, wide, trio,
trifecta, bracket_quinella) we project the win probs through an
ordered-finishing assumption and ask whether the model disagrees with quoted
exotic prices enough to clear the higher exotic takeout. **No new fundamental
factor is under test** -- the only edge source is cross-pool mispricing.

Math direction (the textbook gotcha)
------------------------------------
- **Harville (1973)**: ``P(k-th = j | top k-1 = S) = p_j / sum_{m not in S} p_m``.
  gamma = 1.
- **Henery/Stern single-gamma**:
  ``P(k-th = j | top k-1 = S) = p_j ** gamma / sum_{m not in S} p_m ** gamma``.
  - gamma < 1  => longshots finish 2nd/3rd MORE often than Harville predicts,
    favorites LESS often (the known Harville failure; Harville over-states
    how often a losing favorite still places. Henery 1981 finds
    gamma ~ 0.76-0.86 in UK pari-mutuel data).
  - gamma = 1  => reduces to Harville exactly (regression-tested below).
- **Stern per-position (secondary)**: same formula with ``gamma_k`` per
  position. Single-gamma Henery is the primary model; Stern is reported for
  completeness.

Wide pool semantics differ: pays if BOTH selected horses finish in the top 3.
Sum of all ``C(N, 2)`` wide-pair probs = ``C(3, 2) = 3`` (the count of pairs
within the top 3), NOT 1.0. ``wide_prob`` is a separate function -- do not
shoehorn wide into the ordered top-k path.

Bracket quinella: aggregate horse probs -> bracket probs via the ``gate``
column (actually ``wakuban``; naming bug in ``jravan_silver.py:142`` but the
data is correct), then run Harville/Henery over the (<=8) bracket universe.
"""
from __future__ import annotations

from collections.abc import Iterable, Iterator
from itertools import combinations, permutations
from typing import Sequence

# Walk-forward gamma grid: 101 points over [0.50, 1.00]. Tighter than the
# market_baseline beta grid because exotic Phase 2 disagreement is sensitive
# to 1-2% bias a coarse grid would inject. Non-convexity is not a real worry
# at this resolution.
GAMMA_GRID = tuple(round(0.50 + i * 0.005, 3) for i in range(101))
GAMMA_DEFAULT = 1.0
DEFAULT_FIT_WINDOW = 1000


# ---------------------------------------------------------------------------
# Core ordering-probability primitives
# ---------------------------------------------------------------------------


def _sequence_prob(
    win_probs: dict[int, float],
    ordered_finishers: Sequence[int],
    gammas: float | Sequence[float],
) -> float:
    """Closed-form probability of an ordered finishing subsequence.

    ``ordered_finishers`` is a prefix of the finish order (e.g. ``[1, 3, 2]``
    means horse 1 first, horse 3 second, horse 2 third; positions 4..N are
    unobserved). ``gammas`` is either a scalar (applied to every position) or
    a sequence with one gamma per observed position.

    Returns 0.0 if any finisher is unknown to ``win_probs`` or repeated. The
    remaining-horse denominator is recomputed at each position so this is the
    exact Henery/Stern likelihood contribution -- not a mean-field approximation.
    """
    p = win_probs
    n_pos = len(ordered_finishers)
    if n_pos == 0:
        return 1.0
    if isinstance(gammas, (int, float)):
        gamma_seq = [float(gammas)] * n_pos
    else:
        gamma_seq = list(gammas)
        if len(gamma_seq) < n_pos:
            raise ValueError(
                f"gammas sequence too short: need {n_pos}, got {len(gamma_seq)}"
            )

    remaining = set(p.keys())
    prob = 1.0
    for k, j in enumerate(ordered_finishers):
        if j not in remaining:
            return 0.0
        g = gamma_seq[k]
        numer = p[j] ** g
        denom = sum(p[m] ** g for m in remaining)
        if denom <= 0.0:
            return 0.0
        prob *= numer / denom
        remaining.remove(j)
    return prob


def harville_prob(
    win_probs: dict[int, float], ordered_finishers: Sequence[int]
) -> float:
    """Harville (1973): gamma = 1 ordering probability."""
    return _sequence_prob(win_probs, ordered_finishers, 1.0)


def henery_prob(
    win_probs: dict[int, float],
    ordered_finishers: Sequence[int],
    gamma: float,
) -> float:
    """Henery/Stern single-gamma ordering probability. ``gamma=1.0`` is
    numerically equal to ``harville_prob`` (regression-tested)."""
    return _sequence_prob(win_probs, ordered_finishers, float(gamma))


def stern_prob(
    win_probs: dict[int, float],
    ordered_finishers: Sequence[int],
    gammas: Sequence[float],
) -> float:
    """Stern (1994) per-position gamma ordering probability. Primary model is
    single-gamma Henery; Stern is reported for completeness only."""
    return _sequence_prob(win_probs, ordered_finishers, tuple(gammas))


def wide_prob(
    win_probs: dict[int, float],
    pair: tuple[int, int],
    gamma: float = 1.0,
) -> float:
    """Probability both horses in ``pair`` finish in the top 3.

    Summed over all ordered top-3 finishes containing the pair. For any
    N-horse field where a top 3 is well-defined, the sum over all C(N, 2)
    pair probabilities equals C(3, 2) = 3 -- NOT 1.0 -- because each ordered
    top-3 contributes to three different pairs. Regression-tested.
    """
    a, b = pair
    if a not in win_probs or b not in win_probs or a == b:
        return 0.0
    others = [h for h in win_probs if h not in (a, b)]
    total = 0.0
    for pos_a, pos_b in permutations((1, 2, 3), 2):
        pos_third = 6 - pos_a - pos_b  # 1+2+3 = 6
        for third in others:
            order = [None, None, None]
            order[pos_a - 1] = a
            order[pos_b - 1] = b
            order[pos_third - 1] = third
            total += _sequence_prob(win_probs, order, gamma)
    return total


# ---------------------------------------------------------------------------
# Enumeration
# ---------------------------------------------------------------------------

# Pool names that ``enumerate_combos`` accepts. Mirrors the
# ``keibamon_core.ingestion.settlement.Pool`` literal; duplicated here to keep
# the model library free of lake imports.
SUPPORTED_POOLS = (
    "win",
    "place",
    "bracket_quinella",
    "quinella",
    "wide",
    "exacta",
    "trio",
    "trifecta",
)


def enumerate_combos(
    win_probs: dict[int, float],
    pool: str,
    gamma: float = 1.0,
) -> Iterator[tuple[str, float]]:
    """Yield ``(combo_str, model_prob)`` for every combo in ``pool``.

    ``combo_str`` is the canonical payout-table form (concatenated digits;
    see ``settlement._normalize_selection``). ``win_probs`` is horse-number
    keyed; for ``bracket_quinella`` it is bracket-keyed (caller aggregates
    horses -> brackets first via ``aggregate_brackets``).
    """
    horses = sorted(win_probs.keys())
    if pool in ("win", "place"):
        for h in horses:
            yield f"{h:02d}", win_probs[h]
        return
    if pool == "quinella":
        for a, b in combinations(horses, 2):
            p_ab = _sequence_prob(win_probs, [a, b], gamma)
            p_ba = _sequence_prob(win_probs, [b, a], gamma)
            yield f"{a:02d}{b:02d}", p_ab + p_ba
        return
    if pool == "exacta":
        for a, b in permutations(horses, 2):
            yield f"{a:02d}{b:02d}", _sequence_prob(win_probs, [a, b], gamma)
        return
    if pool == "trifecta":
        for a, b, c in permutations(horses, 3):
            yield f"{a:02d}{b:02d}{c:02d}", _sequence_prob(win_probs, [a, b, c], gamma)
        return
    if pool == "trio":
        for a, b, c in combinations(horses, 3):
            p = sum(
                _sequence_prob(win_probs, list(perm), gamma)
                for perm in permutations((a, b, c))
            )
            yield f"{a:02d}{b:02d}{c:02d}", p
        return
    if pool == "wide":
        for a, b in combinations(horses, 2):
            yield f"{a:02d}{b:02d}", wide_prob(win_probs, (a, b), gamma)
        return
    if pool == "bracket_quinella":
        # Brackets are 1..8 (single-digit). Quinella over brackets, same math
        # as the horse-level quinella but without zero padding in combo_str
        # (matches jravan_payouts.bracket_quinella combo form, e.g. '23').
        for a, b in combinations(horses, 2):
            p_ab = _sequence_prob(win_probs, [a, b], gamma)
            p_ba = _sequence_prob(win_probs, [b, a], gamma)
            yield f"{a}{b}", p_ab + p_ba
        return
    raise ValueError(f"unsupported pool: {pool!r}")


def aggregate_brackets(
    win_probs: dict[int, float], bracket_map: dict[int, int]
) -> dict[int, float]:
    """Sum horse-level win probs to bracket-level win probs.

    ``bracket_map[horse_number] -> bracket_id`` (typically 1..8). Horses whose
    ``bracket_map`` entry is missing are dropped (their probability mass is
    lost -- caller should ensure complete coverage). The ``gate`` column on
    ``jravan_race_entries`` actually carries ``wakuban`` (bracket); see
    ``jravan_silver.py:142`` for the naming bug (data is correct).
    """
    out: dict[int, float] = {}
    for h, p in win_probs.items():
        b = bracket_map.get(h)
        if b is None:
            continue
        out[b] = out.get(b, 0.0) + p
    return out


# ---------------------------------------------------------------------------
# Walk-forward gamma fit
# ---------------------------------------------------------------------------


def fit_gamma_walkforward(
    race_log: list[dict],
    *,
    window: int = DEFAULT_FIT_WINDOW,
    grid: Sequence[float] = GAMMA_GRID,
) -> dict[str, float]:
    """Walk-forward single-gamma Henery fit per race.

    ``race_log`` is a chronological list of dicts each carrying:
    - ``race_id``: str
    - ``win_probs``: dict[int, float] -- horse_number -> de-vigged win prob
    - ``ordered_finishers``: list[int] -- observed top-k (k >= 1); only the
      first 3 are used (Henery's gamma governs 2nd/3rd, deeper positions
      contribute negligibly and race fields with scratched runners can have
      inconsistent depth)

    Returns ``{race_id: gamma}`` where each gamma is the MLE on the prior
    ``window`` races only (PIT: never the race being scored or future races).
    Races before ``window`` historical observations are assigned
    ``GAMMA_DEFAULT`` (1.0 == Harville). Returns 1.0 for any race whose window
    has no usable likelihood (e.g. all races had a single finisher).
    """
    # Precompute per-race log-likelihood contributions as a function of gamma:
    # for each observed position k,
    #   log P(k-th = j_k | top k-1 = S_{k-1}, gamma)
    #     = gamma * log p_{j_k} - log(sum_{m in remaining INCLUDING j_k} p_m ** gamma)
    # log L_r(gamma) = sum over positions. The denominator INCLUDES j_k (the
    # softmax form); excluding it silently turns probabilities into log-odds,
    # which both inflates absolute loss and biases the argmax.
    import math

    import numpy as np

    if not race_log:
        return {}

    gammas = np.asarray(grid, dtype=float)
    # Per-race precompute: arrays of shape (len(grid),) -- log L_r(gamma) curve.
    race_curves: list[np.ndarray] = []
    race_ids: list[str] = []
    for r in race_log:
        rid = r["race_id"]
        p = r["win_probs"]
        finishers = list(r.get("ordered_finishers") or [])[:3]
        if not finishers:
            continue
        curve = np.zeros(len(gammas), dtype=float)
        remaining = set(p.keys())
        ok = True
        for j in finishers:
            if j not in remaining:
                ok = False
                break
            log_p_j = math.log(max(p[j], 1e-12))
            # Denominator over `remaining` INCLUDING j (Henery softmax form).
            log_ps = np.array(
                [math.log(max(p[m], 1e-12)) for m in remaining],
                dtype=float,
            )
            terms = gammas[:, None] * log_ps[None, :]  # (G, M)
            max_terms = terms.max(axis=1, keepdims=True)
            log_sum = (
                max_terms[:, 0]
                + np.log(np.exp(terms - max_terms).sum(axis=1))
            )
            curve = curve + gammas * log_p_j - log_sum
            remaining.remove(j)
        if not ok:
            continue
        race_curves.append(curve)
        race_ids.append(rid)

    n = len(race_curves)
    if n == 0:
        return {r["race_id"]: GAMMA_DEFAULT for r in race_log}
    curves = np.array(race_curves, dtype=float)  # (n_races, n_grid)

    out: dict[str, float] = {}
    # First `window` races see too little history -> default.
    for i in range(min(window, n)):
        out[race_ids[i]] = GAMMA_DEFAULT
    # From the (window)-th race onward, MLE on prior `window` curves.
    for i in range(window, n):
        window_curves = curves[i - window:i]
        total_ll = window_curves.sum(axis=0)  # (n_grid,)
        best = int(np.argmax(total_ll))
        out[race_ids[i]] = float(gammas[best])
    # Any race_id that did not yield a curve (empty finishers) gets default.
    seen = set(out.keys())
    for r in race_log:
        if r["race_id"] not in seen:
            out[r["race_id"]] = GAMMA_DEFAULT
    return out


def fit_gamma_global(
    race_log: Iterable[dict],
    *,
    grid: Sequence[float] = GAMMA_GRID,
) -> float:
    """Single-gamma Henery MLE over an entire sample (used for the secondary
    'all history' comparison and the Stern-per-position reporting)."""
    import math

    import numpy as np

    gammas = np.asarray(grid, dtype=float)
    total = np.zeros(len(gammas), dtype=float)
    for r in race_log:
        p = r["win_probs"]
        finishers = list(r.get("ordered_finishers") or [])[:3]
        if not finishers:
            continue
        remaining = set(p.keys())
        for j in finishers:
            if j not in remaining:
                break
            log_p_j = math.log(max(p[j], 1e-12))
            log_ps = np.array(
                [math.log(max(p[m], 1e-12)) for m in remaining],
                dtype=float,
            )
            terms = gammas[:, None] * log_ps[None, :]
            max_terms = terms.max(axis=1, keepdims=True)
            log_sum = (
                max_terms[:, 0]
                + np.log(np.exp(terms - max_terms).sum(axis=1))
            )
            total = total + gammas * log_p_j - log_sum
            remaining.remove(j)
    if not total.any():
        return GAMMA_DEFAULT
    return float(gammas[int(np.argmax(total))])


def sample_ordered_finish(
    win_probs: dict[int, float], gamma: float, *, rng=None
) -> list[int]:
    """Draw an ordered finish (all horses) from the Henery(gamma) model.

    Used by tests to generate synthetic finishes with a known gamma truth.
    Production code never calls this -- real finishes come from the lake.
    """
    import numpy as np

    rng = rng or np.random.default_rng()
    p = dict(win_probs)
    order: list[int] = []
    remaining = list(p.keys())
    while remaining:
        weights = np.array([p[m] ** gamma for m in remaining])
        s = weights.sum()
        if s <= 0:
            break
        weights = weights / s
        idx = int(rng.choice(len(remaining), p=weights))
        picked = remaining.pop(idx)
        order.append(picked)
    return order
