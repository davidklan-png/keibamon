"""calibration.py -- pure scoring of settled model_card rows.

The honest verdict on whether our pre-market probabilities describe reality
(``modeling-spine.md`` step 4). Pure functions only: no I/O, no lake access, no
mutation. The caller passes settled rows (the output of
:func:`settle_card.settle_card`) plus optional market probabilities (for the
de-vigged-market bar).

Three lenses, each reported per ``posted_before_market`` slice and **never
blended across the flag** (ADR-0003 D3):

  1. **Calibration bins**: observed win-rate vs mean ``model_p``, with counts.
     Thin bins are flagged; never flatter a sparse bucket.
  2. **Probability quality**: per-race winner log-loss + per-runner Brier of
     ``model_p``, reported **against the de-vigged market** as the bar when
     market probabilities are supplied. The market is Model 0; a number that
     does not beat it is the expected null, and that is an honest verdict
     rather than a failure.
  3. **Top-pick ROI** at official payouts vs the ~-0.23 JRA win-takeout floor;
     report count and required sample size when a slice is too thin.

This is divergence measurement, not a bet recommender. No edge is claimed; the
lake's 6-for-6 null on public-data edges stands.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

# Default 0.1-wide probability bins from 0.0 to 1.0. The right edge is inclusive
# on the top bin so a probability of exactly 1.0 has a home.
_DEFAULT_BINS: list[tuple[float, float]] = [
    (i / 10.0, (i + 1) / 10.0) for i in range(10)
]

# Below this many runner-rows, a bin is flagged "thin" -- we report its raw
# numbers but never trust the mean as a calibration statement.
_THIN_BIN_MIN = 30

# Below this many top-pick bets, ROI is reported with a sample-size disclaimer.
# A small-sample ROI can move a lot on one or two longshots; do not headline it.
_THIN_ROI_MIN = 50

# JRA win takeout; the bar any "edge" must clear. Reported as context only -- we
# make no edge claim. The honest expected top-pick ROI net of takeout is ~-0.23.
_WIN_TAKEOUT_FLOOR = -0.23


# --- report shapes -----------------------------------------------------------


@dataclass(frozen=True)
class BinCalibration:
    """One probability-bin slice: predicted vs observed win-rate.

    ``gap > 0`` = model under-confident in this bin (horses won more often than
    the model said); ``gap < 0`` = over-confident. ``thin`` flags a sparse bin
    whose mean is not trustworthy as a calibration statement.
    """

    lo: float
    hi: float
    n: int
    mean_prob: float
    observed_win_rate: float
    thin: bool

    @property
    def gap(self) -> float:
        return self.observed_win_rate - self.mean_prob


@dataclass(frozen=True)
class ProbabilityQuality:
    """Per-race winner log-loss + per-runner Brier, model vs market.

    ``market_*`` are ``None`` when no market probabilities were supplied. The
    market is the bar: a model log-loss above ``market_log_loss`` is the
    expected null, not a failure -- the divergence is the payload.
    """

    races: int
    runners: int
    model_log_loss: float
    model_brier: float
    market_log_loss: float | None = None
    market_brier: float | None = None

    @property
    def model_log_loss_delta_vs_market(self) -> float | None:
        """model - market. Negative = model is closer to reality."""
        if self.market_log_loss is None:
            return None
        return self.model_log_loss - self.market_log_loss


@dataclass(frozen=True)
class TopPickROI:
    """Top-pick-only ROI at official payouts.

    ``roi`` is infinitesimal (gross payout / total stake - 1.0). The JRA
    ~-0.23 win takeout floor is the bar; anything around or below that is no
    edge. ``thin`` flags a sample too small to headline.
    """

    n: int
    stake_yen: int
    payout_yen: int
    refund_yen: int
    wins: int
    roi: float
    thin: bool

    @property
    def beats_takeout(self) -> bool:
        return (not self.thin) and self.roi > _WIN_TAKEOUT_FLOOR


@dataclass(frozen=True)
class SliceReport:
    """Calibration of one posted_before_market slice (clean OR contaminated).

    The full report carries one ``SliceReport`` per flag value; the headline is
    the clean slice (``posted_before_market=True``), contaminated is reported
    separately, and they are never blended.
    """

    posted_before_market: bool
    n_runners: int
    n_races: int
    bins: list[BinCalibration]
    probability: ProbabilityQuality
    top_pick_roi: TopPickROI


@dataclass(frozen=True)
class CalibrationReport:
    clean: "SliceReport | None"
    contaminated: "SliceReport | None"
    n_total: int

    @property
    def headline(self) -> "SliceReport | None":
        """The clean slice is the headline number per ADR-0003 D3."""
        return self.clean


# --- entry point -------------------------------------------------------------


def calibration_report(
    settled_rows: list[dict[str, Any]],
    *,
    market_prob_by_key: dict[tuple[str, int], float] | None = None,
    bins: list[tuple[float, float]] | None = None,
    thin_bin_min: int = _THIN_BIN_MIN,
    thin_roi_min: int = _THIN_ROI_MIN,
) -> CalibrationReport:
    """Build the calibration report, sliced by ``posted_before_market``.

    ``settled_rows`` are the dicts produced by ``settle_card``. ``market_prob_by_key``
    is an optional ``{(race_id, horse_number): devigged_market_prob}`` map; when
    supplied, log-loss / Brier are reported for both model and market so the
    divergence is visible. When omitted, only the model's number is reported.

    Returns a report whose ``clean`` slice (``posted_before_market=True``) is the
    headline; ``contaminated`` is the separate, never-blended counterpart.
    """
    bin_edges = bins or _DEFAULT_BINS
    pbm_groups: dict[bool, list[dict[str, Any]]] = _split_by_posted_before_market(settled_rows)

    clean = _build_slice(
        pbm_groups.get(True, []),
        posted_before_market=True,
        market_prob_by_key=market_prob_by_key,
        bins=bin_edges,
        thin_bin_min=thin_bin_min,
        thin_roi_min=thin_roi_min,
    )
    contaminated = _build_slice(
        pbm_groups.get(False, []),
        posted_before_market=False,
        market_prob_by_key=market_prob_by_key,
        bins=bin_edges,
        thin_bin_min=thin_bin_min,
        thin_roi_min=thin_roi_min,
    )
    return CalibrationReport(
        clean=clean,
        contaminated=contaminated,
        n_total=len(settled_rows),
    )


# --- per-slice builder -------------------------------------------------------


def _build_slice(
    rows: list[dict[str, Any]],
    *,
    posted_before_market: bool,
    market_prob_by_key: dict[tuple[str, int], float] | None,
    bins: list[tuple[float, float]],
    thin_bin_min: int,
    thin_roi_min: int,
) -> "SliceReport | None":
    if not rows:
        return None
    return SliceReport(
        posted_before_market=posted_before_market,
        n_runners=len(rows),
        n_races=len({(r["race_id"], int(r["card_version"])) for r in rows}),
        bins=_calibration_bins(rows, bins=bins, thin_min=thin_bin_min),
        probability=_probability_quality(rows, market_prob_by_key),
        top_pick_roi=_top_pick_roi(rows, thin_min=thin_roi_min),
    )


# --- lens 1: calibration bins ------------------------------------------------


def _calibration_bins(
    rows: list[dict[str, Any]],
    *,
    bins: list[tuple[float, float]],
    thin_min: int,
) -> list[BinCalibration]:
    """Observed win-rate vs mean ``model_p`` per probability bin.

    Bins are right-open ``[lo, hi)`` except the top bin which includes 1.0.
    Each runner contributes its ``model_p`` (predicted) and its ``won`` flag
    (0/1, observed). Thin bins (``n < thin_min``) are flagged.
    """
    acc = {b: {"n": 0, "sum_p": 0.0, "wins": 0} for b in bins}

    def find_bin(p: float):
        for i, b in enumerate(bins):
            lo, hi = b
            if i == len(bins) - 1:  # top bin inclusive on the right
                if lo <= p <= hi:
                    return b
            elif lo <= p < hi:
                return b
        return None

    for r in rows:
        p = float(r.get("model_p") or 0.0)
        b = find_bin(p)
        if b is None:
            continue
        a = acc[b]
        a["n"] += 1
        a["sum_p"] += p
        a["wins"] += 1 if r.get("won") else 0

    out: list[BinCalibration] = []
    for b in bins:
        a = acc[b]
        n = a["n"]
        if n == 0:
            out.append(BinCalibration(b[0], b[1], 0, float("nan"), float("nan"), thin=True))
            continue
        out.append(BinCalibration(
            lo=b[0], hi=b[1], n=n,
            mean_prob=a["sum_p"] / n,
            observed_win_rate=a["wins"] / n,
            thin=n < thin_min,
        ))
    return out


# --- lens 2: probability quality (log-loss + Brier) --------------------------


def _probability_quality(
    rows: list[dict[str, Any]],
    market_prob_by_key: dict[tuple[str, int], float] | None,
) -> ProbabilityQuality:
    """Per-race winner log-loss + per-runner Brier, model (and market if supplied).

    Log-loss: for each ``(race_id, card_version)`` with a known winner, take
    ``-log(prob_of_winner)``. Mean across races. Races without a known winner
    are skipped (e.g. scratched top pick or missing result).
    Brier: mean per-runner ``(prob - won)^2`` over all runner-rows.
    """
    by_race: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_race[(r["race_id"], int(r["card_version"]))].append(r)

    model_ll = 0.0
    market_ll = 0.0
    model_brier = 0.0
    market_brier = 0.0
    market_runner_count = 0
    runner_count = 0
    races_with_winner = 0

    for _, race_rows in by_race.items():
        winner = next((r for r in race_rows if r.get("won")), None)
        for r in race_rows:
            p_model = float(r.get("model_p") or 0.0)
            y = 1.0 if r.get("won") else 0.0
            model_brier += (p_model - y) ** 2
            runner_count += 1
            if market_prob_by_key is not None:
                p_market = market_prob_by_key.get((r["race_id"], int(r["horse_number"])))
                if p_market is not None:
                    market_brier += (float(p_market) - y) ** 2
                    market_runner_count += 1
        if winner is not None:
            p_w_model = float(winner.get("model_p") or 0.0)
            model_ll += -math.log(max(p_w_model, 1e-12))
            if market_prob_by_key is not None:
                p_w_market = market_prob_by_key.get(
                    (winner["race_id"], int(winner["horse_number"]))
                )
                if p_w_market is not None:
                    market_ll += -math.log(max(float(p_w_market), 1e-12))
            races_with_winner += 1

    if races_with_winner == 0:
        model_log_loss = float("inf")
    else:
        model_log_loss = model_ll / races_with_winner

    return ProbabilityQuality(
        races=races_with_winner,
        runners=runner_count,
        model_log_loss=model_log_loss,
        model_brier=(model_brier / runner_count) if runner_count else float("nan"),
        market_log_loss=(
            (market_ll / races_with_winner)
            if (market_prob_by_key is not None and races_with_winner)
            else None
        ),
        market_brier=(
            (market_brier / market_runner_count)
            if (market_prob_by_key is not None and market_runner_count)
            else None
        ),
    )


# --- lens 3: top-pick ROI ----------------------------------------------------


def _top_pick_roi(rows: list[dict[str, Any]], *, thin_min: int) -> TopPickROI:
    """Top-pick infinitesimal ROI at official payouts.

    Only rows with ``is_top_pick=True`` contribute (one bet per
    ``(race_id, card_version)``). ``stake_yen`` is the sum of hypothetical
    stakes; ``payout_yen`` is the sum of official payouts; ``refund_yen`` is the
    sum of scratch refunds. ``roi = (payout + refund) / stake - 1.0``.
    """
    top_rows = [r for r in rows if r.get("is_top_pick")]
    n = len(top_rows)
    if n == 0:
        return TopPickROI(
            n=0, stake_yen=0, payout_yen=0, refund_yen=0,
            wins=0, roi=float("nan"), thin=True,
        )
    stake = sum(int(r.get("stake_yen") or 0) for r in top_rows)
    payout = sum(int(r.get("payout_yen") or 0) for r in top_rows)
    refund = sum(int(r.get("refund_yen") or 0) for r in top_rows)
    wins = sum(1 for r in top_rows if (r.get("settle_reason") == "official_payout"))
    roi = ((payout + refund) / stake - 1.0) if stake else float("nan")
    return TopPickROI(
        n=n, stake_yen=stake, payout_yen=payout, refund_yen=refund,
        wins=wins, roi=roi, thin=(n < thin_min),
    )


# --- slicer ------------------------------------------------------------------


def _split_by_posted_before_market(
    rows: list[dict[str, Any]],
) -> dict[bool, list[dict[str, Any]]]:
    """Partition rows by the PIT flag. The two buckets are reported separately
    (clean = headline, contaminated = separately) and never blended."""
    out: dict[bool, list[dict[str, Any]]] = {True: [], False: []}
    for r in rows:
        flag = bool(r.get("posted_before_market"))
        out.setdefault(flag, []).append(r)
    return out
