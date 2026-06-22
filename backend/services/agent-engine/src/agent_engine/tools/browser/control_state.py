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


_READ_ONLY_ACTIONS = frozenset(
    {
        "snapshot",
        "get_text",
        "console",
        "request_takeover",
    }
)


class BrowserControlDenied(Exception):
    """Raised when AI attempts a mutation while user is driving."""


def assert_browser_action_allowed(
    mode: BrowserControlMode,
    action: str,
) -> None:
    if action in _READ_ONLY_ACTIONS:
        return
    if mode == BrowserControlMode.AI:
        return
    raise BrowserControlDenied(
        f"action {action!r} blocked: user is driving — "
        f"wait for them to release control before continuing.",
    )


# ── destructive-action gate (P0-3) ──
#
# AI holding control + clicking "Pay" / "Place Order" / "Confirm Transfer"
# goes through the same click_ref path as clicking a plain link — zero
# gating on *what* the action does. This catches the high-signal cases
# where the action is plausibly irreversible (payment / money movement /
# deletion / order submission) and forces a takeover so a human confirms.
#
# Design notes:
#   * Conservative on purpose — a false positive only costs one UX hop
#     (the user takes over, sees it's harmless, sends a message to hand
#     control back to the AI; takeover is fully reversible). A false
#     NEGATIVE lets the agent silently spend money / delete data, so we
#     bias toward over-triggering on strong words only, not weak ones
#     ("send" alone is too noisy — "send money" / "send payment" aren't).
#   * Substring match on the element's accessible name (lowercased). No
#     regex / NLP / semantic model — keep it a flat keyword set so the
#     behavior is auditable and predictable. This is a safety backstop
#     behind the prompt's voluntary `request_takeover`, not a classifier.
#   * Always takeover even if the user enabled bypass-permissions: these
#     actions are irreversible, so human-in-the-loop is the whole point.
_DESTRUCTIVE_LABEL_KEYWORDS = frozenset(
    {
        # English — payment / purchase / money movement
        "pay",
        "buy",
        "order",
        "place order",
        "checkout",
        "purchase",
        "subscribe",
        "confirm",
        "submit payment",
        "transfer",
        "send money",
        "send payment",
        # English — destructive
        "delete",
        "remove",
        # 中文 — 付款 / 购买 / 转账 / 订阅 / 删除
        "付款",
        "支付",
        "下单",
        "确认支付",
        "立即购买",
        "订阅",
        "转账",
        "提交订单",
        "删除",
    }
)


def is_destructive_label(name: str) -> bool:
    """True if an element's accessible name reads like an irreversible /
    payment-class action (case-insensitive substring match)."""
    lowered = name.casefold()
    return any(kw in lowered for kw in _DESTRUCTIVE_LABEL_KEYWORDS)


def normalize_mode(value: str | BrowserControlMode) -> BrowserControlMode:
    if isinstance(value, BrowserControlMode):
        return value
    try:
        return BrowserControlMode(value)
    except ValueError as e:
        raise ValueError(f"unknown control mode: {value!r}") from e


BrowserControlModeStr = Literal["ai", "user"]
