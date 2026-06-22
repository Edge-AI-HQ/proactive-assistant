"""BrowserManager.release_to_ai_if_user_driving — control-flow tests.

Covers the three branches (user driving → release; AI already driving →
no-op; no session → no-op) without standing up a real Browserbase session:
the method only reads internal.session.control_mode and delegates the actual
switch to set_control_mode, so we stub both.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from agent_engine.tools.browser.control_state import BrowserControlMode
from agent_engine.tools.browser.manager import BrowserManager


def _internal(mode: BrowserControlMode) -> SimpleNamespace:
    return SimpleNamespace(session=SimpleNamespace(control_mode=mode))


async def test_release_when_user_driving(monkeypatch):
    mgr = BrowserManager()
    monkeypatch.setattr(mgr, "get", AsyncMock(return_value=_internal(BrowserControlMode.USER)))
    set_mode = AsyncMock()
    monkeypatch.setattr(mgr, "set_control_mode", set_mode)

    assert await mgr.release_to_ai_if_user_driving("sk-1") is True
    set_mode.assert_awaited_once_with("sk-1", BrowserControlMode.AI)


async def test_noop_when_ai_already_driving(monkeypatch):
    mgr = BrowserManager()
    monkeypatch.setattr(mgr, "get", AsyncMock(return_value=_internal(BrowserControlMode.AI)))
    set_mode = AsyncMock()
    monkeypatch.setattr(mgr, "set_control_mode", set_mode)

    assert await mgr.release_to_ai_if_user_driving("sk-1") is False
    set_mode.assert_not_awaited()


async def test_noop_when_no_session(monkeypatch):
    mgr = BrowserManager()
    monkeypatch.setattr(mgr, "get", AsyncMock(return_value=None))
    set_mode = AsyncMock()
    monkeypatch.setattr(mgr, "set_control_mode", set_mode)

    assert await mgr.release_to_ai_if_user_driving("sk-1") is False
    set_mode.assert_not_awaited()
