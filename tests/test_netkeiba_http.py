"""Tests for the polite-fetch primitives (BUG 3 — pace the orchestrator).

The rate floor is the load-bearing assumption of going scrape-only under
ADR-0004: a rate-limit ban on the only feed would silently lose race days.
These tests pin the floor's behavior so a future refactor can't quietly
remove the gap.

The floor is module-global (process-wide last-fetch timestamp), so each test
resets it via :func:`reset_rate_floor_for_tests` to start from a clean state.
"""
from __future__ import annotations

import time

import pytest

from keibamon_core.adapters import netkeiba_http


@pytest.fixture(autouse=True)
def _reset_floor() -> None:
    """Each test starts with the floor unstamped (no previous fetch)."""
    netkeiba_http.reset_rate_floor_for_tests()


# --- _pace_to_rate_floor (BUG 3) ---------------------------------------------


def test_pace_floor_sleeps_when_called_twice_within_the_gap() -> None:
    """Two consecutive pace calls inside MIN_FETCH_INTERVAL_SECONDS sleep for
    the remainder. The orchestrator relies on this to keep every fetch polite
    without knowing about the floor itself."""
    netkeiba_http._pace_to_rate_floor()  # stamps the floor
    t0 = time.monotonic()
    netkeiba_http._pace_to_rate_floor()  # must sleep ~MIN_FETCH_INTERVAL_SECONDS
    elapsed = time.monotonic() - t0
    # Allow a small scheduler slack margin below the floor; never below.
    assert elapsed >= netkeiba_http.MIN_FETCH_INTERVAL_SECONDS - 0.05, (
        f"expected >= {netkeiba_http.MIN_FETCH_INTERVAL_SECONDS}s, got {elapsed:.3f}s"
    )


def test_pace_floor_no_sleep_on_first_call() -> None:
    """The first call after a reset just stamps the floor and returns. A
    positive sleep on the first call would slow test startup for nothing."""
    t0 = time.monotonic()
    netkeiba_http._pace_to_rate_floor()
    elapsed = time.monotonic() - t0
    assert elapsed < 0.05, f"first call should not sleep, took {elapsed:.3f}s"


def test_pace_floor_no_sleep_after_gap_elapsed() -> None:
    """If the caller has already waited past the floor, no sleep. The floor is
    a lower bound, not a fixed cadence."""
    netkeiba_http._pace_to_rate_floor()
    # Simulate a caller that already waited longer than the floor.
    # Patch the last-fetch timestamp backwards so the next call sees a stale
    # floor.
    netkeiba_http._LAST_FETCH_MONOTONIC = (
        time.monotonic() - netkeiba_http.MIN_FETCH_INTERVAL_SECONDS - 1.0
    )
    t0 = time.monotonic()
    netkeiba_http._pace_to_rate_floor()
    elapsed = time.monotonic() - t0
    assert elapsed < 0.05, (
        f"no sleep expected when floor already elapsed, took {elapsed:.3f}s"
    )


def test_pace_floor_is_process_wide_across_callers() -> None:
    """The floor is a module-global: discovery's GET counts against the next
    adapter fetch. This is the 'discovery counts against the floor' contract
    from the BUG-3 spec -- the orchestrator's two phases share the floor
    because they go through the same module-global timestamp."""
    netkeiba_http._pace_to_rate_floor()
    # A second caller (simulating a different code path -- discovery vs the
    # adapter) immediately calls again. Same floor, same gap.
    t0 = time.monotonic()
    netkeiba_http._pace_to_rate_floor()
    elapsed = time.monotonic() - t0
    assert elapsed >= netkeiba_http.MIN_FETCH_INTERVAL_SECONDS - 0.05


# --- _charset_from_content_type ----------------------------------------------


def test_charset_from_content_type_extracts_utf8_explicit() -> None:
    """netkeiba's actual wire format (verified 2026-06-19): the Content-Type
    header carries charset=UTF-8 explicitly."""
    assert (
        netkeiba_http._charset_from_content_type("text/html; charset=UTF-8")
        == "utf-8"
    )


def test_charset_from_content_type_lowercased() -> None:
    """Header values can come in any case."""
    assert (
        netkeiba_http._charset_from_content_type("Text/HTML; Charset=euc-jp")
        == "euc-jp"
    )


def test_charset_from_content_type_defaults_to_utf8_when_missing() -> None:
    """A Content-Type without a charset token defaults to UTF-8. netkeiba
    serves UTF-8; this default matches the empirical wire format. The earlier
    project note claiming EUC-JP was wrong (EUC-JP fails to decode the actual
    bytes)."""
    assert netkeiba_http._charset_from_content_type("text/html") == "utf-8"
    assert netkeiba_http._charset_from_content_type("") == "utf-8"
