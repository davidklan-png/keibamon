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

from pathlib import Path
from typing import Any

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

def post(lake: Any, race_ids: list[str], *, predictor: Any, role_file: Path | None = None) -> dict[str, Any]:
    """Freeze our model_card (our odds + gate) pre-market and push to D1. Mac-only.

    STUB: for each race call weekend.model_card.freeze_model_card (append-only,
    soft pre-market gate per ADR-0003 D3), then project the frozen cards into the
    D1 live_snapshot via tools.jravan.publish_d1.push_to_d1 (lake first, D1 after
    -- ADR-0003 D4). Requires CF_* creds preflighted before the push.
    """
    _require_role(("mac-dev",), "post", role_file)
    raise NotImplementedError("post: wire freeze_model_card + push_to_d1 on the Mac.")


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

def settle(lake: Any, race_ids: list[str], *, role_file: Path | None = None) -> dict[str, Any]:
    """Settle at official final payouts and score the weekend. Mac-only.

    STUB: settle curve_log via tools.jravan.settle_curve_log and the hypothetical
    model_card bets via ingestion.settlement.settle_many (official payout table,
    never decision-time odds -- modeling-spine.md step 1). Then join settled
    model_card to results, grouped by posted_before_market, for the calibration
    log. No edge claim; this is the measurement, not a bet.
    """
    _require_role(("mac-dev",), "settle", role_file)
    raise NotImplementedError("settle: wire settle_curve_log + settle_many on the Mac.")
