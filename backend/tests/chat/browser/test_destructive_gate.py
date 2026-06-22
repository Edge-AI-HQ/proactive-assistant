"""P0-3 destructive-action gate — pure-logic + click_ref control-flow tests.

The gate (BrowserManager.click_ref) refuses to click an element whose
accessible name reads like an irreversible / payment-class action while the
AI is driving, and instead hands control to the user (reusing the takeover
path). We stub the Playwright locator + the manager's collaborators so we
never stand up a real Browserbase session.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

from agent_engine.tools.browser.control_state import (
    BrowserControlMode,
    is_destructive_label,
)
from agent_engine.tools.browser.manager import (
    BrowserManager,
    _accessible_name_from_snapshot,
)

# ── pure helpers ──


def test_is_destructive_label_english():
    for name in ("Pay $99", "Place Order", "Confirm Transfer", "Delete account", "Buy now"):
        assert is_destructive_label(name), name


def test_is_destructive_label_chinese():
    for name in ("确认支付", "立即购买", "提交订单", "转账", "删除"):
        assert is_destructive_label(name), name


def test_is_destructive_label_benign():
    for name in ("Next", "Open article", "Back", "Read more", "搜索", "下一步"):
        assert not is_destructive_label(name), name


def test_is_destructive_label_case_insensitive():
    assert is_destructive_label("PAY NOW")
    assert is_destructive_label("CHECKOUT")


def test_accessible_name_from_snapshot_plain():
    assert _accessible_name_from_snapshot('- button "Pay $99" [ref=e1]') == "Pay $99"


def test_accessible_name_from_snapshot_aria_label_only():
    # icon button: name comes from aria-label, inner_text would be empty
    snap = '- button "确认支付" [ref=e2]:\n  - img [ref=e3]'
    assert _accessible_name_from_snapshot(snap) == "确认支付"


def test_accessible_name_from_snapshot_no_name():
    assert _accessible_name_from_snapshot("- img [ref=e9]") == ""


# ── click_ref gate ──


def _manager_with_session(
    monkeypatch,
    mode: BrowserControlMode,
) -> tuple[BrowserManager, SimpleNamespace]:
    """Wire a manager whose _gate returns an internal at `mode`, with a
    stubbed locator we can assert .click() against. Collaborators are
    monkeypatched (matching test_manager_control.py's style)."""
    mgr = BrowserManager()
    locator = SimpleNamespace(
        aria_snapshot=AsyncMock(),
        click=AsyncMock(),
    )
    internal = SimpleNamespace(
        session=SimpleNamespace(control_mode=mode),
        page=SimpleNamespace(locator=lambda _sel: locator),
    )
    monkeypatch.setattr(mgr, "_gate", AsyncMock(return_value=internal))
    monkeypatch.setattr(mgr, "set_control_mode", AsyncMock())
    monkeypatch.setattr(
        mgr,
        "_post_action_snapshot",
        AsyncMock(return_value={"ok": True, "action": "click", "tree": "<snap>"}),
    )
    return mgr, locator


async def test_destructive_click_forces_takeover_no_click(monkeypatch):
    mgr, locator = _manager_with_session(monkeypatch, BrowserControlMode.AI)
    locator.aria_snapshot.return_value = '- button "Pay $99" [ref=e1]'

    result = await mgr.click_ref("sk-1", "e1")

    assert result["requiresTakeover"] is True
    assert result["controlMode"] == BrowserControlMode.USER.value
    assert result["label"] == "Pay $99"
    locator.click.assert_not_awaited()
    mgr.set_control_mode.assert_awaited_once()
    args, kwargs = mgr.set_control_mode.await_args
    assert args[0] == "sk-1"
    assert args[1] is BrowserControlMode.USER
    assert kwargs["reason"]  # non-empty human-facing reason


async def test_destructive_click_chinese_icon_button(monkeypatch):
    mgr, locator = _manager_with_session(monkeypatch, BrowserControlMode.AI)
    locator.aria_snapshot.return_value = '- button "确认支付" [ref=e2]:\n  - img [ref=e3]'

    result = await mgr.click_ref("sk-1", "e2")

    assert result["requiresTakeover"] is True
    assert result["label"] == "确认支付"
    locator.click.assert_not_awaited()


async def test_benign_click_proceeds_normally(monkeypatch):
    mgr, locator = _manager_with_session(monkeypatch, BrowserControlMode.AI)
    locator.aria_snapshot.return_value = '- link "Open article" [ref=e4]'

    result = await mgr.click_ref("sk-1", "e4")

    assert result == {"ok": True, "action": "click", "tree": "<snap>"}
    locator.click.assert_awaited_once()
    mgr.set_control_mode.assert_not_awaited()


async def test_benign_click_unnamed_element_proceeds(monkeypatch):
    mgr, locator = _manager_with_session(monkeypatch, BrowserControlMode.AI)
    locator.aria_snapshot.return_value = "- img [ref=e9]"

    result = await mgr.click_ref("sk-1", "e9")

    assert result["ok"] is True
    locator.click.assert_awaited_once()
