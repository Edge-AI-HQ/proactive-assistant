"""Native @tool wrappers for the scheduled generator API.

Thin shells over web's /api/scheduled-generators/* — the same surface the
frontend Settings page uses. Main Chat uses these so a user can say
"每天 9 点给我推一些 AI 新闻" in plain language and get a confirmed,
recurring card-generation task.

The create flow for RECURRING tasks is two-step and reply-gated (v1 has no
approval button):

  1. scheduled_generator_preview — normalize the request into a
     schedule + brief draft and surface any similarTasks. The agent shows
     this back to the user for confirmation.
  2. scheduled_generator_create — only AFTER the user replies to confirm.
     Pass the preview's fields back verbatim. If it returns
     requiresConfirmation (newly-found similar tasks), show them and ask
     once more, then retry with duplicate_ack=True.

ONE-OFF tasks skip the round-trip: scheduled_generator_create_once writes
the task directly (low-risk, instantly undoable via delete).

list / pause / resume / delete back the Settings management surface and can
also be driven from chat. All calls go out over http_client with the
per-run agent JWT — web's scheduled_generator_principal resolves the agent
principal first, so the chat process never needs DB credentials.
"""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client

_BASE = "/api/scheduled-generators"


def _as_dict(value: Any) -> Any:
    """Normalize dict | BaseModel tool args — LangChain deserializes dict
    inputs into the args_schema models, but direct calls may pass dicts."""
    return value.model_dump(exclude_none=True) if isinstance(value, BaseModel) else value


class ScheduleSpecInput(BaseModel):
    """Structured schedule. Field names mirror web's ScheduleSpecModel."""

    type: Literal["once", "interval", "cron"] = Field(
        description=(
            "once = fire one time; interval = every N seconds; cron = daily/weekly at a local time."
        ),
    )
    in_minutes: int | None = Field(
        default=None,
        ge=1,
        description=(
            "type=once with a RELATIVE time: minutes from now, e.g. 用户说 "
            "'5 分钟后' → 5. NEVER compute absolute times yourself — you "
            "have no clock; pass the relative offset and let the backend "
            "resolve it."
        ),
    )
    at_local: str | None = Field(
        default=None,
        max_length=20,
        description=(
            "type=once with an EXPLICIT date/time the user named: local "
            "'YYYY-MM-DDTHH:MM' in the task timezone. ONLY when the user "
            "named an explicit date/time — for relative phrases use "
            "in_minutes instead."
        ),
    )
    every_seconds: int | None = Field(
        default=None,
        ge=1,
        description="type=interval: fire every N seconds, e.g. '每 5 分钟' → 300.",
    )
    frequency: Literal["daily", "weekly"] | None = Field(
        default=None,
        description="type=cron: daily or weekly.",
    )
    local_time: str | None = Field(
        default=None,
        max_length=5,
        description="type=cron: 'HH:MM' local fire time, e.g. '09:00'.",
    )
    days_of_week: list[int] | None = Field(
        default=None,
        description=("type=cron weekly: ISO weekday numbers, 1=Monday … 7=Sunday."),
    )


class ReminderInput(BaseModel):
    """Reminder copy — the agent writes it in the user's language."""

    title: str = Field(
        min_length=1,
        max_length=80,
        description="Short reminder title you write in the user's language, e.g. '喝水'.",
    )
    message: str = Field(
        min_length=1,
        max_length=500,
        description=(
            "The notification text shown when the reminder fires — write it "
            "yourself in the user's language."
        ),
    )


class ScheduledGeneratorPreviewInput(BaseModel):
    original_request: str = Field(
        min_length=1,
        max_length=2000,
        description=(
            "The user's recurring-generation request in their own words, "
            "e.g. '每天 9 点给我推一些 AI 新闻' or 'every Monday morning "
            "summarize my week ahead'."
        ),
    )
    timezone: str = Field(
        min_length=1,
        max_length=100,
        description=(
            "IANA timezone the schedule should fire in, e.g. "
            "'America/Los_Angeles'. Prefer the user's device timezone when "
            "you know it; otherwise fall back to their profile timezone "
            "(profile_get). The schedule is stored in this timezone."
        ),
    )
    schedule: ScheduleSpecInput = Field(
        description="Structured schedule parsed from the user's request.",
    )
    mode: Literal["reminder", "generate"] = Field(
        default="generate",
        description=(
            "reminder = fixed nudge with copy you write (drink water, take "
            "meds); generate = fresh content each fire (news digest, "
            "schedule summary)."
        ),
    )
    topic: str | None = Field(
        default=None,
        max_length=200,
        description="mode=generate: concise generation topic, e.g. 'AI 新闻'.",
    )
    reminder: ReminderInput | None = Field(
        default=None,
        description="mode=reminder: the {title, message} you wrote.",
    )
    conversation_id: str | None = Field(
        default=None,
        max_length=200,
        description="Current conversation id, when available.",
    )


