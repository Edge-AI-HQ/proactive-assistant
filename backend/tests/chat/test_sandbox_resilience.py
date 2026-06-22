"""P0 resilience for Daytona provisioning.

The prod hang was: a wedged Daytona sync call (create / refresh / resume)
ran on the default asyncio thread pool with no timeout, blocked forever,
and eventually starved the pool so EVERY sandbox-needing request wedged.

These tests pin the fix: every blocking Daytona call goes through
`_run_blocking`, which (1) runs on a dedicated bounded pool and (2) is
capped by an outer `asyncio.wait_for`, so a stuck call surfaces as
`SandboxProvisionError` within the timeout instead of hanging the turn.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from agent_engine.tools.code_mode import sandbox

pytestmark = pytest.mark.anyio


async def test_run_blocking_returns_value() -> None:
    assert await sandbox._run_blocking(lambda: 42, timeout=1.0, what="t") == 42


async def test_run_blocking_forwards_args() -> None:
    def add(a: int, b: int) -> int:
        return a + b

    assert await sandbox._run_blocking(add, 2, 3, timeout=1.0, what="t") == 5


async def test_run_blocking_times_out_fast_not_hang() -> None:
    # A wedged Daytona call sleeps far past the timeout. _run_blocking must
    # raise within ~timeout, NOT block for the full sleep — that wall-clock
    # ceiling IS the prod-hang fix.
    started = time.monotonic()
    with pytest.raises(sandbox.SandboxProvisionError, match="timed out after"):
        await sandbox._run_blocking(lambda: time.sleep(5), timeout=0.2, what="refresh")
    assert time.monotonic() - started < 2.0


async def test_run_blocking_runs_on_dedicated_pool() -> None:
    # Isolation: provisioning must NOT borrow the default executor (whose
    # exhaustion is what cascaded the outage). It runs on the named pool.
    captured: dict[str, str] = {}

    def grab() -> None:
        captured["thread"] = threading.current_thread().name

    await sandbox._run_blocking(grab, timeout=1.0, what="t")
    assert captured["thread"].startswith("daytona-provision")


async def test_run_blocking_propagates_real_errors() -> None:
    # A genuine SDK error (not a timeout) must surface unchanged so callers
    # can distinguish "Daytona said no" from "Daytona never answered".
    def boom() -> None:
        raise ValueError("daytona said no")

    with pytest.raises(ValueError, match="daytona said no"):
        await sandbox._run_blocking(boom, timeout=1.0, what="t")


async def test_run_blocking_surfaces_shutdown_pool_as_provision_error(monkeypatch) -> None:
    # After lifespan shutdown the executor rejects submits with RuntimeError;
    # _run_blocking must normalize that to SandboxProvisionError so the
    # (DaytonaError, SandboxProvisionError) handlers catch it instead of a
    # bare RuntimeError leaking past them.
    dead = ThreadPoolExecutor(max_workers=1)
    dead.shutdown(wait=True)
    monkeypatch.setattr(sandbox, "_DAYTONA_EXECUTOR", dead)
    with pytest.raises(sandbox.SandboxProvisionError, match="shut down"):
        await sandbox._run_blocking(lambda: 1, timeout=1.0, what="create")


async def test_validate_cached_refresh_timeout_degrades_to_none(monkeypatch) -> None:
    # A wedged state-refresh must DROP the cache entry (return None →
    # recreate downstream), never hang. Simulate a refresh that never
    # returns within the (shrunk) timeout.
    monkeypatch.setattr(sandbox, "_REFRESH_TIMEOUT_SEC", 0.2)
    monkeypatch.setattr(sandbox, "_refresh_state_blocking", lambda _raw: time.sleep(5))

    class FakeRaw:
        id = "sb-x"

    started = time.monotonic()
    result = await sandbox._validate_cached("thread-1", FakeRaw())
    assert result is None
    assert time.monotonic() - started < 2.0
