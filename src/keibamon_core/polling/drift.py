"""drift.py -- residual odds-drift detection (signal vs pool-fill noise).

A raw "odds shortened X% from open" flag is mostly noise: early in a race the
win pool is tiny, so the *whole field* compresses as money arrives. Flagging any
horse that shortens >=12% lights up half the card and hides the real moves.

The honest signal is *residual*: how much a runner moved relative to its own
race's field-wide compression at the same instant. We work in log-odds so that
shortening and drifting-out are symmetric, take the field **median** log-drift as
the baseline (robust to a few big movers), scale residuals by a robust MAD, and
flag only runners that are BOTH statistically unusual (|z| >= z_threshold) AND
materially moved (|residual| >= min_resid). That keeps a tight-but-quiet field
from over-flagging and a noisy early pool from flagging at all.

This is a market-movement *indicator*, not a validated edge. This project's own
evidence (mining/going both fail the market test; market-disagreement is usually
the side that's wrong) says late money is frequently as uninformed as early
money. Treat a flag as something to watch and to *log for the curve backtest*,
never as a reason to bet. Shared by the netkeiba feed and the JV-Link worker so
both speak the same language.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Hashable, Iterable

# Tunables (conservative defaults; one place to change for both producers).
Z_THRESHOLD = 1.5        # robust z vs field; |z|>=this is "unusual"
MIN_RESID = 0.08         # >=8% move vs field; below this, ignore even if z is big
MIN_FIELD = 6            # need this many priced runners to trust a field baseline
SCRATCH_ODDS = 900.0     # netkeiba parks scratched/no-bet at 999.9 -> exclude
_MAD_TO_SD = 1.4826      # MAD -> sd scaling for a normal


@dataclass(frozen=True)
class EdgeFlag:
    """A residual-drift callout for one runner."""
    direction: str       # "firming" (money in) | "draining" (money out)
    resid_pct: float     # signed move vs field, fractional (-0.18 = 18% shorter than field)
    z: float             # robust z of the residual
    label: str           # short chip text for the dashboard


def residual_edges(
    rows: Iterable[tuple[Hashable, float | None, float | None]],
    *,
    z_threshold: float = Z_THRESHOLD,
    min_resid: float = MIN_RESID,
    min_field: int = MIN_FIELD,
    scratch_odds: float = SCRATCH_ODDS,
) -> dict[Hashable, EdgeFlag]:
    """Flag runners moving against their race's own grain.

    rows: (key, current_win_odds, opening_win_odds) per runner. Returns a dict
    keyed by the runner key for those that earn a flag; runners with missing,
    scratched, or unremarkable moves are simply absent.
    """
    drifts: dict[Hashable, float] = {}
    for key, win, opn in rows:
        if (
            win and opn
            and 0 < win < scratch_odds
            and 0 < opn < scratch_odds
        ):
            drifts[key] = math.log(win / opn)   # <0 shortening, >0 drifting out

    if len(drifts) < min_field:
        return {}

    vals = list(drifts.values())
    med = statistics.median(vals)
    mad = statistics.median([abs(v - med) for v in vals]) * _MAD_TO_SD
    scale = mad if mad > 1e-6 else (statistics.pstdev(vals) or 1e-6)

    edges: dict[Hashable, EdgeFlag] = {}
    for key, d in drifts.items():
        resid = d - med
        z = resid / scale
        resid_pct = math.exp(resid) - 1.0          # signed fractional move vs field
        if abs(resid_pct) < min_resid or abs(z) < z_threshold:
            continue
        if resid_pct < 0:
            label = f"▼{abs(resid_pct) * 100:.0f}% vs field"   # ▼ firming
            edges[key] = EdgeFlag("firming", resid_pct, z, label)
        else:
            label = f"▲{resid_pct * 100:.0f}% vs field"        # ▲ draining
            edges[key] = EdgeFlag("draining", resid_pct, z, label)
    return edges
