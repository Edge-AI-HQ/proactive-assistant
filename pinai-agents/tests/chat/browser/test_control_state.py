"""Browser control mode + transition gate — pure-logic tests."""

from __future__ import annotations

import pytest

from pinai_agents.chat.tools.browser.control_state import (
    BrowserControlDenied,
    BrowserControlMode,
    assert_browser_action_allowed,
    normalize_mode,
)


def test_ai_mode_allows_mutations():
    assert_browser_action_allowed(BrowserControlMode.AI, "click")
    assert_browser_action_allowed(BrowserControlMode.AI, "type")
    assert_browser_action_allowed(BrowserControlMode.AI, "navigate")


def test_user_mode_blocks_mutations():
    for action in ("click", "type", "navigate", "press_key", "scroll"):
        with pytest.raises(BrowserControlDenied):
            assert_browser_action_allowed(BrowserControlMode.USER, action)


def test_read_only_actions_allowed_in_any_mode():
    for mode in BrowserControlMode:
        for action in ("snapshot", "get_text", "console", "request_takeover"):
            assert_browser_action_allowed(mode, action)


def test_normalize_mode_string_to_enum():
    assert normalize_mode("ai") is BrowserControlMode.AI
    assert normalize_mode("user") is BrowserControlMode.USER
    assert normalize_mode(BrowserControlMode.AI) is BrowserControlMode.AI


def test_normalize_mode_rejects_unknown():
    with pytest.raises(ValueError):
        normalize_mode("paused")  # removed mode — now invalid
    with pytest.raises(ValueError):
        normalize_mode("invalid")
