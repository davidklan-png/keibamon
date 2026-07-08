"""pipeline.py -- the four-stage weekend loop, with hard device guards.

See docs/adr/0003-weekend-pipeline.md. Each stage asserts it is running on the
device the topology assigns it (docs/device-topology.md) BEFORE doing any work,
so a stage can never silently run on the wrong host (e.g. the live curve on the
traveling laptop, or JV-Link on the Mac).

  select  (Mac)          -> stage 1: pick races/runners from the lake.
  post    (Mac)          -> stage 2: freeze model_card + push our odds to D1.
  track   (Mac)          -> stage 3: live odds time-series (the only live job).
  settle  (Mac)          -> stage 4: settle at official payouts; score the card.

ADR-0004 collapses every stage's guard to ``mac-dev`` (the capture PC is
retired; the netkeiba feed on the Mac is the sole live source). Stage 3
carries the operational risk: a missed curve is gone, because the JV-Link
``0B41/0B42`` 1-year backfill dies with the PC. So ``track`` preflights sleep
inhibition + ``CF_*`` before the loop, banks every snapshot to silver
``odds_snapshots`` (lake first), and pushes the D1 projection best-effort.

This module is orchestration only -- it wires existing modules together and
enforces the boundaries. The real work lives in:
  - weekend.model_card.freeze_model_card  (stage 2)
  - ingestion.odds.append_odds_snapshots  (stage 3 lake write)
  - polling.netkeiba / polling.drift      (stage 3 fetch+parse+drift)
  - ingestion.curve_log                   (stage 3 freeze -> stage 4 settle)
  - ingestion.settlement / tools.jravan.settle_curve_log (stage 4)
  - tools/jravan/publish_d1.push_to_d1    (D1 projection, all stages)
"""
from __future__ import annotations

import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from keibamon_core.weekend.calibration import calibration_report
from keibamon_core.weekend.model_card import freeze_model_card
from keibamon_core.weekend.settle_card import settle_card

# Role tokens mirror tools/whichdevice.py / .device. Kept here so the guard does
# not import the CLI module; the source of truth for the map is whichdevice.py.
ROLE_FILE_DEFAULT = Path(__file__).resolve().parents[3] / ".device"


class WrongDeviceError(RuntimeError):
    """Raised when a stage is invoked on a device the topology forbids."""


def current_role(role_file: Path | None = None) -> str | None:
    """Read the machine-local role token from .device (gitignored).

    Returns None if .device is absent -- the caller decides whether to refuse
    (device-specific work) or proceed. Mirrors whichdevice.py's parse so the two
    never drift on the file format.
    """
    path = role_file or ROLE_FILE_DEFAULT
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line.startswith("role") and "=" in line:
            return line.split("=", 1)[1].strip()
    return None


def _require_role(allowed: tuple[str, ...], stage: str, role_file: Path | None = None) -> str:
    role = current_role(role_file)
    if role is None:
        raise WrongDeviceError(
            f"stage {stage!r} needs a .device file (one of {allowed}); none found. "
            "cp .device.example .device and set role -- do not guess."
        )
    if role not in allowed:
        raise WrongDeviceError(
            f"stage {stage!r} must run on {allowed}, but this device is {role!r}. "
            "See docs/device-topology.md."
        )
    return role


# --- Stage 1: selection (Mac) ------------------------------------------------

def select(
    lake: Any,
    race_date: str,
    *,
    role_file: Path | None = None,
    venue: str | None = None,
    min_field_size: int = 1,
    include_run: bool = False,
    races: list[int] | None = None,
    grades: tuple[str, ...] | None = None,
) -> list[str]:
    """Pick the race_ids on the card we will post for. Mac-only (lake + ML).

    Selects **races** (not horses -- horse-level ranking is stage 2's
    :func:`freeze_model_card`). Offline and deterministic; safe to run Thu/Fri
    ahead of the weekend.

    Reads the ``races`` mart scoped to ``race_date`` via :mod:`lake_query`
    predicate pushdown (DuckDB does the filter inside the engine -- only the
    matching rows cross into Python, per CLAUDE.md's read-path rule). Default
    filter is the PIT-honest upcoming set -- ``race_date == target AND
    field_size >= min_field_size AND results_available == False`` -- i.e. what
    we can still post a pre-market card for. ``include_run=True`` lifts the
    results gate for backfilling / replays.

    The ``races`` mart carries a normalized ``grade`` column (G1/G2/G3/JG1/
    JG2/JG3 or NULL). ``grades=("G1","G2","G3")`` filters to graded only --
    the ADR-0003/0004 polite-volume policy is "live odds = graded only by
    default"; pass ``None`` (the default) for the unfiltered card.

    Optional ``venue`` matches ``racecourse``; optional ``races`` is a
    race-number subset (e.g. ``[1, 2, 11]``).

    Returns canonical ``race_id``\\ s sorted by ``scheduled_post_time`` then
    ``race_id`` (the day's running order). An empty result is a valid answer
    (no card / wrong date / no graded race matches) -- returns ``[]``, never
    raises on the filter. A wrong device still raises :class:`WrongDeviceError`.

    See :func:`select_specs` for the ``(race_id, scheduled_post_time)``
    companion; ``track``'s adaptive cadence reads post times from there to
    avoid re-querying the mart.
    """
    return [
        rid for rid, _post in select_specs(
            lake, race_date,
            role_file=role_file, venue=venue,
            min_field_size=min_field_size,
            include_run=include_run, races=races, grades=grades,
        )
    ]


