"""pipeline.py -- the four-stage weekend loop, with hard device guards.

See docs/adr/0003-weekend-pipeline.md. Each stage asserts it is running on the
device the topology assigns it (docs/device-topology.md) BEFORE doing any work,
so a stage can never silently run on the wrong host (e.g. the live curve on the
traveling laptop, or JV-Link on the Mac).

  select  (Mac)          -> stage 1: pick races/runners from the lake.
  post    (Mac)          -> stage 2: freeze model_card + push our odds to D1.
  track   (capture host) -> stage 3: live odds time-series (the only live job).
  settle  (Mac)          -> stage 4: settle at official payouts; score the card.

This module is orchestration only -- it wires existing modules together and
enforces the boundaries. The real work lives in:
  - weekend.model_card.freeze_model_card  (stage 2)
  - ingestion.curve_log                   (stage 3 freeze)
  - tools/jravan realtime + run_dashboard_feed (stage 3 capture)
  - ingestion.settlement / tools.jravan.settle_curve_log (stage 4)
  - tools/jravan/publish_d1.push_to_d1    (D1 projection, all stages)
"""
from __future__ import annotations

import os
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

def select(lake: Any, race_date: str, *, role_file: Path | None = None) -> list[str]:
    """Pick the race_ids on the card we will post for. Mac-only (lake + ML).

    STUB: query marts for the day's races (and any selection filter -- venue,
    grade, our-confidence threshold). Returns canonical race_ids. Offline and
    deterministic; safe to run Thu/Fri ahead of the weekend.
    """
    _require_role(("mac-dev",), "select", role_file)
    raise NotImplementedError("select: implement lake/marts query on the Mac.")


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
        missing = [
            k for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN")
            if not os.environ.get(k)
        ]
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


# --- Stage 3: day-of curve (capture host -- the only live, unrecoverable job) -

def track(race_ids: list[str], *, role_file: Path | None = None) -> None:
    """Capture the live odds time-series, announcement -> post. Capture host only.

    Capture-pc is the host of record (JVRTOpen / 0B30 / 0B41/0B42). The Mac is the
    interim backup ONLY (netkeiba feed) and ONLY while stationary with lid-sleep
    disabled (ADR-0002 blocked; ADR-0003 D5). A missed curve cannot be re-run.

    STUB: delegate to tools/jravan/realtime_jvlink.py (PC) or
    tools/jravan/run_dashboard_feed.py (Mac backup); both land snapshots in the
    lake and push D1. This wrapper exists to enforce the device guard up front.
    """
    _require_role(("capture-pc", "mac-dev"), "track", role_file)
    raise NotImplementedError(
        "track: run realtime_jvlink (PC) or run_dashboard_feed (Mac backup). "
        "If Mac: caffeinate -dis + disable lid sleep first (ADR-0003 D5)."
    )


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
        missing = [
            k for k in ("CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN")
            if not os.environ.get(k)
        ]
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
