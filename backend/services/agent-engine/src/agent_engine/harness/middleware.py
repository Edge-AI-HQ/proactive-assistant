"""Custom LangChain agent middleware for the chat harness.

Houses `CurrentDatetimeMiddleware`, which injects a single, day-granular
`<current_datetime>` anchor at model-call time so the agent can resolve
relative dates without persisting (and accumulating) a per-turn system
message — see the class docstring for the cache_control rationale.
"""

from __future__ import annotations

import logging
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

logger = logging.getLogger(__name__)


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


_SCHEDULE_SNAPSHOT_CAP = 8


def render_scheduled_tasks(items: list[dict[str, Any]]) -> str:
    """Bounded one-line-per-task snapshot for the system prompt.

    Prospective memory (design §三): the agent sees what IT has scheduled —
    so it can answer "what do you have planned for me", modify/cancel via the
    scheduled_generator_* tools, and never create duplicates. Bounded like
    the portrait: first N tasks + a count for the rest, one line each."""
    lines: list[str] = []
    for item in items[:_SCHEDULE_SNAPSHOT_CAP]:
        if not isinstance(item, dict):
            continue
        task_id = item.get("id")
        title = item.get("title") or "(untitled)"
        cadence = item.get("scheduleLabel") or " ".join(
            str(part) for part in (item.get("frequency"), item.get("localTime")) if part
        )
        status = item.get("status")
        status_note = f" [{status}]" if status and status != "active" else ""
        next_run = item.get("nextRunAt")
        next_note = f" (next: {next_run})" if next_run else ""
        cadence_note = f" — {cadence}" if cadence else ""
        lines.append(f"- [{task_id}] {title}{cadence_note}{next_note}{status_note}")
    if not lines:
        return ""
    overflow = len(items) - _SCHEDULE_SNAPSHOT_CAP
    if overflow > 0:
        lines.append(f"… and {overflow} more (scheduled_generator_list for all)")
    return (
        "<scheduled_tasks>\n"
        "Your standing scheduled tasks (snapshot at run start; manage them with "
        "the scheduled_generator_* tools — don't create duplicates of these):\n"
        + "\n".join(lines)
        + "\n</scheduled_tasks>"
    )


class ScheduledTasksMiddleware(AgentMiddleware):
    """Inject the agent's own scheduled tasks (prospective memory) at
    model-call time — design §三: the chat agent stays aware of the cron
    jobs it/the user created, so it can reference, modify, and de-dupe them
    without a tool round-trip.

    Same frozen-snapshot pattern as PortraitMiddleware: fetched once per
    agent instance (per run), transient SystemMessage, never persisted.
    Ordering note: this middleware sits BEFORE PortraitMiddleware in the
    factory list, so the portrait's prepend lands ahead of this block —
    tasks change more often than the portrait, and a stable-prefix cache
    invalidates from the first changed block onward, so the more volatile
    block goes later. Empty task list → no message at all."""

    def __init__(self) -> None:
        super().__init__()
        self._snapshot: str | None = None  # rendered once per agent instance

    async def _snapshot_message(self) -> SystemMessage | None:
        if self._snapshot is None:
            from ..tools import http_client  # noqa: PLC0415

            try:
                payload = await http_client.get("/api/scheduled-generators")
                items = payload.get("items", []) if isinstance(payload, dict) else []
            except Exception:
                # An enhancement, not a dependency — a failed fetch must not
                # kill the turn; the agent can still call the list tool.
                logger.warning("scheduled-tasks fetch failed — proceeding without", exc_info=True)
                items = []
            self._snapshot = render_scheduled_tasks(items if isinstance(items, list) else [])
        return SystemMessage(content=self._snapshot) if self._snapshot else None

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        # Chat agents run the async path; sync is a no-op fallback.
        return handler(request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        msg = await self._snapshot_message()
        if msg is not None:
            request = request.override(messages=[msg, *request.messages])
        return await handler(request)


class PortraitMiddleware(AgentMiddleware):
    """Inject the L2 portrait (AGENTS constant + the six user-strings slots) at
    model-call time — the agent's always-in-context view of the user.

    Fetched once per agent instance from /api/agent/user-strings (under the run
    JWT, which run_context sets before the first model call), assembled via
    build_portrait, and prepended as a transient SystemMessage — same
    cache-stable pattern as CurrentDatetimeMiddleware (never persisted; goes at
    the FRONT so it hoists into the system array without disturbing the final
    cache breakpoint). The portrait is the small resident L2 layer; the large
    L1 timeline is pulled on demand via events_search.
    """

    def __init__(self) -> None:
        super().__init__()
        self._portrait: str | None = None  # built once per agent instance

    async def _portrait_message(self) -> SystemMessage | None:
        if self._portrait is None:
            from ..agents.prompts.portrait import build_portrait  # noqa: PLC0415
            from ..tools import http_client  # noqa: PLC0415

            try:
                # Trailing slash is required: the route is mounted at
                # `/api/agent/user-strings/`; without it FastAPI 307-redirects
                # and httpx (no auto-follow) hands back an empty body.
                payload = await http_client.get("/api/agent/user-strings/")
                slots = payload.get("slots", {}) if isinstance(payload, dict) else {}
            except Exception:
                # Portrait is an enhancement, not a hard dependency — a failed
                # fetch (api hiccup, auth, redirect) must not kill the chat turn.
                # build_portrait({}) still yields the AGENTS safety constant.
                logger.warning("portrait fetch failed — proceeding without it", exc_info=True)
                slots = {}
            self._portrait = build_portrait(slots)
        return SystemMessage(content=self._portrait) if self._portrait else None

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        # The chat agent always runs the async path (astream_events); the sync
        # path can't await the fetch, so it's a no-op fallback.
        return handler(request)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        msg = await self._portrait_message()
        if msg is not None:
            request = request.override(messages=[msg, *request.messages])
        return await handler(request)
