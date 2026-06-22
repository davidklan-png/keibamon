"""ADR-0007 R1 — pure builder for the per-race ``result`` block.

The shape consumed by the ticket-settlement resolver
(``workers/social/src/settle.ts`` → ``frontend/src/lib/settle.ts`` is a thin
shim):

    result = {
        "placings":  [{"pos": 1, "umabans": [5]}, ...],   # dead-heat aware
        "scratched": [11, 4],                              # refunded umabans
        "payouts":   [{"pool": "quinella", "combo": "5-16", "yen": 1840}, ...],
    }

This module turns two FLAT lists -- the per-finisher records
:mod:`netkeiba_results` returns and the per-(pool, combo) records
:mod:`netkeiba_payouts` returns -- into that block. It is PURE (no I/O) so
the offline test suite covers the correctness contract without scraping
netkeiba.

Why a separate module (vs. inlining into ``expose_live.py`` or
``snapshot.py``):

  - ``snapshot.py`` stays a pure DISPLAY projection (entries + odds + status).
    Attaching settlement-grade payouts there would mix the display layer with
    the settlement layer.
  - ``expose_live.py`` is a CLI tool; inlining would make the logic
    untestable without importing a tool module.
  - A standalone pure module is the same pattern as ``snapshot.py``:
    producer/CLI orchestrates I/O, this module is the shape contract.

Pool mapping (silver vocabulary → resolver BetType):

    =================== ============== ==============================
    Source (silver)     Resolver      Notes
    =================== ============== ==============================
    win                 (omitted)     resolver ignores win/place
    place               (omitted)     resolver ignores win/place
    bracket_quinella    (omitted)     resolver doesn't support 枠連
    quinella            quinella      dash-joined umabans, ascending
    wide                wide          one row per pair (3 on a G1)
    exacta              exacta        dash-joined umabans, FINISH order
    trio                trio          dash-joined umabans, ascending
    trifecta            trifecta      dash-joined umabans, FINISH order
    =================== ============== ==============================

The five exotic names pass through verbatim -- silver and the resolver share
the vocabulary by construction. The resolver canonicalizes unordered pools
to ascending on its own (``comboKey`` in settle.ts), so producers can emit
the dash-joined form in either order without coordinating.

Scratched detection (finish_position_raw from netkeiba_results):

    取消 / 出走取消 / 取消(発走前)  scratched -- 返還 (refund)
    除外                            scratched -- 返還
    中止                            NOT scratched -- finished mid-race, no refund
    失格                            NOT scratched -- DQ; placings stand at gate order
    "" / "0" / "00"                 omitted from placings, NOT scratched

DNF horses (``中止``) don't get a placing and don't trigger refund -- they're
effectively non-top-3 finishers, so no exotic line can hit them. DQ
(``失格``) keeps the gate-order placing for ticket settlement (JRA pays on
the original finish, then applies DQ penalties separately); we keep the
parsed int placing. Only 取消/除外 refund.
"""
from __future__ import annotations

from typing import Any, Iterable

# Resolver-supported exotic bet types. Silver's pool vocabulary for these five
# names is identical; anything else is dropped (resolver can't settle it).
_BET_TYPES: frozenset[str] = frozenset(
    {"quinella", "wide", "exacta", "trio", "trifecta"}
)

# 着順 cell text that marks a scratch (返還 / refund-eligible at the gate).
# Anything else (numeric placing, 中止, 失格, blank) does NOT trigger refund.
# Source: JRAFund.com betting rules -- 出走取消 + 除外 are the refund cases.
_SCRATCH_MARKERS: frozenset[str] = frozenset(
    {"取消", "出走取消", "取消(発走前)", "除外"}
)


def build_result(
    finishers: Iterable[dict[str, Any]],
    payouts: Iterable[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the resolver's ``result`` block from flat parser outputs.

    Returns ``{}`` when the race isn't yet official (no placings extracted).
    The producer checks for emptiness and omits the ``result`` key from the
    race dict -- snapshot.build_race then leaves status at ``open``.

    Inputs:

      ``finishers`` -- list of dicts from
      :func:`netkeiba_results.parse_results_payload`. Each carries
      ``horse_number`` (int umaban), ``finish_position`` (int placing or
      None), and ``finish_position_raw`` (str; non-empty for 取消/中止/etc.).

      ``payouts`` -- list of dicts from
      :func:`netkeiba_payouts.parse_payouts_payload`. Each carries ``pool``
      (silver vocabulary), ``combo_raw`` (dash-joined umabans like ``'5-16'``;
      bare digits like ``'16'`` for win/place), and ``payout_yen`` (int).

    Output (matches ``RaceResult`` in workers/social/src/settle.ts):

      - ``placings``: one entry per finishing position; dead-heat positions
        carry multiple umabans. Excludes DNF/scratched. Empty if no placings
        could be derived (race not official).
      - ``scratched``: umabans marked 取消/除外 at the gate. Refund-eligible
        per JRA rules.
      - ``payouts``: one entry per (pool, combo, yen) from the source
        page, filtered to the five resolver-supported pools.
    """
    placings_by_pos: dict[int, list[int]] = {}
    scratched: list[int] = []

    for f in finishers:
        umaban = f.get("horse_number")
        if umaban is None:
            continue  # parser invariant -- shouldn't happen, defensive
        raw = f.get("finish_position_raw") or ""
        if raw in _SCRATCH_MARKERS:
            scratched.append(int(umaban))
            continue
        pos = f.get("finish_position")
        if pos is None or pos <= 0:
            # 中止 / 失格-without-pos / unparsed -- not a placing, not a
            # scratch. The resolver treats umabans absent from placings as
            # non-top-3; refund is NOT triggered.
            continue
        placings_by_pos.setdefault(int(pos), []).append(int(umaban))

    placings = [
        {"pos": pos, "umabans": sorted(ums)}
        for pos, ums in sorted(placings_by_pos.items())
    ]

    if not placings:
        # No official top-3 -- race hasn't run, under 審議 with no placings
        # yet, or parse failed. Producer omits the block; UI keeps showing
        # the commit-time estimate.
        return {}

    payouts_out: list[dict[str, Any]] = []
    for p in payouts:
        pool = p.get("pool")
        if pool not in _BET_TYPES:
            continue
        combo_raw = p.get("combo_raw")
        yen = p.get("payout_yen")
        if combo_raw is None or yen is None:
            continue
        payouts_out.append(
            {
                "pool": pool,
                "combo": str(combo_raw),
                "yen": int(yen),
            }
        )

    out: dict[str, Any] = {"placings": placings, "payouts": payouts_out}
    if scratched:
        # Omit the key entirely when empty -- matches the resolver's
        # ``result.scratched ?? []`` and keeps the JSON tight.
        out["scratched"] = scratched
    return out