def select_specs(
    lake: Any,
    race_date: str,
    *,
    role_file: Path | None = None,
    venue: str | None = None,
    min_field_size: int = 1,
    include_run: bool = False,
    races: list[int] | None = None,
    grades: tuple[str, ...] | None = None,
) -> list[tuple[str, Any]]:
    """Same selection as :func:`select`, but returns
    ``(race_id, scheduled_post_time)`` tuples so the caller (e.g.
    :func:`track`'s adaptive cadence) gets the post times without re-reading
    the mart.

    ``scheduled_post_time`` may be ``None`` (the mart allows NULL); callers
    that rely on it should handle that. Order matches :func:`select`.
    """
    _require_role(("mac-dev",), "select", role_file)

    from keibamon_core import lake_query
    from keibamon_core.ingestion.marts import MART_RACES

    mart_path = lake.mart(MART_RACES)
    if not mart_path.exists():
        return []

    target_date = _normalize_race_date(race_date)
    preds = ["CAST(race_date AS DATE) = ?"]
    params: list[Any] = [target_date]
    if not include_run:
        preds.append("NOT results_available")
    if min_field_size > 0:
        preds.append("COALESCE(field_size, 0) >= ?")
        params.append(min_field_size)
    if venue:
        preds.append("LOWER(racecourse) = ?")
        params.append(venue.lower())
    if grades:
        # Filter to the normalized grade label set. NULL grade (non-graded
        # races) never matches -- the ADR-0003/0004 policy is "graded only".
        placeholders = ", ".join("?" for _ in grades)
        preds.append(f"grade IN ({placeholders})")
        params.extend(grades)

    sql = (
        f"SELECT race_id, scheduled_post_time "
        f"FROM {lake_query.src(mart_path)} "
        f"WHERE {' AND '.join(preds)} "
        f"ORDER BY scheduled_post_time NULLS LAST, race_id"
    )
    rows = lake_query.query(sql, params=params).to_pylist()

    if races:
        wanted = {int(n) for n in races}
        rows = [r for r in rows if _parse_race_no(r["race_id"]) in wanted]

    return [(r["race_id"], r["scheduled_post_time"]) for r in rows]


def _normalize_race_date(value: str) -> date:
    """Accept ``YYYYMMDD`` or ``YYYY-MM-DD`` and return a ``date``.

    The ``races`` mart stores ``race_date`` as a UTC datetime (silver carries
    it through ``_ensure_utc``); comparing ``CAST(race_date AS DATE) = ?`` with
    a Python ``date`` parameter is portable across TIMESTAMP / TIMESTAMPTZ
    storage and sidesteps the session-tz display gotcha (memory: DuckDB
    projects TIMESTAMPTZ to the session tz on read).
    """
    s = value.strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(
        f"race_date must be YYYYMMDD or YYYY-MM-DD, got {value!r}"
    )


# --- Stage 2: posting (Mac) --------------------------------------------------

def post(
    lake: Any,
    race_ids: list[str],
    *,
    predictor: Any,
    role_file: Path | None = None,
    push_d1: bool = True,
    push_fn: Any = None,
) -> dict[str, Any]:
    """Freeze our model_card (our odds + gate) pre-market and push to D1. Mac-only.

    For each race: call :func:`weekend.model_card.freeze_model_card` (append-only,
    soft pre-market gate per ADR-0003 D3). After ALL lake writes succeed, project
    the frozen cards into a D1 document and push via
    :func:`tools.jravan.publish_d1.push_to_d1` (key ``model_cards``).

    Lake first, D1 after (ADR-0003 D4): the lake writes have already landed
    before any network call, so a D1 failure (missing creds, network, non-2xx)
    does NOT lose a card. CF_* env vars are preflighted; if any are missing the
    push is recorded as skipped with the reason, not raised -- the lake is the
    record, D1 is disposable display.

    ``push_fn`` is an injection seam for tests; production resolves to the
    importlib-loaded ``tools.jravan.publish_d1.push_to_d1``.
    """
    _require_role(("mac-dev",), "post", role_file)

    # 1. LAKE FIRST -- freeze every race before any network call. A failure here
    #    aborts the stage with a partial card set; the lake is still internally
    #    consistent (each completed race's rows are durable).
    new_rows: list[dict[str, Any]] = []
    for rid in race_ids:
        new_rows.extend(freeze_model_card(lake, rid, predictor=predictor))

    # 2. D1 AFTER -- best-effort projection. Never raises over the lake write.
    d1_result = _push_to_d1_best_effort(new_rows, push_d1=push_d1, push_fn=push_fn)
    return {
        "races_posted": len(race_ids),
        "rows_written": len(new_rows),
        "card_versions": sorted({r["card_version"] for r in new_rows}),
        "d1": d1_result,
    }


