"""P2: provisioning circuit breaker.

When Daytona is down, the breaker stops every turn from burning its full
provision-timeout budget: after N consecutive failures it OPENS and
fast-fails for a cooldown, then goes HALF-OPEN to probe recovery. These
tests pin that state machine and its metrics surface.
"""

from __future__ import annotations

import time

import pytest

from pinai_agents.chat.tools.code_mode import sandbox


@pytest.fixture(autouse=True)
def _reset_breaker():
    sandbox._breaker_failures = 0
    sandbox._breaker_opened_at = None
    yield
    sandbox._breaker_failures = 0
    sandbox._breaker_opened_at = None


def test_closed_initially_does_not_fast_fail() -> None:
    sandbox._breaker_fast_fail_if_open()  # no raise


def test_below_threshold_stays_closed() -> None:
    for _ in range(sandbox._BREAKER_FAIL_THRESHOLD - 1):
        sandbox._breaker_record_failure()
    sandbox._breaker_fast_fail_if_open()  # still closed


def test_opens_after_threshold_and_fast_fails() -> None:
    for _ in range(sandbox._BREAKER_FAIL_THRESHOLD):
        sandbox._breaker_record_failure()
    with pytest.raises(sandbox.SandboxProvisionError, match="circuit open"):
        sandbox._breaker_fast_fail_if_open()


def test_success_closes_breaker() -> None:
    for _ in range(sandbox._BREAKER_FAIL_THRESHOLD):
        sandbox._breaker_record_failure()
    sandbox._breaker_record_success()
    sandbox._breaker_fast_fail_if_open()  # closed again — no raise
    assert sandbox._breaker_failures == 0


def test_half_open_after_cooldown_allows_probe() -> None:
    for _ in range(sandbox._BREAKER_FAIL_THRESHOLD):
        sandbox._breaker_record_failure()
    # Backdate the open timestamp past the cooldown → HALF-OPEN: the next
    # probe is allowed through (no raise) so recovery can be detected.
    sandbox._breaker_opened_at = time.monotonic() - sandbox._BREAKER_COOLDOWN_SEC - 1
    sandbox._breaker_fast_fail_if_open()


def test_half_open_probe_failure_restarts_cooldown() -> None:
    for _ in range(sandbox._BREAKER_FAIL_THRESHOLD):
        sandbox._breaker_record_failure()
    sandbox._breaker_opened_at = time.monotonic() - sandbox._BREAKER_COOLDOWN_SEC - 1
    sandbox._breaker_record_failure()  # probe failed → re-open with fresh cooldown
    with pytest.raises(sandbox.SandboxProvisionError, match="circuit open"):
        sandbox._breaker_fast_fail_if_open()


def test_metrics_snapshot_reports_breaker() -> None:
    for _ in range(sandbox._BREAKER_FAIL_THRESHOLD):
        sandbox._breaker_record_failure()
    snap = sandbox.metrics_snapshot()
    assert snap["breaker_open"] == 1
    assert snap["breaker_failures"] == sandbox._BREAKER_FAIL_THRESHOLD