@tool("scheduled_generator_preview", args_schema=ScheduledGeneratorPreviewInput)
async def scheduled_generator_preview(
    original_request: str,
    timezone: str,
    schedule: dict[str, Any] | ScheduleSpecInput,
    mode: str = "generate",
    topic: str | None = None,
    reminder: dict[str, Any] | ReminderInput | None = None,
    conversation_id: str | None = None,
):
    """Turn a user's RECURRING scheduled-task request into a structured
    preview BEFORE creating anything. Call this the moment the user asks
    for a repeating / scheduled task ("每天 / each morning / every week /
    每 5 分钟 ..."). For one-off tasks (schedule type=once) call
    scheduled_generator_create_once instead — no preview needed. Returns
    previewId, scheduleLabel, confirmedBrief (the generation spec), and
    similarTasks (existing tasks that look alike). Show this back to the
    user and ask them to confirm — do NOT call scheduled_generator_create
    until they reply to confirm."""
    return await http_client.post(
        f"{_BASE}/preview",
        {
            "originalRequest": original_request,
            "timezone": timezone,
            "schedule": _as_dict(schedule),
            "mode": mode,
            "topic": topic,
            "reminder": _as_dict(reminder) if reminder is not None else None,
            "conversationId": conversation_id,
        },
    )


class ScheduledGeneratorCreateInput(BaseModel):
    preview_id: str = Field(
        min_length=1,
        max_length=80,
        description="previewId from the scheduled_generator_preview result.",
    )
    semantic_signature: str = Field(
        min_length=1,
        max_length=300,
        description="semanticSignature from the preview result, passed back verbatim.",
    )
    original_request: str = Field(
        min_length=1,
        max_length=2000,
        description="The same original request passed to preview.",
    )
    timezone: str = Field(
        min_length=1,
        max_length=100,
        description="The same IANA timezone passed to preview.",
    )
    schedule: ScheduleSpecInput = Field(
        description="The schedule from the preview, passed back verbatim.",
    )
    mode: Literal["reminder", "generate"] = Field(
        default="generate",
        description="The same mode passed to preview.",
    )
    topic: str | None = Field(
        default=None,
        max_length=200,
        description="The same topic passed to preview (mode=generate).",
    )
    reminder: ReminderInput | None = Field(
        default=None,
        description="The same reminder passed to preview (mode=reminder).",
    )
    confirmed_brief: dict[str, Any] | None = Field(
        default=None,
        description=(
            "The confirmedBrief object from the preview result, passed back "
            "verbatim (including any edits the user confirmed)."
        ),
    )
    duplicate_ack: bool = Field(
        default=False,
        description=(
            "Set True ONLY after the user explicitly confirmed creating the "
            "task even though similar tasks exist. Leave False on the first "
            "create attempt."
        ),
    )
    similar_task_ids_seen: list[str] = Field(
        default_factory=list,
        description=(
            "IDs of the similarTasks already shown to the user in the preview "
            "confirmation. Lets the backend skip re-asking about tasks the "
            "user already saw."
        ),
    )


@tool("scheduled_generator_create", args_schema=ScheduledGeneratorCreateInput)
async def scheduled_generator_create(
    preview_id: str,
    semantic_signature: str,
    original_request: str,
    timezone: str,
    schedule: dict[str, Any] | ScheduleSpecInput,
    mode: str = "generate",
    topic: str | None = None,
    reminder: dict[str, Any] | ReminderInput | None = None,
    confirmed_brief: dict[str, Any] | None = None,
    duplicate_ack: bool = False,
    similar_task_ids_seen: list[str] | None = None,
):
    """Create the recurring scheduled task — call ONLY after the user has
    replied to confirm the preview. Pass the preview's previewId /
    semanticSignature / schedule / mode / topic / reminder / confirmedBrief
    back verbatim. If the result contains `requiresConfirmation: true`, the
    backend found NEW similar tasks the user has not seen — show those
    similarTasks, ask the user once more, then retry with duplicate_ack=True
    and the similar task ids in similar_task_ids_seen. On success returns
    the created task."""
    status_code, body = await http_client.post_status(
        _BASE,
        {
            "previewId": preview_id,
            "semanticSignature": semantic_signature,
            "originalRequest": original_request,
            "timezone": timezone,
            "schedule": _as_dict(schedule),
            "mode": mode,
            "topic": topic,
            "reminder": _as_dict(reminder) if reminder is not None else None,
            "confirmedBrief": confirmed_brief,
            "duplicateAck": duplicate_ack,
            "similarTaskIdsSeen": similar_task_ids_seen or [],
        },
    )
    if status_code == 409:
        # Business-level "needs one more confirmation" — body carries
        # requiresConfirmation + the freshly-found similarTasks.
        return body
    if status_code >= 400:
        return {"error": f"http_{status_code}", "detail": body}
    return body


