"""Loud capture alerting — the ADR-0004 "silent scrape outage" mitigation.

ADR-0004 makes scrape-failure monitoring mandatory: post-cutover the netkeiba
feed is the only live source, intraday odds curves cannot be backfilled, and a
silent outage is a lost race day. The cutover runbook
(``docs/runbooks/overlap-capture-weekend.md``) lists this as an unchecked
power-off criterion; this module implements it.

Transport: `ntfy.sh <https://ntfy.sh>`_ — a plain HTTPS POST to
``https://ntfy.sh/<topic>`` shows up as a push notification on the phone with
zero account setup. Configure by exporting ``KEIBAMON_NTFY_TOPIC`` (pick a
long, unguessable topic string; it is effectively the password) in the same
sourced profile that holds the ``CF_*`` creds on the Mac. If the env var is
unset, alerts degrade to loud stderr lines — the capture loop never depends on
alerting to run (an alert failure must never cost the curve).

Two failure modes are watched by :class:`CaptureAlerter`, driven by
``weekend.pipeline.track``'s per-cycle counts:

- **Consecutive total-failure cycles** — every race fetch in a cycle failed,
  ``fail_cycles`` times in a row (netkeiba down / format change / network).
- **Staleness** — fetches succeeded at some point, but nothing has succeeded
  for ``stale_after_s`` while cycles keep running (partial wedge).

Both alerts re-fire at most once per ``cooldown_s`` while the condition
persists, and a one-shot recovery notice is sent when capture comes back.
"""
from __future__ import annotations

import os
import sys
import time as _time
import urllib.request
from typing import Any, Callable

NTFY_TOPIC_ENV = "KEIBAMON_NTFY_TOPIC"
NTFY_BASE = "https://ntfy.sh"


def alert(
    title: str,
    message: str,
    *,
    topic: str | None = None,
    post_fn: Callable[[str, str, str], Any] | None = None,
) -> bool:
    """Push one notification; never raises. Returns True if pushed.

    Falls back to a loud stderr line when ``KEIBAMON_NTFY_TOPIC`` is unset or
    the POST fails — alerting is best-effort by design.
    ``post_fn(url, title, message)`` is the test seam.
    """
    topic = topic or os.environ.get(NTFY_TOPIC_ENV)
    if not topic:
        print(
            f"ALERT (not pushed — {NTFY_TOPIC_ENV} unset): {title}: {message}",
            file=sys.stderr,
        )
        return False
    url = f"{NTFY_BASE}/{topic}"
    try:
        if post_fn is not None:
            post_fn(url, title, message)
        else:  # pragma: no cover - exercised only against the live service
            req = urllib.request.Request(
                url,
                data=message.encode("utf-8"),
                headers={"Title": title, "Priority": "high", "Tags": "rotating_light"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=10)
        print(f"ALERT pushed: {title}: {message}", file=sys.stderr)
        return True
    except Exception as exc:  # noqa: BLE001 - alerting must never kill capture
        print(f"ALERT push failed ({exc!r}): {title}: {message}", file=sys.stderr)
        return False


class CaptureAlerter:
    """Consecutive-failure + staleness watchdog for the race-day capture loop.

    Feed it one :meth:`record_cycle` call per track cycle with the number of
    races whose fetch/parse succeeded (``ok``) and failed (``failed``).
    Stateless callers stay simple: all thresholds, cooldowns, and the
    recovered-notice logic live here. ``alert_fn`` / ``now_fn`` are test seams
    (``now_fn`` defaults to ``time.monotonic``).
    """

    def __init__(
        self,
        *,
        fail_cycles: int = 3,
        stale_after_s: float = 900.0,
        cooldown_s: float = 900.0,
        alert_fn: Callable[[str, str], Any] = alert,
        now_fn: Callable[[], float] = _time.monotonic,
    ) -> None:
        self.fail_cycles = fail_cycles
        self.stale_after_s = stale_after_s
        self.cooldown_s = cooldown_s
        self._alert = alert_fn
        self._now = now_fn
        self._consecutive_failed = 0
        self._last_ok_at: float | None = None
        self._last_alert_at: dict[str, float] = {}
        self._alerting = False  # any condition currently active?

    def record_cycle(self, *, ok: int, failed: int) -> list[str]:
        """Record one cycle's outcome; returns the alert kinds fired now."""
        now = self._now()
        fired: list[str] = []

        if ok > 0:
            self._last_ok_at = now
            self._consecutive_failed = 0
            if self._alerting:
                self._alerting = False
                self._last_alert_at.clear()
                self._alert(
                    "keibamon capture recovered",
                    f"fetches succeeding again ({ok} ok this cycle)",
                )
                fired.append("recovered")
            return fired

        if failed > 0:
            self._consecutive_failed += 1

        if self._consecutive_failed >= self.fail_cycles and self._cooldown_ok(
            "failing", now
        ):
            self._alerting = True
            self._last_alert_at["failing"] = now
            self._alert(
                "keibamon capture FAILING",
                f"{self._consecutive_failed} consecutive cycles with every race "
                f"fetch failing — check netkeiba/network NOW; the odds curve "
                f"cannot be backfilled",
            )
            fired.append("failing")

        if (
            self._last_ok_at is not None
            and now - self._last_ok_at > self.stale_after_s
            and self._cooldown_ok("stale", now)
        ):
            self._alerting = True
            self._last_alert_at["stale"] = now
            minutes = int((now - self._last_ok_at) // 60)
            self._alert(
                "keibamon capture STALE",
                f"no successful odds fetch for ~{minutes} min while the loop is "
                f"still running — capture is wedged",
            )
            fired.append("stale")

        return fired

    def _cooldown_ok(self, kind: str, now: float) -> bool:
        last = self._last_alert_at.get(kind)
        return last is None or (now - last) >= self.cooldown_s
