"""Custom LangChain agent middleware for the chat harness.

Houses `CurrentDatetimeMiddleware`, which injects a single, day-granular
`<current_datetime>` anchor at model-call time so the agent can resolve
relative dates without persisting (and accumulating) a per-turn system
message — see the class docstring for the cache_control rationale.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelCallResult,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import SystemMessage

from .ctx import current_timezone


def _current_datetime_message(tz_name: str) -> SystemMessage:
    """Build the day-granular `<current_datetime>` anchor.

    Day granularity is deliberate: the agent resolves relative DATES
    ("明天", "next Friday") which need the date + weekday, not the minute.
    A minute-granular anchor would change every call and — because LiteLLM
    hoists every system message ahead of the conversation — bust the whole
    conversation prompt cache on every turn. At day granularity the block
    changes at most once per day, so the cached prefix stays stable within
    a day. Invalid tz falls back to UTC.
    """
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz, tz_name = ZoneInfo("UTC"), "UTC"
    today = datetime.now(tz)
    return SystemMessage(
        content=(
            "<current_datetime>\n"
            f"{today.strftime('%Y-%m-%d')} {today.strftime('%A')} ({tz_name})\n"
            "Authoritative current date. Resolve relative dates (tomorrow, "
            "明天, next Friday) against THIS.\n"
            "</current_datetime>"
        ),
    )


def _inject_datetime(messages: list[Any], tz_name: str) -> list[Any]:
    """Return `messages` with one `<current_datetime>` anchor prepended.

    Empty `tz_name` → returns the original list unchanged (same object, so
    callers can skip the request override). The anchor goes at the FRONT,
    never last: it hoists into Anthropic's top-level `system` array via
    LiteLLM, and the `index:-1` cache breakpoint must stay on the final
    user turn, not on this anchor.
    """
    if not tz_name:
        return messages
    return [_current_datetime_message(tz_name), *messages]


class CurrentDatetimeMiddleware(AgentMiddleware):
    """Inject one day-granular `<current_datetime>` anchor per model call.

    Transient — never written to the checkpoint. This replaces the old
    per-turn SystemMessage that was persisted into thread state: those
    accumulated one block per turn and, combined with LiteLLM's
    `cache_control_injection_points` marking every system message,
    overflowed Anthropic's max of 4 cache_control blocks — the card-chat
    "A maximum of 4 blocks with cache_control may be provided. Found 5."
    400. Injecting at call time keeps the system-message count bounded and
    the conversation prefix cache-stable.

    Reads the IANA timezone from the per-run `current_timezone` ContextVar
    (set by the chat route from the request). Empty (batch agents that
    never set it) → no-op.
    """

    def _with_datetime(self, request: ModelRequest) -> ModelRequest:
        messages = _inject_datetime(request.messages, current_timezone.get())
        if messages is request.messages:
            return request
        return request.override(messages=messages)

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        return handler(self._with_datetime(request))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        return await handler(self._with_datetime(request))