class ScheduledGeneratorCreateOnceInput(BaseModel):
    original_request: str = Field(
        min_length=1,
        max_length=2000,
        description=(
            "The user's one-off request in their own words, e.g. "
            "'5 分钟后提醒我喝水' or 'remind me at 3pm tomorrow'."
        ),
    )
    timezone: str = Field(
        min_length=1,
        max_length=100,
        description=(
            "IANA timezone the task fires in, e.g. 'Asia/Shanghai'. Prefer "
            "the user's device timezone when you know it; otherwise fall "
            "back to their profile timezone (profile_get)."
        ),
    )
    schedule: ScheduleSpecInput = Field(
        description=(
            'Must have type="once", plus in_minutes (relative phrase) OR '
            "at_local (explicit date/time)."
        ),
    )
    mode: Literal["reminder", "generate"] = Field(
        default="reminder",
        description=(
            "reminder = fixed nudge with copy you write; generate = fresh "
            "content generated when it fires (needs a topic)."
        ),
    )
    topic: str | None = Field(
        default=None,
        max_length=200,
        description="mode=generate: concise generation topic.",
    )
    reminder: ReminderInput | None = Field(
        default=None,
        description="mode=reminder: the {title, message} you wrote in the user's language.",
    )


@tool("scheduled_generator_create_once", args_schema=ScheduledGeneratorCreateOnceInput)
async def scheduled_generator_create_once(
    original_request: str,
    timezone: str,
    schedule: dict[str, Any] | ScheduleSpecInput,
    mode: str = "reminder",
    topic: str | None = None,
    reminder: dict[str, Any] | ReminderInput | None = None,
):
    """Create a ONE-OFF scheduled task directly — no preview, no confirmation
    round (one-shots are low-risk and instantly undoable). Use for "5 分钟后
    提醒我喝水" / "remind me at 3pm tomorrow" / "tomorrow 9am give me a news
    digest once". schedule.type MUST be "once". mode="reminder" needs a
    reminder {title, message} you write in the user's language; mode="generate"
    needs a topic. On success returns the task with scheduleLabel — confirm it
    back to the user and tell them they can reply to cancel. On http_400 relay
    the detail (e.g. below minimum interval) plainly."""
    status_code, body = await http_client.post_status(
        f"{_BASE}/once",
        {
            "originalRequest": original_request,
            "timezone": timezone,
            "schedule": _as_dict(schedule),
            "mode": mode,
            "topic": topic,
            "reminder": _as_dict(reminder) if reminder is not None else None,
        },
    )
    if status_code >= 400:
        return {"error": f"http_{status_code}", "detail": body}
    return body


class ScheduledGeneratorListInput(BaseModel):
    include_archived: bool = Field(
        default=False,
        description="Include deleted (archived) tasks. Default False = only active / paused.",
    )


@tool("scheduled_generator_list", args_schema=ScheduledGeneratorListInput)
async def scheduled_generator_list(include_archived: bool = False):
    """List the user's recurring generator tasks (the ones they created via
    chat or Settings). Returns items with id, title, frequency, localTime,
    timezone, and status (active / paused). Use this to answer "what
    scheduled tasks do I have" or before pausing / resuming / deleting
    one."""
    return await http_client.get(_BASE, includeArchived=include_archived)


class ScheduledGeneratorTaskIdInput(BaseModel):
    task_id: str = Field(
        min_length=1,
        max_length=200,
        description="The scheduled task id (the `id` field from scheduled_generator_list / create).",
    )


@tool("scheduled_generator_pause", args_schema=ScheduledGeneratorTaskIdInput)
async def scheduled_generator_pause(task_id: str):
    """Pause a recurring generator task so it stops firing until resumed.
    The task is kept and can be resumed later."""
    return await http_client.post(f"{_BASE}/{task_id}/pause", {})


@tool("scheduled_generator_resume", args_schema=ScheduledGeneratorTaskIdInput)
async def scheduled_generator_resume(task_id: str):
    """Resume a paused recurring generator task so it fires on schedule
    again."""
    return await http_client.post(f"{_BASE}/{task_id}/resume", {})


@tool("scheduled_generator_delete", args_schema=ScheduledGeneratorTaskIdInput)
async def scheduled_generator_delete(task_id: str):
    """Delete a recurring generator task. Use this to undo a task the user
    just created by mistake, or when they ask to remove one. The task is
    archived (soft-deleted), not hard-deleted."""
    return await http_client.delete(f"{_BASE}/{task_id}")
