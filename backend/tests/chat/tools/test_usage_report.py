from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from agent_engine.harness.ctx import current_run_jwt
from agent_engine.tools import http_client, usage_report

pytestmark = pytest.mark.asyncio


async def _drain() -> None:
    if usage_report._pending:
        await asyncio.gather(*list(usage_report._pending))


async def test_reports_with_explicit_run_jwt(monkeypatch):
    mock = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(http_client, "post_with_jwt", mock)
    usage_report.report_compute_usage(
        provider="daytona", duration_seconds=12.0, source="daytona:dream", run_jwt="jwt-x"
    )
    await _drain()
    mock.assert_awaited_once()
    args, kwargs = mock.await_args
    assert args[0] == "/api/agent/usage/record"
    assert kwargs["jwt"] == "jwt-x"
    assert args[1]["provider"] == "daytona"
    assert args[1]["durationSeconds"] == 12.0


async def test_falls_back_to_context_jwt(monkeypatch):
    mock = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(http_client, "post_with_jwt", mock)
    token = current_run_jwt.set("ctx-jwt")
    try:
        usage_report.report_compute_usage(
            provider="browserbase", duration_seconds=3.0, source="browser:open"
        )
        await _drain()
    finally:
        current_run_jwt.reset(token)
    mock.assert_awaited_once()
    _, kwargs = mock.await_args
    assert kwargs["jwt"] == "ctx-jwt"


async def test_noop_without_any_jwt(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr(http_client, "post_with_jwt", mock)
    token = current_run_jwt.set("")
    try:
        usage_report.report_compute_usage(provider="daytona", duration_seconds=5.0, source="x")
        await _drain()
    finally:
        current_run_jwt.reset(token)
    mock.assert_not_awaited()


async def test_noop_on_zero_duration(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr(http_client, "post_with_jwt", mock)
    usage_report.report_compute_usage(
        provider="daytona", duration_seconds=0, source="x", run_jwt="jwt-x"
    )
    await _drain()
    mock.assert_not_awaited()