# Resolve tools/jravan/publish_d1.py lazily -- tools/ is not a Python package, so
# we load it by path (same pattern as tests/test_publish_d1.py). Resolved on first
# push so an absent tools/ tree does not break importing this module.
_PUBLISH_D1_PATH = (
    Path(__file__).resolve().parents[3] / "tools" / "jravan" / "publish_d1.py"
)


def _load_push_to_d1():
    import importlib.util
    spec = importlib.util.spec_from_file_location("publish_d1", _PUBLISH_D1_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load publish_d1 from {_PUBLISH_D1_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.push_to_d1


def _missing_cf_creds() -> list[str]:
    """The CF_* env vars ``push_to_d1`` reads via ``os.environ``; empty when all present.

    Shared by every D1 push path (post / settle / track) so the missing-cred
    check never drifts between them. Per CLAUDE.md the CF_* vars don't persist
    across Mac shells -- a missing cred is a startup-preflight concern, not a
    silent per-cycle drop.
    """
    return [
        k for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN")
        if not os.environ.get(k)
    ]


def _push_to_d1_best_effort(rows, *, push_d1: bool, push_fn: Any) -> dict[str, Any]:
    """Project frozen cards into a D1 document and push, swallowing failures.

    Returns a status dict so the caller can record the D1 outcome without losing
    the lake write that already succeeded.

    A caller-supplied ``push_fn`` bypasses the CF_* preflight: tests inject a
    fake pusher and own its behavior, so the env-var guard (which is about the
    production urllib path that reads CF_* via os.environ) does not apply.
    """
    if not push_d1:
        return {"status": "disabled"}

    snapshot = _project_cards_snapshot(rows)
    if push_fn is None:
        missing = _missing_cf_creds()
        if missing:
            return {
                "status": "skipped",
                "reason": f"missing CF_* env vars: {missing}",
                "hint": "source CF_* creds before re-running; lake write already landed.",
            }
        fn = _load_push_to_d1()
    else:
        fn = push_fn

    try:
        response = fn(snapshot, key="model_cards")
        meta = ((response.get("result") or {}).get("meta") or {}) if isinstance(response, dict) else {}
        ok = bool(meta.get("changes", 0))
        return {
            "status": "ok" if ok else "pushed",
            "key": "model_cards",
            "rows": len(rows),
            "response": response,
        }
    except Exception as exc:  # noqa: BLE001 -- D1 is disposable; never re-raise over the lake write
        return {
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "hint": "lake write already landed; re-run push manually if needed.",
        }


def _project_cards_snapshot(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn frozen model_card rows into the JSON document pushed to D1.

    One document keyed ``model_cards`` carrying per-race cards (runner-level
    fair-odds + gate + posted_before_market). This is a derived, disposable
    projection of the lake; D1's loss does not lose the cards.
    """
    by_race: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_race.setdefault(r["race_id"], []).append(r)

    races = []
    for rid, race_rows in sorted(by_race.items()):
        race_rows.sort(key=lambda r: (r.get("card_version", 0), int(r["horse_number"])))
        head = race_rows[0]
        races.append({
            "race_id": rid,
            "card_version": head["card_version"],
            "posted_at": head["posted_at"],
            "posted_before_market": head["posted_before_market"],
            "predictor_name": head["predictor_name"],
            "runners": [
                {
                    "horse_number": int(r["horse_number"]),
                    "gate": r.get("gate"),
                    "model_p": r["model_p"],
                    "model_fair_odds": r["model_fair_odds"],
                }
                for r in race_rows
            ],
        })
    return {
        "meta": {
            "stage": "post",
            "published_at": _utc_now_iso_helper(),
            "rows": len(rows),
            "races": len(races),
        },
        "races": races,
    }


def _utc_now_iso_helper() -> str:
    # Local helper to avoid importing datetime at module top just for this.
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


# --- Stage 3: day-of curve (mac-dev only -- ADR-0004) -----------------------
#
# ADR-0004 retires the capture PC; the Mac is the sole device and the live
# source is the netkeiba feed. With JV-Link retired there is no 0B41/0B42
# 1-year backfill -- an intraday curve not captured live is lost forever, so
# the preflight discipline below (sleep inhibition + CF_* preflight) is
# race-day critical. This is the only UNRECOVERABLE weekend job.

_JST = timezone(timedelta(hours=9))


def track(
    lake: Any,
    race_ids: list[str],
    *,
    role_file: Path | None = None,
    poll_seconds: int = 120,
    tighten_poll_seconds: int = 30,
    tighten_within_minutes: float = 10.0,
    inhibit_sleep: bool = True,
    fetch_fn: Any = None,
    push_fn: Any = None,
    nk_race_ids: list[str] | None = None,
    post_times_jst: list[str] | None = None,
    race_names: list[str] | None = None,
    snapshot_key: str = "netkeiba_track",
    max_cycles: int | None = None,
    sleep_fn: Any = None,
    alerter: Any = None,
) -> dict[str, Any]:
    """Capture the live odds time-series, announcement -> post. mac-dev only.

    Loop: each cycle is one :func:`track_once` pass over ``race_specs`` -- for
    each race, fetch+parse the netkeiba odds, append to silver ``odds_snapshots``
    (**lake first**), then push the whole-card snapshot to D1 best-effort. The
    unchanged-timestamp backoff falls out of ``append_odds_snapshots``' dedupe
    on ``(race_id, horse_number, available_at)``: if netkeiba hasn't updated,
    the append returns 0 and the cycle is a no-op for that race.
    ``tighten_within_minutes`` shortens the cadence when a race is approaching
    its post time.

    Restartable: the dedupe means a crash and restart picks up where the curve
    left off without duplicating rows or losing the opening-odds baseline.

    Preflight (the two failures that cost the June 14 curves):

      - **Sleep inhibition.** Spawns ``caffeinate -dis`` for the loop's lifetime
        (display + idle + system sleep). Per CLAUDE.md ``caffeinate -i`` does
        NOT hold against a closed lid -- the user must ALSO disable lid Sleep
        in System Settings > Battery; this function only handles the
        caffeinate half. If spawn fails it warns loudly and continues (we
        cannot reliably verify sleep state from userspace, and refusing would
        sacrifice the curve to a false negative).
      - **CF_* creds.** Loud startup warning if missing; the loop still banks
        the curve, push is skipped per cycle with a reason.

    Injection seams for tests: ``fetch_fn`` / ``push_fn`` mirror :func:`post`;
    ``sleep_fn(seconds)`` replaces ``time.sleep``; ``max_cycles=N`` stops after
    N cycles so the test runs one pass; ``inhibit_sleep=False`` skips the
    caffeinate spawn entirely. Device guard is the single source of truth here
    (ADR-0003 D1 / ADR-0004) -- the CLI does NOT re-check.

    Loud-failure alerting (ADR-0004 mandatory monitoring): a
    :class:`keibamon_core.alerting.CaptureAlerter` is fed each cycle's
    ok/failed fetch counts — consecutive total-failure cycles or a stale
    capture push a phone notification via ntfy (``KEIBAMON_NTFY_TOPIC``).
    ``alerter`` is the injection seam: pass a fake to test, or ``False`` to
    disable entirely. Alerting is best-effort and can never break the loop.
    """
    _require_role(("mac-dev",), "track", role_file)

    race_specs = _resolve_race_specs(
        race_ids,
        nk_race_ids=nk_race_ids,
        post_times_jst=post_times_jst,
        race_names=race_names,
    )

    # --- preflight: print loudly, do not refuse (a false negative would cost
    #     the curve; the lake capture is what's unrecoverable, the push isn't).
    # A caller-supplied push_fn bypasses the CF_* preflight (tests own their
    # fake pusher); mirror _push_to_d1_best_effort's bypass.
    cred_warning = _preflight_creds_or_warn(push_fn=push_fn)
    sleep_proc, sleep_warning = (None, None)
    if inhibit_sleep:
        sleep_proc, sleep_warning = _inhibit_sleep_or_warn()

    if alerter is None:
        from keibamon_core.alerting import CaptureAlerter
        alerter = CaptureAlerter()

    try:
        open_state: dict[tuple[str, int], float] = {}
        cycles: list[dict[str, Any]] = []
        cycle_no = 0
        while True:
            cycle_no += 1
            cycle = track_once(
                lake, race_specs,
                fetch_fn=fetch_fn, push_fn=push_fn,
                open_state=open_state, snapshot_key=snapshot_key,
            )
            cycles.append(cycle)
            if alerter:
                try:
                    failed = cycle.get("fetch_failures", 0)
                    alerter.record_cycle(ok=cycle["races"] - failed, failed=failed)
                except Exception as exc:  # noqa: BLE001 - alerting never kills capture
                    print(f"alerter error ({exc!r}); continuing", file=sys.stderr)
            if max_cycles is not None and cycle_no >= max_cycles:
                break
            _sleep_between_cycles(
                race_specs, sleep_fn,
                poll_seconds=poll_seconds,
                tighten_poll_seconds=tighten_poll_seconds,
                tighten_within_minutes=tighten_within_minutes,
            )
    finally:
        if sleep_proc is not None:
            sleep_proc.terminate()

    return {
        "stage": "track",
        "device": "mac-dev",
        "race_ids": list(race_ids),
        "cycles": cycles,
        "preflight": {"cf_creds": cred_warning, "sleep": sleep_warning},
    }


def track_once(
    lake: Any,
    race_specs: list[dict[str, Any]],
    *,
    fetch_fn: Any = None,
    push_fn: Any = None,
    push_d1: bool = True,
    open_state: dict[tuple[str, int], float] | None = None,
    snapshot_key: str = "netkeiba_track",
) -> dict[str, Any]:
    """One polling cycle. Lake-first per race, then best-effort D1 push.

    For each race in ``race_specs``:

      1. ``fetch_fn(spec["nk_race_id"]) -> payload_text`` (production: the
         polite conditional-GET fetcher in ``polling.netkeiba``; tests inject
         a fixture-returning stub so the loop runs offline).
      2. Parse via :func:`polling.netkeiba.parse_odds_payload` -> silver
         ``odds_snapshots`` row shape.
      3. **Lake first**: :func:`ingestion.odds.append_odds_snapshots` banks
         the curve (deduped on ``(race_id, horse_number, available_at)``).
      4. Track opening odds (first sighting wins) and residual drift
         (:func:`polling.drift.residual_edges`) -- display only, NEVER a bet
         signal (ADR-0003 "explicitly out of scope").

    After every race is banked, the whole-card snapshot is projected and pushed
    via ``push_fn`` (production: :func:`tools.jravan.publish_d1.push_to_d1`;
    tests inject a stub). A push failure does NOT lose any lake write --
    ADR-0003 D4 (lake is the record, D1 is disposable display).

    ``open_state`` is the cross-cycle opening-odds cache; the caller passes the
    same mutable dict each cycle so the opening-odds baseline survives restarts
    within a process. (Across process restarts the baseline is rebuilt from the
    earliest ``odds_snapshots`` row on disk if needed by downstream consumers --
    ``build_curve_records`` derives ``open_odds`` from the earliest snapshot.)

    Returns a per-cycle summary dict.
    """
    from keibamon_core.ingestion.odds import append_odds_snapshots
    from keibamon_core.polling.drift import residual_edges
    from keibamon_core.polling.netkeiba import (
        fetch_odds_payload as _default_fetch,
        parse_odds_payload,
    )

    fetch = fetch_fn or _default_fetch
    open_state = open_state if open_state is not None else {}

    races_out: list[dict[str, Any]] = []
    total_banked = 0
    fetch_failures = 0
    for spec in race_specs:
        race_id = spec["race_id"]
        nk_id = spec["nk_race_id"]
        captured = datetime.now(timezone.utc)
        try:
            payload = fetch(nk_id)
            recs = parse_odds_payload(
                payload, race_id=race_id,
                raw_uri=f"netkeiba:{nk_id}", captured_at=captured,
            )
        except Exception as exc:  # noqa: BLE001 - one race must not kill the cycle
            print(f"  {race_id}: fetch/parse failed ({exc!r})", file=sys.stderr)
            races_out.append(_empty_race_snapshot(spec, captured, reason=f"fetch_failed: {exc!r}"))
            fetch_failures += 1
            continue

        # LAKE FIRST: bank the curve before any push runs. A failure here is
        # logged but does not abort the cycle -- the other races still capture.
        try:
            banked = append_odds_snapshots(lake, recs)
            total_banked += banked
        except Exception as exc:  # noqa: BLE001
            print(f"  {race_id}: lake append failed ({exc!r})", file=sys.stderr)
            banked = 0

        # Opening-odds cache + residual drift (display only -- NOT a bet).
        drift_rows = []
        for r in recs:
            uma, win = r["horse_number"], r.get("win_odds")
            key = (race_id, uma)
            if win and key not in open_state:
                open_state[key] = win  # first sighting = opening price
            drift_rows.append((uma, win, open_state.get(key)))
        edges = residual_edges(drift_rows)

        races_out.append(_race_snapshot(spec, recs, open_state, edges, captured, banked))

    snapshot = _project_track_snapshot(race_specs, races_out)
    push_result = _push_track_to_d1_best_effort(
        snapshot, push_d1=push_d1, push_fn=push_fn, key=snapshot_key,
    )
    return {
        "cycle_at": snapshot["meta"]["published_at"],
        "races": len(races_out),
        "fetch_failures": fetch_failures,
        "snapshots_banked": total_banked,
        "movers": sum(
            1 for r in races_out for x in r["runners"] if x.get("edge_label")
        ),
        "d1": push_result,
    }


# --- track internals ---------------------------------------------------------


def _resolve_race_specs(
    race_ids: list[str],
    *,
    nk_race_ids: list[str] | None = None,
    post_times_jst: list[str] | None = None,
    race_names: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Build the per-race spec dicts ``track_once`` consumes.

    Parallel lists are optional; missing fields default sensibly:
      - ``nk_race_id`` defaults to ``race_id`` itself (tests don't care;
        production must supply the real netkeiba-format id via ``nk_race_ids``).
      - ``post_time_jst`` defaults to None (adaptive cadence treats as unknown).
      - ``name`` defaults to "Race N" when a race_no is derivable from the id.
    """
    if nk_race_ids is not None and len(nk_race_ids) != len(race_ids):
        raise ValueError("nk_race_ids must parallel race_ids")
    if post_times_jst is not None and len(post_times_jst) != len(race_ids):
        raise ValueError("post_times_jst must parallel race_ids")
    if race_names is not None and len(race_names) != len(race_ids):
        raise ValueError("race_names must parallel race_ids")

    out: list[dict[str, Any]] = []
    for i, rid in enumerate(race_ids):
        nk = (nk_race_ids[i] if nk_race_ids else None) or rid
        pt = post_times_jst[i] if post_times_jst else None
        race_no = _parse_race_no(rid)
        nm = race_names[i] if race_names else None
        if nm is None:
            nm = f"Race {race_no}" if race_no is not None else rid
        out.append({
            "race_id": rid,
            "nk_race_id": nk,
            "post_time_jst": pt,
            "name": nm,
            "race_no": race_no,
        })
    return out


def _parse_race_no(rid: str) -> int | None:
    """Best-effort race number from any id form. 'jra-20260620-09-11' -> 11."""
    parts = rid.split("-")
    try:
        return int(parts[-1])
    except (ValueError, IndexError):
        return None


def _race_snapshot(
    spec: dict[str, Any],
    recs: list[dict[str, Any]],
    open_state: dict[tuple[str, int], float],
    edges: dict[Any, Any],
    captured: datetime,
    banked: int,
) -> dict[str, Any]:
    """Build one race entry for the D1 snapshot (display shape, disposable)."""
    race_id = spec["race_id"]
    runners = []
    for r in recs:
        uma = r["horse_number"]
        win = r.get("win_odds")
        flag = edges.get(uma)
        runners.append({
            "umaban": uma,
            "win_odds": win,
            "win_open": open_state.get((race_id, uma)),
            "place_low": r.get("place_odds_low"),
            "place_high": r.get("place_odds_high"),
            "edge_label": flag.label if flag else None,
            "drift_dir": flag.direction if flag else None,
            "drift_z": round(flag.z, 1) if flag else None,
        })
    return {
        "race_no": spec.get("race_no"),
        "race_id": race_id,
        "name": spec.get("name") or f"Race {spec.get('race_no') or '?'}",
        "post_time_jst": spec.get("post_time_jst"),
        "status": "open" if runners else "waiting",
        "result": None,
        "capture": {
            "last_update": captured.isoformat(),
            "snapshots_banked_this_cycle": banked,
            "pools": ["win_place"],
        },
        "runners": runners,
    }


def _empty_race_snapshot(
    spec: dict[str, Any], captured: datetime, *, reason: str
) -> dict[str, Any]:
    """A race entry for a failed fetch -- preserves shape so the dashboard still
    renders, with a status marker."""
    return {
        "race_no": spec.get("race_no"),
        "race_id": spec["race_id"],
        "name": spec.get("name") or f"Race {spec.get('race_no') or '?'}",
        "post_time_jst": spec.get("post_time_jst"),
        "status": "waiting",
        "result": None,
        "capture": {
            "last_update": captured.isoformat(),
            "snapshots_banked_this_cycle": 0,
            "pools": [],
            "reason": reason,
        },
        "runners": [],
    }


def _project_track_snapshot(
    race_specs: list[dict[str, Any]], races_out: list[dict[str, Any]]
) -> dict[str, Any]:
    """Whole-card D1 document. Mirrors ``run_dashboard_feed``'s shape so the
    existing splash/live dashboard and ``publish_d1.push_to_d1`` consume it
    unchanged. Display-only -- the lake is the record."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "meta": {
            "stage": "track",
            "status": "live",
            "source": "netkeiba-live",
            "message": (
                "Live win/place odds. \u25bc=firming vs field (money in), "
                "\u25b2=draining vs field. Residual move vs this race's own pool "
                "compression -- filters pool-fill noise. Watch only, not a bet signal."
            ),
            "published_at": now_iso,
        },
        "races": races_out,
    }


def _push_track_to_d1_best_effort(
    snapshot: dict[str, Any], *, push_d1: bool, push_fn: Any, key: str
) -> dict[str, Any]:
    """Best-effort D1 push for one track cycle. Same pattern as
    :func:`_push_to_d1_best_effort` (post) and
    :func:`_push_calibration_to_d1_best_effort` (settle): a caller-supplied
    ``push_fn`` bypasses the CF_* preflight (tests own the fake pusher);
    otherwise the preflight gates the real ``publish_d1.push_to_d1``. Never
    raises over the lake writes that already landed."""
    if not push_d1:
        return {"status": "disabled"}
    if push_fn is None:
        missing = _missing_cf_creds()
        if missing:
            return {
                "status": "skipped",
                "reason": f"missing CF_* env vars: {missing}",
                "hint": "source CF_* creds; lake curves already banked.",
            }
        fn = _load_push_to_d1()
    else:
        fn = push_fn
    try:
        response = fn(snapshot, key=key)
        meta = ((response.get("result") or {}).get("meta") or {}) if isinstance(response, dict) else {}
        ok = bool(meta.get("changes", 0))
        return {
            "status": "ok" if ok else "pushed",
            "key": key,
            "response": response,
        }
    except Exception as exc:  # noqa: BLE001 -- D1 is disposable; never re-raise over the lake write
        return {
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "hint": "lake curves already banked; re-run push manually if needed.",
        }


def _preflight_creds_or_warn(*, push_fn: Any = None) -> str | None:
    """Loud startup warning if CF_* are missing. Does NOT refuse to start --
    the loop still banks curves to the lake; push is skipped per cycle with
    a reason. Returns the warning string (or None when all creds present).

    A caller-supplied ``push_fn`` bypasses the preflight entirely (tests own
    their fake pusher) -- mirrors :func:`_push_to_d1_best_effort`'s bypass.
    """
    if push_fn is not None:
        return None
    missing = _missing_cf_creds()
    if not missing:
        return None
    msg = (
        f"WARNING: CF_* env vars missing ({missing}); D1 push will be skipped. "
        "Source CF_* creds in the shell before race day. Curve capture still runs."
    )
    print(msg, file=sys.stderr)
    return msg


def _inhibit_sleep_or_warn() -> tuple[Any, str | None]:
    """Spawn ``caffeinate -dis`` to prevent display/idle/system sleep.

    Returns ``(proc_or_None, warning_or_None)``. ``caffeinate -dis`` is the
    polite macOS way to hold the host awake (d=display, i=idle, s=system on
    AC). Per CLAUDE.md ``caffeinate -i`` does NOT prevent lid-close sleep --
    the user must ALSO disable lid Sleep in System Settings > Battery; this
    function only handles the caffeinate half. If spawn fails it warns loudly
    and continues -- we cannot reliably verify sleep state from userspace, and
    refusing would sacrifice the curve to a false negative.
    """
    import subprocess
    try:
        proc = subprocess.Popen(
            ["caffeinate", "-dis"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return proc, None
    except (OSError, FileNotFoundError) as exc:
        warning = (
            f"WARNING: could not spawn caffeinate ({exc!r}); the Mac may sleep "
            "and the live curve will be lost. Disable lid-close sleep manually "
            "in System Settings > Battery (June 14 curves lost to this)."
        )
        print(warning, file=sys.stderr)
        return None, warning


def _sleep_between_cycles(
    race_specs: list[dict[str, Any]],
    sleep_fn: Any,
    *,
    poll_seconds: int,
    tighten_poll_seconds: int,
    tighten_within_minutes: float,
) -> None:
    """Adaptive cadence: tighten toward post time, never faster than the
    source updates (the dedupe handles unchanged payloads gracefully)."""
    wait = poll_seconds
    nearest = _minutes_to_nearest_post(race_specs)
    if nearest is not None and nearest <= tighten_within_minutes:
        wait = tighten_poll_seconds
    if sleep_fn is None:
        time.sleep(wait)
    else:
        sleep_fn(wait)


def _minutes_to_nearest_post(race_specs: list[dict[str, Any]]) -> float | None:
    """Nearest future ``post_time_jst`` across the card, in minutes from now,
    or None if no spec has a parseable post time. ``post_time_jst`` is "HH:MM"
    in JST; this computes the delta from the current UTC instant."""
    now_jst = datetime.now(_JST)
    candidates: list[float] = []
    for spec in race_specs:
        pt = spec.get("post_time_jst")
        if not pt or ":" not in pt:
            continue
        try:
            hh, mm = pt.split(":", 1)
            post_jst = datetime(
                now_jst.year, now_jst.month, now_jst.day,
                int(hh), int(mm), tzinfo=_JST,
            )
        except (ValueError, TypeError):
            continue
        delta = (post_jst - now_jst).total_seconds() / 60.0
        if delta >= 0:
            candidates.append(delta)
    if not candidates:
        return None
    return min(candidates)


# --- Stage 4: results (Mac) --------------------------------------------------


def settle(
    lake: Any,
    race_ids: list[str],
    *,
    role_file: Path | None = None,
    push_d1: bool = True,
    push_fn: Any = None,
    market_prob_by_key: dict[tuple[str, int], float] | None = None,
) -> dict[str, Any]:
    """Settle at official final payouts and score the card. Mac-only.

    Three steps, wired in order:

      1. **Curve log** (reused): settle the frozen ``curve_log`` rows for these
         races in place via :func:`curve_log.settle_curve_records`. The market
         curve and our card settle in one stage so both artifacts are current.
      2. **Card** (new sibling): :func:`settle_card.settle_card` writes
         ``model_card_settled`` -- the immutable ``model_card`` joined to
         official results + a hypothetical 1-unit win settlement on the model's
         top pick per ``(race_id, card_version)``. ``model_card`` itself stays
         byte-identical (runtime-checked in ``settle_card``).
      3. **Calibration report**: :func:`calibration.calibration_report` over the
         settled rows, sliced by ``posted_before_market``. Clean cards are the
         headline; contaminated cards are reported separately, never blended
         (ADR-0003 D3). Optional ``market_prob_by_key`` lets the report compare
         ``model_p`` to the de-vigged market as the bar (Model 0).

    Returns a summary dict. The full :class:`CalibrationReport` is attached as
    ``report``; a compact scalar view is at the top level for log readability.

    Optionally projects the report to D1 under key ``model_card_calibration``
    using the same best-effort, lake-first, CF_*-preflight pattern as
    :func:`post` -- never raise over the lake writes that already landed.
    """
    _require_role(("mac-dev",), "settle", role_file)

    curve_summary = _settle_curve_log_for_races(lake, race_ids)
    settled_rows = settle_card(lake, race_ids)
    report = calibration_report(
        settled_rows, market_prob_by_key=market_prob_by_key
    )

    summary = {
        "races": len(race_ids),
        "curve_log_settled": curve_summary,
        "model_card_settled_rows": len(settled_rows),
        "clean": _slice_summary(report.clean),
        "contaminated": _slice_summary(report.contaminated),
        "report": report,
    }

    if push_d1:
        summary["d1"] = _push_calibration_to_d1_best_effort(
            report, settled_rows, push_fn=push_fn
        )
    return summary


def _settle_curve_log_for_races(lake: Any, race_ids: list[str]) -> dict[str, Any]:
    """Settle the frozen curve_log rows for these races in place.

    Reuses :func:`curve_log.settle_curve_records` -- the same logic
    ``tools/jravan/settle_curve_log.py --settle`` runs. Idempotent. Returns a
    small summary; ``model_card_settled`` is written next, separately, so the
    two tables stay independent.
    """
    from keibamon_core.ingestion.curve_log import (
        read_curve_log, settle_curve_records, upsert_curve_log,
    )
    from keibamon_core.weekend.settle_card import _read_results

    if not race_ids:
        return {"settled_rows": 0, "races_with_results": 0}

    rid_set = set(race_ids)
    frozen = [
        r for r in read_curve_log(lake)
        if r.get("race_id") in rid_set
    ]
    if not frozen:
        return {"settled_rows": 0, "races_with_results": 0}

    results = _read_results(lake, rid_set)
    if not results:
        return {"settled_rows": 0, "races_with_results": 0, "frozen_rows": len(frozen)}

    settled = settle_curve_records(frozen, results)
    upsert_curve_log(lake, settled)
    done = sum(1 for r in settled if r.get("settled"))
    return {
        "settled_rows": done,
        "frozen_rows": len(frozen),
        "races_with_results": len({k[0] for k in results.keys()}),
    }


def _slice_summary(s: Any) -> dict[str, Any] | None:
    """Compact scalar view of one CalibrationReport slice for log readability.

    None when the slice is empty (e.g. no contaminated cards this weekend).
    """
    if s is None:
        return None
    return {
        "posted_before_market": s.posted_before_market,
        "n_runners": s.n_runners,
        "n_races": s.n_races,
        "races_with_winner": s.probability.races,
        "model_log_loss": s.probability.model_log_loss,
        "model_brier": s.probability.model_brier,
        "market_log_loss": s.probability.market_log_loss,
        "market_brier": s.probability.market_brier,
        "log_loss_delta_vs_market": s.probability.model_log_loss_delta_vs_market,
        "top_pick_roi": s.top_pick_roi.roi,
        "top_pick_n": s.top_pick_roi.n,
        "top_pick_thin": s.top_pick_roi.thin,
        "top_pick_beats_takeout": s.top_pick_roi.beats_takeout,
        "bins_thin_count": sum(1 for b in s.bins if b.thin and b.n > 0),
        "bins_populated_count": sum(1 for b in s.bins if b.n > 0),
    }


def _push_calibration_to_d1_best_effort(
    report: Any, settled_rows: list[dict[str, Any]], *, push_fn: Any
) -> dict[str, Any]:
    """Project the calibration report to D1 (key ``model_card_calibration``).

    Same pattern as :func:`post`'s D1 push: best-effort, lake-first. A caller-
    supplied ``push_fn`` bypasses the CF_* preflight (tests own the fake
    pusher). Production resolves to :func:`tools.jravan.publish_d1.push_to_d1`.
    Never raises over the lake writes that already landed.
    """
    snapshot = _project_calibration_snapshot(report, settled_rows)

    if push_fn is None:
        missing = _missing_cf_creds()
        if missing:
            return {
                "status": "skipped",
                "reason": f"missing CF_* env vars: {missing}",
                "hint": "source CF_* creds before re-running; settle is already durable.",
            }
        fn = _load_push_to_d1()
    else:
        fn = push_fn

    try:
        response = fn(snapshot, key="model_card_calibration")
        meta = ((response.get("result") or {}).get("meta") or {}) if isinstance(response, dict) else {}
        ok = bool(meta.get("changes", 0))
        return {
            "status": "ok" if ok else "pushed",
            "key": "model_card_calibration",
            "response": response,
        }
    except Exception as exc:  # noqa: BLE001 -- D1 is disposable; never re-raise over the lake write
        return {
            "status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
            "hint": "settle already landed; re-run push manually if needed.",
        }


def _project_calibration_snapshot(
    report: Any, settled_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    """Derived, disposable D1 projection of the calibration report.

    The lake (``model_card_settled`` + ``curve_log``) is the record; this is
    display only. Carries the headline (clean) slice + contaminated, never
    blended, plus thin-bin flags so the dashboard can't flatter a sparse bucket.
    """
    return {
        "meta": {
            "stage": "settle",
            "published_at": _utc_now_iso_helper(),
            "settled_rows": len(settled_rows),
        },
        "headline": _slice_summary(report.clean),
        "contaminated": _slice_summary(report.contaminated),
    }
