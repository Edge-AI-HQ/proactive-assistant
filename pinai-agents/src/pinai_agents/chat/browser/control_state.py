"""Browser control mode + AI-action gating.

Two states reach the AI:
  * AI    — agent's tool calls drive the page; user iframe is read-only.
  * USER  — user has taken over (or AI requested takeover); AI mutations
            are blocked, AI reads are still allowed.

Reads (snapshot, get_text, console, request_takeover) stay open in any
mode — situational awareness shouldn't fight the user, and request_takeover
must work from AI side regardless.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal


class BrowserControlMode(StrEnum):
    AI = "ai"
    USER = "user"


_READ_ONLY_ACTIONS = frozenset({
    "snapshot", "get_text", "console", "request_takeover",
})


class BrowserControlDenied(Exception):
    """Raised when AI attempts a mutation while user is driving."""


def assert_browser_action_allowed(
    mode: BrowserControlMode, action: str,
) -> None:
    if action in _READ_ONLY_ACTIONS:
        return
    if mode == BrowserControlMode.AI:
        return
    raise BrowserControlDenied(
        f"action {action!r} blocked: user is driving — "
        f"wait for them to release control before continuing.",
    )


def normalize_mode(value: str | BrowserControlMode) -> BrowserControlMode:
    if isinstance(value, BrowserControlMode):
        return value
    try:
        return BrowserControlMode(value)
    except ValueError as e:
        raise ValueError(f"unknown control mode: {value!r}") from e


BrowserControlModeStr = Literal["ai", "user"]
