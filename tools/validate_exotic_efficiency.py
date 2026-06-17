"""Exotic-pool efficiency validator (the 5th hypothesis).

The JRA win pool is a 4-null market: mining, going, training, and the odds
curve all failed to beat market@t net of takeout. This validator asks whether
the **exotic pools** (exacta, quinella, wide, trio, trifecta,
bracket_quinella) are efficient relative to the win-implied joint
distribution of finish order. **No new fundamental factor is under test** --
the only plausible edge source is cross-pool mispricing: does the de-vigged
win market, projected through a Harville/Henery ordering model, disagree
with exotic prices enough to clear the higher exotic takeout?

Three phases
------------
1. **Calibration** (Harville vs walk-forward Henery gamma): reliability
   tables across all modelable history. Finds whether the ordering model is
   even well-specified, separately from any efficiency question.
2. **Efficiency** (quinella + bracket_quinella time-series, 70/30 OOS):
   at each decision time t in {30, 10, 2} min-to-post, bet every combo with
   ``model_prob / market_prob_at_t >= 1 + tau``. Settle at official payouts.
   Race-day-clustered bootstrap CIs. Capacity scenarios 0/0.2/0.5/1.0%.
3. **Realized-payout upper bound** (trifecta/trio/exacta/wide): for each
   settled exotic payout, model prob vs ``100 / payout_yen``. This is NOT a
   tradeable result -- it scopes whether capturing exotic odds time-series
   is worth pursuing. Framed as upper bound because (a) you cannot transact
   at the closing payout ex ante and (b) the closing payout already
   incorporates late informed money.

Point-in-time correctness
-------------------------
- gamma is fit walk-forward on prior races' finishes only (window=1000).
- Phase 2 win odds and pool odds are filtered ``available_at <= t``.
- Bracket assignment is stable context -> PIT-filter on
  ``scheduled_post_time`` (NOT the pre-post ``as_of_time``).
- Settlement via ``settle_many`` against ``jravan_payouts``, never at an
  assumed price.
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from itertools import combinations, permutations
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion import exotic_model as em
from keibamon_core.ingestion.market_baseline import MARKET_BASELINE_FEATURE_SET
from keibamon_core.ingestion.settlement import Bet, settle_many
from keibamon_core.paths import LakePaths

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

BOOTSTRAP_ITERS = 500
RNG_SEED = 20260617
GAMMA_WINDOW = 1000

# JRA exotic takeouts (per ADR-0002). Steeper than the ~23% win-pool baseline.
EXOTIC_TAKEOUT = {
    "win": -0.225,
    "place": -0.225,
    "bracket_quinella": -0.225,
    "quinella": -0.225,
    "wide": -0.225,
    "exacta": -0.25,
    "trio": -0.25,
    "trifecta": -0.275,
}

DECISION_MINUTES = (30, 10, 2)
DISAGREEMENT_THRESHOLDS = (0.00, 0.05, 0.10, 0.15, 0.20)
CAPACITY_SCENARIOS = (0.000, 0.002, 0.005, 0.010)
REMOVE_TOP_N = (1, 3, 5, 10)
MIN_RACES_PHASE2 = 200  # per decision-time cell to report ROI

# Reliability-table bins for Phase 1. Log-spaced to span deep longshots.
PHASE1_BINS = [
    (0.0, 0.0001),
    (0.0001, 0.001),
    (0.001, 0.005),
    (0.005, 0.01),
    (0.01, 0.025),
    (0.025, 0.05),
    (0.05, 0.10),
    (0.10, 0.20),
    (0.20, 0.40),
    (0.40, 1.01),
]

PHASE2_POOLS = ("quinella", "bracket_quinella")
PHASE3_POOLS = ("exacta", "trifecta", "trio", "wide")
ALL_EXOTIC_POOLS = ("bracket_quinella", "quinella", "wide", "exacta", "trio", "trifecta")


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------


def main() -> None:
    lake = LakePaths()
    if not lake.silver_dataset("jravan_payouts").exists():
        print("No jravan_payouts table; cannot run exotic validator.")
        return
    if not lake.gold_dataset(MARKET_BASELINE_FEATURE_SET).exists():
        print(
            f"No {MARKET_BASELINE_FEATURE_SET} gold. Run "
            "`python -m keibamon_core.ingestion.market_baseline` first."
        )
        return

    print("=" * 78)
    print("EXOTIC-POOL EFFICIENCY VALIDATOR (the 5th hypothesis)")
    print("=" * 78)
    print(
        "Question: do exotic pools misprice the win-implied joint distribution\n"
        "          of finish order enough to clear their higher takeout? If CI\n"
        "          clears zero net of exotic takeout, the win market's 4-null\n"
        "          streak ends. If not, exotics close the research programme."
    )

    # Shared race log: chronological, with de-vigged win probs + ordered top-3
    # finishers per race. Used for gamma fit (Phase 1) and Phase 3 model probs.
    race_log, win_probs_by_race, year_by_race = _load_race_log(lake)
    if not race_log:
        print("No races with full top-3 + devigged win probs. Nothing to do.")
        return
    print(f"\nLoaded {len(race_log):,} races with de-vigged win probs + finishes.")

    print(
        f"Fitting walk-forward gamma (window={GAMMA_WINDOW}, "
        f"grid={len(em.GAMMA_GRID)} points over [0.50, 1.00])..."
    )
    gammas_by_race = em.fit_gamma_walkforward(race_log, window=GAMMA_WINDOW)
    fit_gammas = [v for v in gammas_by_race.values() if v != em.GAMMA_DEFAULT]
    if fit_gammas:
        arr = np.array(fit_gammas)
        print(
            f"  Walk-forward gammas: n={len(arr)}, mean={arr.mean():.3f}, "
            f"median={np.median(arr):.3f}, std={arr.std():.3f}, "
            f"min={arr.min():.3f}, max={arr.max():.3f}"
        )
        # Yearly stability check
        by_year: dict[int, list[float]] = defaultdict(list)
        for rid, g in gammas_by_race.items():
            by_year[year_by_race.get(rid, 0)].append(g)
        print("  gamma by year (mean / median / n):")
        for y in sorted(by_year):
            arr_y = np.array([g for g in by_year[y] if g != em.GAMMA_DEFAULT])
            if len(arr_y) == 0:
                print(f"    {y}: (warm-up only)")
                continue
            print(
                f"    {y}: mean={arr_y.mean():.3f}, median={np.median(arr_y):.3f}, "
                f"n={len(arr_y)}"
            )
    else:
        print("  No walk-forward gammas fit (history < window).")

    print(
        f"  Global gamma (all history, secondary): {em.fit_gamma_global(race_log):.3f}"
    )

    phase1_calibration(lake, race_log, win_probs_by_race, gammas_by_race)
    phase2_efficiency(lake, gammas_by_race)
    phase3_realized(lake, race_log, win_probs_by_race, gammas_by_race)


# ----------------------------------------------------------------------------
# Race log + gamma fit inputs
# ----------------------------------------------------------------------------


def _load_race_log(
    lake: LakePaths,
) -> tuple[list[dict], dict[str, dict[int, float]], dict[str, int]]:
    """Chronological race log for the gamma walk-forward fit + Phase 1.

    Each entry carries the de-vigged win prob per horse (from market_baseline
    gold) and the ordered top-3 finishers. Races without a winner or with
    fewer than 3 finishers are kept but contribute weakly to the gamma
    identification.
    """
    sql = f"""
    WITH ranked AS (
        SELECT
            mb.race_id AS race_id,
            mb.horse_number AS horse_number,
            mb.devigged_market_prob AS devigged_prob,
            mb.finish_position AS finish_position,
            mb.year AS year
        FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))} mb
        WHERE mb.devigged_market_prob IS NOT NULL
          AND mb.devigged_market_prob > 0
          AND mb.horse_number IS NOT NULL
          AND mb.finish_position IS NOT NULL
    ),
    races AS (
        SELECT
            r.race_id AS race_id,
            r.year AS year
        FROM (SELECT DISTINCT race_id, year FROM ranked) r
    ),
    by_race AS (
        SELECT
            race_id,
            ANY_VALUE(year) AS year,
            LIST(horse_number ORDER BY horse_number) AS horses,
            LIST(devigged_prob ORDER BY horse_number) AS probs,
            LIST(horse_number ORDER BY finish_position ASC, horse_number ASC)
                FILTER (WHERE finish_position IS NOT NULL) AS ordered_finishers,
        FROM ranked
        GROUP BY race_id
    )
    SELECT race_id, year, horses, probs, ordered_finishers
    FROM by_race
    ORDER BY year, race_id
    """
    table = lake_query.query(sql)
    rows = table.to_pylist()
    race_log: list[dict] = []
    win_probs_by_race: dict[str, dict[int, float]] = {}
    year_by_race: dict[str, int] = {}
    for r in rows:
        horses = r["horses"] or []
        probs = r["probs"] or []
        if not horses or len(horses) != len(probs):
            continue
        wp = {int(h): float(p) for h, p in zip(horses, probs)}
        if not wp or sum(wp.values()) <= 0:
            continue
        ordered = [int(h) for h in (r["ordered_finishers"] or [])]
        if not ordered:
            continue
        rid = r["race_id"]
        race_log.append(
            {
                "race_id": rid,
                "win_probs": wp,
                "ordered_finishers": ordered,
            }
        )
        win_probs_by_race[rid] = wp
        year_by_race[rid] = int(r["year"])
    return race_log, win_probs_by_race, year_by_race


# ----------------------------------------------------------------------------
# Per-race vectorized combo probs (Harville + Henery in one pass)
# ----------------------------------------------------------------------------


def _per_race_combos(
    win_probs: dict[int, float],
    gamma: float,
    bracket_map: dict[int, int] | None = None,
) -> dict[str, list[tuple[str, float, float]]]:
    """For one race, return per-pool list of ``(combo_str, harville_p, henery_p)``.

    Vectorized in numpy per depth (2-tuples for quinella/exacta; 3-tuples for
    trifecta/trio/wide). Bracket quinella runs over the bracket universe when
    a ``bracket_map`` is supplied (horse_number -> bracket_id).
    """
    horses = sorted(win_probs.keys())
    n = len(horses)
    out: dict[str, list[tuple[str, float, float]]] = {
        pool: [] for pool in ("quinella", "exacta", "trifecta", "trio", "wide")
    }
    if n < 2:
        return out

    p = np.array([win_probs[h] for h in horses], dtype=float)
    pg1 = p
    pg = p ** gamma
    D1 = pg1.sum()
    Dg = pg.sum()
    if D1 <= 0 or Dg <= 0:
        return out

    # === Ordered 2-tuple matrix M[a, b] = P(a first, b second) ===
    # M = outer(pg, pg) / (D * (D - pg)[:, None]) for a != b
    with np.errstate(divide="ignore", invalid="ignore"):
        M_g = np.outer(pg, pg) / (Dg * (Dg - pg)[:, None])
        M_1 = np.outer(pg1, pg1) / (D1 * (D1 - pg1)[:, None])
    diag_mask = np.eye(n, dtype=bool)
    M_g = np.where(diag_mask, 0.0, M_g)
    M_1 = np.where(diag_mask, 0.0, M_1)

    # Exacta: each (a, b) a != b
    for a in range(n):
        for b in range(n):
            if a == b:
                continue
            out["exacta"].append(
                (f"{horses[a]:02d}{horses[b]:02d}", float(M_1[a, b]), float(M_g[a, b]))
            )

    # Quinella: each unordered pair (symmetrize)
    Q_g = M_g + M_g.T
    Q_1 = M_1 + M_1.T
    for i in range(n):
        for j in range(i + 1, n):
            out["quinella"].append(
                (f"{horses[i]:02d}{horses[j]:02d}", float(Q_1[i, j]), float(Q_g[i, j]))
            )

    if n >= 3:
        # === Ordered 3-tuple tensor T[a, b, c] ===
        T_g = np.zeros((n, n, n))
        T_1 = np.zeros((n, n, n))
        for a in range(n):
            d2g = Dg - pg[a]
            d21 = D1 - pg1[a]
            if d2g <= 0 or d21 <= 0:
                continue
            for b in range(n):
                if b == a:
                    continue
                d3g = d2g - pg[b]
                d31 = d21 - pg1[b]
                if d3g > 0:
                    row_g = (pg[a] * pg[b] / (Dg * d2g)) * (pg / d3g)
                    row_g[a] = 0.0
                    row_g[b] = 0.0
                    T_g[a, b, :] = row_g
                if d31 > 0:
                    row_1 = (pg1[a] * pg1[b] / (D1 * d21)) * (pg1 / d31)
                    row_1[a] = 0.0
                    row_1[b] = 0.0
                    T_1[a, b, :] = row_1

        # Trifecta: each ordered triple
        tri_g = T_g
        tri_1 = T_1
        idx_a, idx_b, idx_c = np.indices((n, n, n))
        distinct = (idx_a != idx_b) & (idx_b != idx_c) & (idx_a != idx_c)
        flat_a = idx_a[distinct]
        flat_b = idx_b[distinct]
        flat_c = idx_c[distinct]
        flat_g = tri_g[distinct]
        flat_1 = tri_1[distinct]
        for a, b, c, hg, h1 in zip(flat_a, flat_b, flat_c, flat_g, flat_1):
            out["trifecta"].append(
                (
                    f"{horses[a]:02d}{horses[b]:02d}{horses[c]:02d}",
                    float(h1),
                    float(hg),
                )
            )

        # Trio: each unordered triple (i < j < k), sum over 6 perms
        # Wide: each unordered pair, sum over all top-3 ordered finishes
        # containing the pair (6 perms x (n-2) third horses).
        for i in range(n):
            for j in range(i + 1, n):
                wide_g = 0.0
                wide_1 = 0.0
                for k in range(n):
                    if k == i or k == j:
                        continue
                    for perm in permutations((i, j, k)):
                        wide_g += T_g[perm]
                        wide_1 += T_1[perm]
                out["wide"].append(
                    (f"{horses[i]:02d}{horses[j]:02d}", float(wide_1), float(wide_g))
                )
            if j > i + 1:
                # Trio triple only when we have a complete i<j<k via outer loop structure
                pass
        # Trio: separate clean loop over unordered triples
        for i in range(n):
            for j in range(i + 1, n):
                for k in range(j + 1, n):
                    perms_list = list(permutations((i, j, k)))
                    hg = float(sum(T_g[p] for p in perms_list))
                    h1 = float(sum(T_1[p] for p in perms_list))
                    out["trio"].append(
                        (f"{horses[i]:02d}{horses[j]:02d}{horses[k]:02d}", h1, hg)
                    )

    # Bracket quinella (separate universe). Brackets are 1..8, single-digit.
    if bracket_map:
        bracket_probs = em.aggregate_brackets(win_probs, bracket_map)
        if len(bracket_probs) >= 2:
            b_out: list[tuple[str, float, float]] = []
            b_horses = sorted(bracket_probs.keys())
            bn = len(b_horses)
            bp = np.array([bracket_probs[h] for h in b_horses], dtype=float)
            bpg = bp ** gamma
            BD1 = bp.sum()
            BDg = bpg.sum()
            if BD1 > 0 and BDg > 0:
                with np.errstate(divide="ignore", invalid="ignore"):
                    BM_g = np.outer(bpg, bpg) / (BDg * (BDg - bpg)[:, None])
                    BM_1 = np.outer(bp, bp) / (BD1 * (BD1 - bp)[:, None])
                BM_g = np.where(np.eye(bn, dtype=bool), 0.0, BM_g)
                BM_1 = np.where(np.eye(bn, dtype=bool), 0.0, BM_1)
                BQ_g = BM_g + BM_g.T
                BQ_1 = BM_1 + BM_1.T
                for i in range(bn):
                    for j in range(i + 1, bn):
                        b_out.append(
                            (
                                f"{b_horses[i]}{b_horses[j]}",
                                float(BQ_1[i, j]),
                                float(BQ_g[i, j]),
                            )
                        )
            out["bracket_quinella"] = b_out

    return out


# ----------------------------------------------------------------------------
# Phase 1 -- calibration (Harville vs Henery gamma)
# ----------------------------------------------------------------------------


@dataclass
class BinStat:
    lo: float
    hi: float
    n: int = 0
    hits: int = 0
    sum_harville: float = 0.0
    sum_henery: float = 0.0


@dataclass
class Phase1PoolReport:
    pool: str
    n_races: int
    n_combos: int
    bins: list[BinStat]
    harville_log_lik: float  # sum over observed winning combos of log(harville_p)
    henery_log_lik: float


def phase1_calibration(
    lake: LakePaths,
    race_log: list[dict],
    win_probs_by_race: dict[str, dict[int, float]],
    gammas_by_race: dict[str, float],
) -> None:
    print("\n" + "=" * 78)
    print("PHASE 1 -- Calibration: Harville vs Henery across all modelable history")
    print("=" * 78)
    print(
        "Reliability: 10 model-prob bins x observed hit frequency per pool.\n"
        "Harville vs Henery OOS log-likelihood (sum log P(winning combo))."
    )

    payouts_by_race = _load_winning_combos(lake, ALL_EXOTIC_POOLS)
    bracket_maps = _load_bracket_maps(lake)

    reports: list[Phase1PoolReport] = []
    for pool in ALL_EXOTIC_POOLS:
        rep = _phase1_pool(
            pool,
            race_log,
            win_probs_by_race,
            gammas_by_race,
            payouts_by_race,
            bracket_maps,
        )
        reports.append(rep)

    # Print reports per pool.
    for rep in reports:
        _print_phase1_pool(rep)

    print("\nPhase 1 verdict:")
    # Per-pool Harville-vs-Henery delta
    improved = []
    hurt = []
    for rep in reports:
        delta = rep.henery_log_lik - rep.harville_log_lik
        if delta > 0:
            improved.append((rep.pool, delta, rep.n_races))
        else:
            hurt.append((rep.pool, delta, rep.n_races))
    if improved:
        print("  Henery IMPROVES log-likelihood vs Harville (model is misspecified under Harville):")
        for pool, delta, n in improved:
            print(f"    {pool}: delta=+{delta:.2f} over {n:,} races")
    if hurt:
        print("  Henery does NOT improve (Harville is adequate or Henery gamma mis-fit):")
        for pool, delta, n in hurt:
            print(f"    {pool}: delta={delta:+.2f} over {n:,} races")


def _phase1_pool(
    pool: str,
    race_log: list[dict],
    win_probs_by_race: dict[str, dict[int, float]],
    gammas_by_race: dict[str, float],
    payouts_by_race: dict[str, set[str]],
    bracket_maps: dict[str, dict[int, int]],
) -> Phase1PoolReport:
    bins = [BinStat(lo=lo, hi=hi) for lo, hi in PHASE1_BINS]
    harville_ll = 0.0
    henery_ll = 0.0
    n_races = 0
    n_combos = 0

    for r in race_log:
        rid = r["race_id"]
        wp = win_probs_by_race.get(rid)
        if not wp:
            continue
        winners = payouts_by_race.get(rid)
        if not winners or pool not in winners:
            continue
        winning_combos = winners[pool]
        if not winning_combos:
            continue
        gamma = gammas_by_race.get(rid, em.GAMMA_DEFAULT)
        bracket_map = bracket_maps.get(rid) if pool == "bracket_quinella" else None

        combos = _per_race_combos(wp, gamma, bracket_map=bracket_map)
        pool_combos = combos.get(pool, [])
        if not pool_combos:
            continue

        n_races += 1
        n_combos += len(pool_combos)
        for combo_str, h1, hg in pool_combos:
            bin_idx = _find_bin(hg, PHASE1_BINS)
            if bin_idx is None:
                continue
            b = bins[bin_idx]
            b.n += 1
            b.sum_harville += h1
            b.sum_henery += hg
            if combo_str in winning_combos:
                b.hits += 1
                if h1 > 0:
                    harville_ll += math.log(max(h1, 1e-12))
                if hg > 0:
                    henery_ll += math.log(max(hg, 1e-12))

    return Phase1PoolReport(
        pool=pool,
        n_races=n_races,
        n_combos=n_combos,
        bins=bins,
        harville_log_lik=harville_ll,
        henery_log_lik=henery_ll,
    )


def _find_bin(p: float, bins: list[tuple[float, float]]) -> int | None:
    for i, (lo, hi) in enumerate(bins):
        if lo < p <= hi:
            return i
    return None


def _print_phase1_pool(rep: Phase1PoolReport) -> None:
    print(
        f"\n  [{rep.pool}] {rep.n_races:,} races / {rep.n_combos:,} combos "
        f"(takeout bar: ROI > {EXOTIC_TAKEOUT.get(rep.pool, -0.25):+.3f})"
    )
    if rep.n_races == 0:
        print("    no races with payouts for this pool.")
        return
    print(
        "    prob-bin (Henery)         combos     hits   observed  mean(harville)  mean(henery)"
    )
    for b in rep.bins:
        if b.n == 0:
            continue
        obs = b.hits / b.n
        mh = b.sum_harville / b.n
        me = b.sum_henery / b.n
        flag = "  (thin)" if b.n < 200 else ""
        print(
            f"    ({b.lo:.4f},{b.hi:.4f}]  {b.n:>10,}  {b.hits:>7,}   {obs:.4f}   "
            f"{mh:.4f}      {me:.4f}{flag}"
        )
    delta = rep.henery_log_lik - rep.harville_log_lik
    direction = "Henery HELPS" if delta > 0 else "Harville is adequate"
    print(
        f"    log-lik: Harville={rep.harville_log_lik:.1f}, "
        f"Henery={rep.henery_log_lik:.1f}, delta={delta:+.1f} -> {direction}"
    )


# ----------------------------------------------------------------------------
# Phase 2 -- efficiency test (quinella + bracket_quinella time-series)
# ----------------------------------------------------------------------------


@dataclass
class Phase2Cell:
    pool: str
    decision_minutes: int
    tau: float
    bets: int
    stake_yen: int
    infinitesimal_roi: float
    capacity_adjusted_roi: dict[float, float] = field(default_factory=dict)
    roi_ci_low: float = 0.0
    roi_ci_high: float = 0.0
    hit_rate: float = 0.0
    remove_top_roi: dict[int, float] = field(default_factory=dict)


def phase2_efficiency(
    lake: LakePaths, gammas_by_race: dict[str, float]
) -> None:
    print("\n" + "=" * 78)
    print("PHASE 2 -- Efficiency test (quinella + bracket_quinella time-series)")
    print("=" * 78)
    print(
        "70/30 era-aware OOS, decisions at t in {30, 10, 2} min-to-post.\n"
        "Win odds at t from jravan_odds_timeseries pool='win' (filtered\n"
        "available_at <= t). De-vig per snapshot. Pool market price at t\n"
        "de-vigged over QUOTED combos only -- thin early snapshots are\n"
        "selection-biased toward liquid combos (acknowledged limitation).\n"
        "Henery combo probs use walk-forward gamma at this race. Disagreement\n"
        "= model / market. Bet if disagreement >= 1 + tau for tau in\n"
        "{0.00, 0.05, 0.10, 0.15, 0.20}. tau=0.00 is the primary test; the\n"
        "other four are secondary (multiplicity: 5 tau x 2 pools x 4 capacity\n"
        "scenarios = 40 numbers; one will randomly clear CI > 0 -- own this)."
    )

    bracket_maps = _load_bracket_maps(lake)
    snapshot = _load_phase2_snapshot(lake, PHASE2_POOLS, DECISION_MINUTES)
    if not snapshot:
        print("  No qualifying races in 2025-06-20 to 2026-06-14 window.")
        return

    # Era-aware 70/30 OOS split by (race_date, race_id).
    all_race_ids = sorted({s["race_id"] for s in snapshot})
    race_dates = {s["race_id"]: s["race_date"] for s in snapshot}
    df_split = pd.DataFrame(
        {
            "race_id": list(race_dates.keys()),
            "race_date": list(race_dates.values()),
        }
    )
    df_split = df_split.drop_duplicates().sort_values(["race_date", "race_id"])
    cut = max(1, int(math.floor(len(df_split) * 0.7)))
    test_races = set(df_split.iloc[cut:]["race_id"].tolist())
    print(
        f"  Qualifying races: {len(df_split):,} total; "
        f"OOS test set = {len(test_races):,} (70/30 split)."
    )

    # Per-(race, decision) structure: build the per-race market + model.
    # Win rows (pool=NULL) and pool rows (pool='quinella' etc.) for the same
    # (race, decision) must be joined; grouping by pool too would orphan the
    # win rows into their own None-pool bucket.
    by_key: dict[tuple, list[dict]] = defaultdict(list)
    for s in snapshot:
        by_key[(s["race_id"], s["decision_minutes"])].append(s)
    test_snapshot = [s for s in snapshot if s["race_id"] in test_races]

    # Build one bet plan per (pool, decision, tau) cell. Each combo-bet is
    # tagged with (race_id, race_date, pool, combo, tau_set) so we can settle
    # once and slice many ways.
    all_bets: list[Bet] = []
    bet_meta: list[dict] = []  # parallel to all_bets
    seen_keys: set[tuple] = set()
    for s in test_snapshot:
        rid = s["race_id"]
        t = s["decision_minutes"]
        key = (rid, t)
        if key in seen_keys:
            continue
        seen_keys.add(key)
        group = by_key[key]
        # Partition into win rows and pool-odds rows.
        win_rows = [g for g in group if g["kind"] == "win"]
        pool_rows = [g for g in group if g["kind"] == "pool"]
        if not win_rows:
            continue
        # One (race, decision) can feed multiple pools (quinella AND
        # bracket_quinella both quoted at this t). Iterate per pool.
        pools_here = {g["pool"] for g in pool_rows if g["pool"]}
        if not pools_here:
            continue
        win_odds = {int(g["sel_int"]): g["odds"] for g in win_rows if g["sel_int"] is not None}
        if len(win_odds) < 2:
            continue
        # De-vig within snapshot
        D_win = sum(1.0 / o for o in win_odds.values() if o > 0)
        if D_win <= 0:
            continue
        win_probs_at_t = {h: (1.0 / o) / D_win for h, o in win_odds.items() if o > 0}
        race_date = s["race_date"]
        gamma = gammas_by_race.get(rid, em.GAMMA_DEFAULT)
        bracket_map_for_race = bracket_maps.get(rid)

        # One (race, decision) can feed multiple pools. Iterate each pool that
        # has quoted odds at this t.
        for pool in pools_here:
            # Pool quotes for THIS pool only.
            pool_quotes: dict[str, float] = {}
            D_pool = 0.0
            for g in pool_rows:
                if g["pool"] != pool:
                    continue
                combo = g["sel"]
                o = g["odds"]
                if combo is None or o is None or o <= 0 or combo in pool_quotes:
                    continue
                pool_quotes[combo] = o
                D_pool += 1.0 / o
            if D_pool <= 0 or not pool_quotes:
                continue
            market_probs = {c: (1.0 / o) / D_pool for c, o in pool_quotes.items()}

            # Model probs for this pool. Bracket quinella runs over brackets.
            if pool == "bracket_quinella":
                if not bracket_map_for_race:
                    continue
                bp = em.aggregate_brackets(win_probs_at_t, bracket_map_for_race)
                model_probs_iter = em.enumerate_combos(bp, "bracket_quinella", gamma)
            else:
                model_probs_iter = em.enumerate_combos(win_probs_at_t, pool, gamma)
            model_probs = {combo: p for combo, p in model_probs_iter}

            for combo, mkt_p in market_probs.items():
                mdl_p = model_probs.get(combo)
                if mdl_p is None or mdl_p <= 0 or mkt_p <= 0:
                    continue
                disagreement = mdl_p / mkt_p
                bet = Bet(rid, pool, combo, stake_yen=100)
                all_bets.append(bet)
                bet_meta.append(
                    {
                        "race_id": rid,
                        "race_date": race_date,
                        "pool": pool,
                        "decision_minutes": t,
                        "combo": combo,
                        "disagreement": float(disagreement),
                        "model_prob": float(mdl_p),
                        "market_prob": float(mkt_p),
                    }
                )

    if not all_bets:
        print("  No test-race bets produced. Check timeseries coverage / formats.")
        return

    # Settle the whole list ONCE at official payouts. Per-bet returns feed
    # every (pool, decision, tau, capacity) cell.
    settlements = settle_many(lake, all_bets)
    for meta, s in zip(bet_meta, settlements, strict=True):
        meta["returned_yen"] = int(s.returned_yen)
        meta["won"] = bool(s.payout_yen > 0)
    print(
        f"  Settled {len(all_bets):,} combo bets across {len(test_races):,} races "
        f"in one scan at official payouts."
    )

    # Per-cell aggregation. For tau, the bet qualifies if disagreement >= 1+tau.
    cells: list[Phase2Cell] = []
    df = pd.DataFrame(bet_meta)
    for pool in PHASE2_POOLS:
        for t in DECISION_MINUTES:
            sub = df[(df["pool"] == pool) & (df["decision_minutes"] == t)]
            if sub.empty:
                continue
            for tau in DISAGREEMENT_THRESHOLDS:
                bucket = sub[sub["disagreement"] >= 1.0 + tau]
                cells.append(_aggregate_phase2_cell(pool, t, tau, bucket, do_bootstrap=True))

    # Headline: tau=0.00 per pool, collapsed across decision times.
    print("\n  Headline (tau=0.00, collapsed across decision times):")
    for pool in PHASE2_POOLS:
        sub = df[(df["pool"] == pool)]
        if sub.empty:
            continue
        bucket = sub[sub["disagreement"] >= 1.0]
        cell = _aggregate_phase2_cell(pool, 0, 0.0, bucket, do_bootstrap=True)
        _print_phase2_cell(cell, EXOTIC_TAKEOUT.get(pool, -0.25), headline=True)

    # Full grid per pool.
    for pool in PHASE2_POOLS:
        print(f"\n  [{pool}] full grid (all decision times x tau values)")
        print(
            "    decision tau     bets    stake    returned   inf_ROI   "
            "cap(0.0%)  cap(0.2%)  cap(0.5%)  cap(1.0%)   CI_low   CI_high  hit_rate"
        )
        for cell in cells:
            if cell.pool != pool:
                continue
            _print_phase2_cell(cell, EXOTIC_TAKEOUT.get(pool, -0.25), headline=False)

    # Remove-top-N robustness on tau=0 cells per pool.
    print("\n  Remove-top-N payoff robustness (tau=0.00, collapsed across decision times):")
    for pool in PHASE2_POOLS:
        sub = df[(df["pool"] == pool) & (df["disagreement"] >= 1.0)]
        if sub.empty:
            continue
        print(f"    [{pool}]")
        for n in REMOVE_TOP_N:
            roi = _remove_top_payoffs_roi(sub, n)
            if roi is None:
                print(f"      top {n:>2}: insufficient bets after trim")
            else:
                print(f"      top {n:>2}: ROI={roi:+.3f}")


def _aggregate_phase2_cell(
    pool: str,
    decision_minutes: int,
    tau: float,
    bucket: pd.DataFrame,
    do_bootstrap: bool = False,
) -> Phase2Cell:
    n_bets = len(bucket)
    if n_bets == 0:
        return Phase2Cell(
            pool=pool,
            decision_minutes=decision_minutes,
            tau=tau,
            bets=0,
            stake_yen=0,
            infinitesimal_roi=float("nan"),
            roi_ci_low=float("nan"),
            roi_ci_high=float("nan"),
            hit_rate=float("nan"),
        )
    stake = n_bets * 100
    returned = int(bucket["returned_yen"].fillna(0).sum())
    inf_roi = (returned - stake) / stake if stake else float("nan")
    cap_roi = {
        cap: ((returned * (1.0 - cap)) - stake) / stake if stake else float("nan")
        for cap in CAPACITY_SCENARIOS
    }
    hit_rate = float(bucket["won"].mean()) if "won" in bucket else 0.0
    if do_bootstrap:
        ci_low, ci_high = _clustered_bootstrap_roi_phase2(bucket)
    else:
        ci_low = ci_high = float("nan")
    remove_top = {
        n: _remove_top_payoffs_roi(bucket, n) for n in REMOVE_TOP_N
    }
    return Phase2Cell(
        pool=pool,
        decision_minutes=decision_minutes,
        tau=tau,
        bets=n_bets,
        stake_yen=stake,
        infinitesimal_roi=inf_roi,
        capacity_adjusted_roi=cap_roi,
        roi_ci_low=ci_low,
        roi_ci_high=ci_high,
        hit_rate=hit_rate,
        remove_top_roi={k: v for k, v in remove_top.items() if v is not None},
    )


def _print_phase2_cell(
    cell: Phase2Cell, takeout: float, headline: bool
) -> None:
    if cell.bets == 0:
        if headline:
            print(f"    {cell.pool}: no bets at tau={cell.tau:.2f}")
        return
    cap0 = cell.capacity_adjusted_roi.get(0.0, float("nan"))
    cap02 = cell.capacity_adjusted_roi.get(0.002, float("nan"))
    cap05 = cell.capacity_adjusted_roi.get(0.005, float("nan"))
    cap1 = cell.capacity_adjusted_roi.get(0.01, float("nan"))
    ci_str = (
        f"[{cell.roi_ci_low:+.3f}, {cell.roi_ci_high:+.3f}]"
        if not math.isnan(cell.roi_ci_low)
        else "(no CI)"
    )
    if headline:
        verdict = (
            "BEATS TAKEOUT" if cell.roi_ci_low > takeout
            else "DOES NOT BEAT TAKEOUT" if cell.roi_ci_high < takeout
            else "inconclusive vs takeout"
        )
        print(
            f"    {cell.pool}: {cell.bets:,} bets, inf_ROI={cell.infinitesimal_roi:+.3f}, "
            f"cap(0.2%)={cap02:+.3f}, CI={ci_str}, hit={cell.hit_rate:.3f} -> {verdict} "
            f"(bar: {takeout:+.3f})"
        )
        print("      capacity scenarios are a convention, NOT a measurement:")
        print("        0.0%=upper bound, 0.2%=labeled scenario, 1.0%=aggressive.")
        print("        No pari-mutuel pool-size data in the lake.")
    else:
        print(
            f"    t-{cell.decision_minutes:>3}m  tau={cell.tau:.2f}  {cell.bets:>6,}  "
            f"{cell.stake_yen:>8,}  {int(cell.stake_yen * (1 + cell.infinitesimal_roi)):>8,}  "
            f"{cell.infinitesimal_roi:+.3f}   "
            f"{cap0:+.3f}   {cap02:+.3f}   {cap05:+.3f}   {cap1:+.3f}   "
            f"{cell.roi_ci_low:+.3f}   {cell.roi_ci_high:+.3f}   {cell.hit_rate:.3f}"
        )


def _clustered_bootstrap_roi_phase2(
    bucket: pd.DataFrame, n_iter: int = BOOTSTRAP_ITERS
) -> tuple[float, float]:
    """Cluster bootstrap by race_date for the bucket ROI.

    Per-bet returns are precomputed (settled once at official payouts); the
    bootstrap only resamples which race_dates contribute.
    """
    rng = np.random.default_rng(RNG_SEED)
    if bucket.empty:
        return (float("nan"), float("nan"))
    returns_per_bet = bucket["returned_yen"].fillna(0.0).to_numpy() / 100.0
    dates = bucket["race_date"].to_numpy()
    df = pd.DataFrame({"date": dates, "ret": returns_per_bet, "stake": 1.0})
    per_date = df.groupby("date").agg(stakes=("stake", "sum"), ret=("ret", "sum"))
    n_dates = len(per_date)
    if n_dates == 0:
        return (float("nan"), float("nan"))
    stakes_arr = per_date["stakes"].to_numpy()
    ret_arr = per_date["ret"].to_numpy()
    rois = np.empty(n_iter)
    for i in range(n_iter):
        idx = rng.integers(0, n_dates, size=n_dates)
        s = stakes_arr[idx].sum()
        if s == 0:
            rois[i] = 0.0
            continue
        rois[i] = (ret_arr[idx].sum() - s) / s
    return float(np.percentile(rois, 2.5)), float(np.percentile(rois, 97.5))


def _remove_top_payoffs_roi(bucket: pd.DataFrame, n: int) -> float | None:
    if bucket.empty or n >= len(bucket):
        return None
    ranked = bucket.sort_values("returned_yen", ascending=False)
    trimmed = ranked.iloc[n:]
    stakes = len(trimmed)
    if stakes == 0:
        return None
    ret = trimmed["returned_yen"].fillna(0.0).sum() / 100.0
    return float((ret - stakes) / stakes)


def _load_phase2_snapshot(
    lake: LakePaths, pools: tuple[str, ...], decision_minutes: tuple[int, ...]
) -> list[dict]:
    """For each (race, decision_minutes, pool), get the latest odds snapshot
    at/before the decision time, per quoted selection.

    Returns rows of shape ``{race_id, race_date, scheduled_post_time,
    decision_minutes, pool, kind, sel, sel_int, odds, available_at}``.

    ``kind`` is 'win' for the win-pool rows (used to derive win_probs_at_t)
    and 'pool' for the exotic-pool rows (the actual market price being tested).
    For exotic pools we keep the original selection string (e.g. '0102'
    quinella or '12' bracket_quinella); ``sel_int`` is parsed for win rows
    so the join to horse_number is cheap.
    """
    decisions = ", ".join(f"({int(m)})" for m in decision_minutes)
    pools_sql = ",".join(f"'{p}'" for p in pools)
    sql = f"""
    WITH
    decision_minutes(minutes_to_post) AS (VALUES {decisions}),
    races AS (
        SELECT
            race_id,
            scheduled_post_time,
            CAST(scheduled_post_time AS VARCHAR) AS scheduled_post_time_str,
            race_date,
            year
        FROM {lake_query.src(lake.silver_dataset("jravan_races"))}
        WHERE scheduled_post_time IS NOT NULL
          -- Phase 2 window: 2025-06-20 to 2026-06-14 (the timeseries coverage span)
          AND race_date >= TIMESTAMPTZ '2025-06-20'
          AND race_date <= TIMESTAMPTZ '2026-06-15'
    ),
    pairs AS (
        SELECT
            r.race_id AS race_id,
            r.scheduled_post_time AS scheduled_post_time,
            r.race_date AS race_date,
            r.year AS year,
            dm.minutes_to_post AS decision_minutes,
            r.scheduled_post_time - dm.minutes_to_post * INTERVAL '1 minute' AS as_of_time
        FROM races r
        CROSS JOIN decision_minutes dm
    ),
    -- Win odds rows at t
    win_snap AS (
        SELECT
            p.race_id,
            p.decision_minutes,
            p.race_date,
            ts.sel AS sel,
            CAST(ts.sel AS INTEGER) AS sel_int,
            ts.win_odds AS odds,
            ts.available_at AS available_at,
            ROW_NUMBER() OVER (
                PARTITION BY p.race_id, p.decision_minutes, ts.sel
                ORDER BY ts.available_at DESC NULLS LAST
            ) AS rn
        FROM pairs p
        JOIN {lake_query.src(lake.silver_dataset("jravan_odds_timeseries"))} ts
          ON ts.race_id = p.race_id
         AND ts.pool = 'win'
         AND ts.win_odds IS NOT NULL
         AND ts.win_odds > 0
         AND ts.available_at <= p.as_of_time
    ),
    -- Pool odds rows at t (the exotic being tested)
    pool_snap AS (
        SELECT
            p.race_id,
            p.decision_minutes,
            p.race_date,
            ts.pool AS pool,
            ts.sel AS sel,
            NULL::INTEGER AS sel_int,
            ts.win_odds AS odds,
            ts.available_at AS available_at,
            ROW_NUMBER() OVER (
                PARTITION BY p.race_id, p.decision_minutes, ts.pool, ts.sel
                ORDER BY ts.available_at DESC NULLS LAST
            ) AS rn
        FROM pairs p
        JOIN {lake_query.src(lake.silver_dataset("jravan_odds_timeseries"))} ts
          ON ts.race_id = p.race_id
         AND ts.pool IN ({pools_sql})
         AND ts.win_odds IS NOT NULL
         AND ts.win_odds > 0
         AND ts.available_at <= p.as_of_time
    )
    SELECT
        race_id, decision_minutes, race_date, 'win' AS kind,
        NULL::VARCHAR AS pool, sel, sel_int, odds, available_at
    FROM win_snap WHERE rn = 1
    UNION ALL
    SELECT
        race_id, decision_minutes, race_date, 'pool' AS kind,
        pool, sel, sel_int, odds, available_at
    FROM pool_snap WHERE rn = 1
    """
    table = lake_query.query(sql)
    rows = table.to_pylist()
    out: list[dict] = []
    for r in rows:
        out.append(
            {
                "race_id": r["race_id"],
                "decision_minutes": int(r["decision_minutes"]),
                "race_date": r["race_date"],
                "kind": r["kind"],
                "pool": r["pool"],
                "sel": r["sel"],
                "sel_int": r["sel_int"],
                "odds": float(r["odds"]) if r["odds"] is not None else None,
                "available_at": r["available_at"],
            }
        )
    return out


# ----------------------------------------------------------------------------
# Phase 3 -- realized-payout upper bound
# ----------------------------------------------------------------------------


@dataclass
class Phase3Row:
    pool: str
    bets: int
    mean_model_prob: float
    mean_payout_implied_prob: float
    mean_edge: float  # model - payout_implied
    median_edge: float
    mean_log_disagreement: float  # log(model / payout_implied)


def phase3_realized(
    lake: LakePaths,
    race_log: list[dict],
    win_probs_by_race: dict[str, dict[int, float]],
    gammas_by_race: dict[str, float],
) -> None:
    print("\n" + "=" * 78)
    print("PHASE 3 -- Realized-payout upper bound (trifecta/trio/exacta/wide)")
    print("=" * 78)
    print(
        "FRAMING (verbatim): Phase 3 is an UPPER BOUND on tradable edge for two\n"
        "compounding reasons: (1) you cannot transact at the closing payout ex\n"
        "ante; (2) the closing payout already incorporates late informed money,\n"
        "so any 'edge' observed against closing payouts is measured against a\n"
        "price that already discounted the same signal under test. This scopes\n"
        "whether capturing trifecta/trio odds time-series is worth pursuing --\n"
        "it is NOT a tradeable result."
    )

    payouts = _load_all_payouts(lake, PHASE3_POOLS)
    if not payouts:
        print("  No exotic payouts found.")
        return

    bracket_maps = _load_bracket_maps(lake)

    # For each payout, compute model prob for that exact combo.
    rows: list[dict] = []
    for p in payouts:
        rid = p["race_id"]
        wp = win_probs_by_race.get(rid)
        if not wp:
            continue
        gamma = gammas_by_race.get(rid, em.GAMMA_DEFAULT)
        pool = p["pool"]
        combo = p["combo"]
        model_p = _single_combo_prob(wp, pool, combo, gamma)
        if model_p is None or model_p <= 0:
            continue
        payout_yen = p["payout_yen"]
        if payout_yen is None or payout_yen <= 0:
            continue
        payout_implied = 100.0 / payout_yen
        rows.append(
            {
                "race_id": rid,
                "pool": pool,
                "combo": combo,
                "model_prob": float(model_p),
                "payout_implied_prob": float(payout_implied),
                "payout_yen": int(payout_yen),
                "edge": float(model_p - payout_implied),
                "log_disagreement": math.log(model_p / payout_implied),
            }
        )
    if not rows:
        print("  No matched exotic payouts (check market_baseline coverage).")
        return

    print(f"  Matched {len(rows):,} exotic payout rows.")
    df = pd.DataFrame(rows)

    for pool in PHASE3_POOLS:
        sub = df[df["pool"] == pool]
        if sub.empty:
            continue
        takeout = EXOTIC_TAKEOUT.get(pool, -0.25)
        print(
            f"\n  [{pool}] {len(sub):,} payouts "
            f"(takeout bar: model_prob > payout_implied_prob net of {takeout:+.3f})"
        )
        print(
            f"    mean(model)={sub['model_prob'].mean():.5f}  "
            f"mean(payout_implied={1.0 + takeout:.3f} adj)="
            f"{sub['payout_implied_prob'].mean():.5f}  "
            f"mean(edge)={sub['edge'].mean():+.5f}  "
            f"median(edge)={sub['edge'].median():+.5f}"
        )
        # Bucket by payout size (deep longshot vs favorite combo)
        buckets = [
            (0, 200, "<200"),
            (200, 500, "200-500"),
            (500, 1500, "500-1500"),
            (1500, 5000, "1500-5000"),
            (5000, 20000, "5000-20000"),
            (20000, math.inf, "20000+"),
        ]
        print("    payout-yen bucket        n    mean(model)  mean(payout_impl)  mean(edge)  log(disc)")
        for lo, hi, label in buckets:
            sl = sub[(sub["payout_yen"] >= lo) & (sub["payout_yen"] < hi)]
            if sl.empty:
                continue
            print(
                f"      {label:>12}  {len(sl):>6,}  {sl['model_prob'].mean():.5f}    "
                f"{sl['payout_implied_prob'].mean():.5f}        "
                f"{sl['edge'].mean():+.5f}    {sl['log_disagreement'].mean():+.3f}"
            )

    print(
        "\n  Phase 3 verdict: even if model agrees with payouts on average,\n"
        "  the disagreement cannot be monetized at the closing price. If you\n"
        "  see large mean(edges), the actionable next step is to capture exotic\n"
        "  odds time-series (currently only quinella + bracket_quinella have it)\n"
        "  and run the Phase 2 protocol on those pools."
    )


def _single_combo_prob(
    win_probs: dict[int, float],
    pool: str,
    combo: str,
    gamma: float,
) -> float | None:
    """Model probability for a single observed combo string."""
    # Parse the combo string based on pool.
    if pool in ("win", "place"):
        return None  # Phase 3 doesn't cover win/place
    if pool == "bracket_quinella":
        # Combo is 2 single-digit brackets. Skip Phase 3 for bracket_quinella
        # (Phase 2 already covered it). Caller excludes it.
        return None
    if not combo or not combo.isdigit():
        return None
    # 2-digit-per-horse parsing.
    if pool in ("quinella", "exacta", "wide"):
        if len(combo) != 4:
            return None
        a, b = int(combo[:2]), int(combo[2:])
        if a not in win_probs or b not in win_probs:
            return None
        if pool == "quinella":
            return em.henery_prob(win_probs, [a, b], gamma) + em.henery_prob(
                win_probs, [b, a], gamma
            )
        if pool == "exacta":
            return em.henery_prob(win_probs, [a, b], gamma)
        if pool == "wide":
            return em.wide_prob(win_probs, (a, b), gamma)
    if pool == "trifecta":
        if len(combo) != 6:
            return None
        a, b, c = int(combo[:2]), int(combo[2:4]), int(combo[4:6])
        if a not in win_probs or b not in win_probs or c not in win_probs:
            return None
        return em.henery_prob(win_probs, [a, b, c], gamma)
    if pool == "trio":
        if len(combo) != 6:
            return None
        a, b, c = (int(combo[:2]), int(combo[2:4]), int(combo[4:6]))
        if a not in win_probs or b not in win_probs or c not in win_probs:
            return None
        return sum(
            em.henery_prob(win_probs, list(perm), gamma)
            for perm in permutations((a, b, c))
        )
    return None


# ----------------------------------------------------------------------------
# Shared lake loaders
# ----------------------------------------------------------------------------


def _load_winning_combos(
    lake: LakePaths, pools: tuple[str, ...]
) -> dict[str, dict[str, set[str]]]:
    """Per race_id, per pool, set of winning combo strings.

    A combo is "winning" if it appears in ``jravan_payouts`` (one row per
    winning combo; dead-heats produce two rows which both count).
    """
    pools_sql = ",".join(f"'{p}'" for p in pools)
    sql = f"""
    SELECT race_id, pool, combo
    FROM {lake_query.src(lake.silver_dataset("jravan_payouts"))}
    WHERE pool IN ({pools_sql})
      AND combo IS NOT NULL
    """
    rows = lake_query.query(sql).to_pylist()
    out: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for r in rows:
        out[r["race_id"]][r["pool"]].add(r["combo"])
    return out


def _load_all_payouts(
    lake: LakePaths, pools: tuple[str, ...]
) -> list[dict]:
    pools_sql = ",".join(f"'{p}'" for p in pools)
    sql = f"""
    SELECT race_id, pool, combo, payout_yen
    FROM {lake_query.src(lake.silver_dataset("jravan_payouts"))}
    WHERE pool IN ({pools_sql})
      AND payout_yen IS NOT NULL
      AND payout_yen > 0
    """
    return lake_query.query(sql).to_pylist()


def _load_bracket_maps(lake: LakePaths) -> dict[str, dict[int, int]]:
    """Per race_id, {horse_number: bracket_id} from entries.gate (wakuban).

    Bracket assignment is STABLE CONTEXT -- declared at entry time, days
    before the race. PIT-filter on scheduled_post_time (not as_of_time):
    the gate column is correct as of entry declaration regardless of when
    the entries silver row was written.
    """
    sql = f"""
    SELECT
        en.race_id AS race_id,
        LIST(en.horse_number ORDER BY en.horse_number) AS horses,
        LIST(en.gate ORDER BY en.horse_number) AS brackets
    FROM {lake_query.src(lake.silver_dataset("jravan_race_entries"))} en
    WHERE en.horse_number IS NOT NULL
      AND en.gate IS NOT NULL
      AND en.gate > 0
    GROUP BY en.race_id
    """
    rows = lake_query.query(sql).to_pylist()
    out: dict[str, dict[int, int]] = {}
    for r in rows:
        horses = r["horses"] or []
        brackets = r["brackets"] or []
        if len(horses) != len(brackets):
            continue
        out[r["race_id"]] = {int(h): int(b) for h, b in zip(horses, brackets)}
    return out


if __name__ == "__main__":
    main()
