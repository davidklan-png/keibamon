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
    失格 / 降着                     NOT scratched -- POST-ADJUDICATION position
                                    shown in the 着順 cell (gate order is not
                                    what JRA settles on); we keep the parsed int.
    "" / "0" / "00"                 omitted from placings, NOT scratched

DNF horses (``中止``) don't get a placing and don't trigger refund -- they're
effectively non-top-3 finishers, so no exotic line can hit them. DQ
(``失格``) and demotion (``降着``) reorder the field for ticket settlement --
JRA pays on the POST-ADJUDICATION order, not the gate order. netkeiba's
着順 cell carries the corrected int position, which the parser reads
through unchanged. Only 取消/除外 refund.

OFFICIAL-CONFIRMATION GATE (ADR-0007 R2 Task 1). The producer must NOT
attach a ``result`` block while the race is still provisional (審議 /
保留) -- doing so would let a ticket auto-settle to "won", get shared as
a HIT card, and then have its placings overturned on adjudication. That
is the only path to a visibly-wrong, shareable settlement.

The ideal signal is an explicit 確定 vs 審議 marker on the page. The
netkeiba result.html static HTML carries NO such marker -- the 確定時刻
is stamped by client-side JS at runtime, so a server-rendered scrape
cannot see it (verified against
``tests/fixtures/netkeiba/result_202609030411.html``: grepping the
4886-line page for 審議|確定|保留 yields only the post-time string
"15:40発走"). The fallback signal is **confirmed payouts present**:
JRA withholds all exotic payout rows until the order is official, so a
non-empty ``payouts`` block (after the five-pool filter) is a strong
proxy for 確定. ``build_result`` returns ``{}`` when no resolver-relevant
payouts are present, regardless of whether placings parsed -- this is
the 審議 gate.

Limitations of the payouts-present proxy (acknowledged):

  - A confirmed race whose ENTIRE exotic card was cancelled (e.g. mass
    scratches leaving one runner) emits no payouts_out and is treated
    as provisional. Safe: the resolver has nothing to settle, so the
    race staying "open" is correct.
  - A parse failure on the Payout_Detail_Table blocks looks identical
    to a 審議 page. Safe: same outcome (no attach).
  - A page format change that MOVES the status marker into the static
    HTML would let us reinstate the preferred signal. Re-check before
    the capture-PC handoff (ADR-0004).
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

    Returns ``{}`` when the race isn't yet official. Two gates, in order:

      1. **Placings gate** -- no parsed top-3 finishers (race not yet run,
         under 審議 with no provisional placings, or parse failed).
      2. **Confirmation gate (R2 Task 1)** -- no resolver-relevant payouts
         present. JRA withholds exotic payouts until the order is 確定, so
         an empty ``payouts_out`` means the race is still provisional even
         if provisional placings parsed cleanly. Without this gate, a
         審議 page would attach placings that get overturned on
         adjudication -- the only path to a visibly-wrong, shareable
         settlement. See the module docstring for the signal-choice note.

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

    if not payouts_out:
        # Confirmation gate (R2 Task 1). JRA withholds exotic payouts until
        # the order is 確定. Empty payouts_out ⟹ race is still provisional
        # (審議 / 保留 / page parse missed the Payout_Detail_Table blocks)
        # even if provisional placings parsed cleanly. Attaching now would
        # let a ticket settle to "won" and then get overturned. Producer
        # omits the block; race stays "open" until the next cycle sees the
        # payouts. See module docstring for the signal-choice rationale.
        return {}

    out: dict[str, Any] = {"placings": placings, "payouts": payouts_out}
    if scratched:
        # Omit the key entirely when empty -- matches the resolver's
        # ``result.scratched ?? []`` and keeps the JSON tight.
        out["scratched"] = scratched
    return out
