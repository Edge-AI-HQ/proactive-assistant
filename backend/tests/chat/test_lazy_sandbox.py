"""P1: LazyThreadSandbox defers Daytona provisioning to first real tool use.

The prod hang was every turn eagerly provisioning a sandbox before the LLM
ran. These tests pin the fix: constructing the proxy (and reading its id
for tracing) never provisions; the first file/exec tool call provisions
exactly once; and the proxy stays a `SandboxBackendProtocol` so deepagents
keeps the execute tool without the type check triggering provisioning.
"""

from __future__ import annotations

import asyncio

import pytest
from agent_engine.tools.code_mode import lazy_sandbox
from agent_engine.tools.code_mode.lazy_sandbox import LazyThreadSandbox
from deepagents.backends.protocol import SandboxBackendProtocol

pytestmark = pytest.mark.anyio


class _FakeReal:
    """Stand-in for the real DaytonaSandbox the proxy delegates to."""

    async def aexecute(self, command: str, *, timeout: int | None = None) -> str:
        return f"ran:{command}"

    async def als(self, path: str) -> str:
        return f"ls:{path}"


class _FakeRaw:
    id = "sb-real"


def test_is_sandbox_backend_so_execute_tool_is_kept() -> None:
    # supports_execution() does isinstance(SandboxBackendProtocol); the proxy
    # must pass it WITHOUT provisioning, so the execute tool survives.
    proxy = LazyThreadSandbox("main-1", run_jwt="jwt")
    assert isinstance(proxy, SandboxBackendProtocol)


async def test_construction_and_id_do_not_provision(monkeypatch) -> None:
    async def boom(*_a, **_k):
        raise AssertionError("must not provision for construction / id read")

    monkeypatch.setattr(lazy_sandbox, "get_or_create_thread_sandbox", boom)

    proxy = LazyThreadSandbox("main-1", run_jwt="jwt")
    assert proxy.id == "lazy:main-1"  # tracing reads id — still no provision


async def test_first_tool_call_provisions_once_then_reuses(monkeypatch) -> None:
    provisions: list[str] = []

    async def fake_provision(thread_id: str, *, run_jwt: str | None = None):
        provisions.append(thread_id)
        return _FakeReal(), _FakeRaw()

    monkeypatch.setattr(lazy_sandbox, "get_or_create_thread_sandbox", fake_provision)

    proxy = LazyThreadSandbox("main-1", run_jwt="jwt")
    assert provisions == []  # pure conversation so far → nothing provisioned

    assert await proxy.aexecute("echo hi") == "ran:echo hi"
    assert provisions == ["main-1"]  # provisioned on first real tool call
    assert proxy.id == "sb-real"  # id now reflects the real sandbox

    assert await proxy.als("/x") == "ls:/x"
    assert provisions == ["main-1"]  # reused, not re-provisioned


async def test_concurrent_first_calls_coalesce_to_one_provision(monkeypatch) -> None:
    provisions: list[str] = []

    async def slow_provision(thread_id: str, *, run_jwt: str | None = None):
        provisions.append(thread_id)
        await asyncio.sleep(0.05)
        return _FakeReal(), _FakeRaw()

    monkeypatch.setattr(lazy_sandbox, "get_or_create_thread_sandbox", slow_provision)

    proxy = LazyThreadSandbox("main-1", run_jwt="jwt")
    results = await asyncio.gather(*[proxy.aexecute("c") for _ in range(5)])

    assert results == ["ran:c"] * 5
    assert provisions == ["main-1"]  # the lock coalesced 5 first-touches to one
