"""Native @tool wrappers for the scheduled generator API.

Thin shells over web's /api/scheduled-generators/* — the same surface the
frontend Settings page uses. Main Chat uses these so a user can say
"每天 9 点给我推一些 AI 新闻" in plain language and get a confirmed,
recurring card-generation task.

The create flow is two-step and reply-gated (v1 has no approval button):

  1. scheduled_generator_preview — normalize the request into a
     parsedIntent + confirmedBrief draft and surface any similarTasks. The
     agent shows this back to the user for confirmation.
  2. scheduled_generator_create — only AFTER the user replies to confirm.
     Pass the preview's fields back verbatim. If it returns
     requiresConfirmation (newly-found similar tasks), show them and ask
     once more, then retry with duplicate_ack=True.

list / pause / resume / delete back the Settings management surface and can
also be driven from chat. All calls go out over http_client with the
per-run agent JWT — web's scheduled_generator_principal resolves the agent
principal first, so the chat process never needs DB credentials.
"""

from __future__ import annotations

from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from .. import http_client

_BASE = "/api/scheduled-generators"


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
    conversation_id: str | None = Field(
        default=None,
        max_length=200,
        description="Current conversation id, when available.",
    )


@tool("scheduled_generator_preview", args_schema=ScheduledGeneratorPreviewInput)
async def scheduled_generator_preview(
    original_request: str,
    timezone: str,
    conversation_id: str | None = None,
):
    """Turn a user's recurring card-generation request into a structured
    preview BEFORE creating anything. Call this the moment the user asks
    for a repeating / scheduled generation ("每天 / each morning / every
    week ... 推 / 生成 ..."). Returns previewId, parsedIntent (frequency,
    local time, timezone, topic), confirmedBrief (the generation spec), and
    similarTasks (existing tasks that look alike). Show this back to the
    user and ask them to confirm — do NOT call scheduled_generator_create
    until they reply to confirm."""
    return await http_client.post(
        f"{_BASE}/preview",
        {
            "originalRequest": original_request,
            "timezone": timezone,
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
    parsed_intent: dict[str, Any] = Field(
        description="The parsedIntent object from the preview result, passed back verbatim.",
    )
    confirmed_brief: dict[str, Any] = Field(
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
    parsed_intent: dict[str, Any],
    confirmed_brief: dict[str, Any],
    duplicate_ack: bool = False,
    similar_task_ids_seen: list[str] | None = None,
):
    """Create the recurring generator task — call ONLY after the user has
    replied to confirm the preview. Pass the preview's previewId /
    semanticSignature / parsedIntent / confirmedBrief back verbatim. If the
    result contains `requiresConfirmation: true`, the backend found NEW
    similar tasks the user has not seen — show those similarTasks, ask the
    user once more, then retry with duplicate_ack=True and the similar task
    ids in similar_task_ids_seen. On success returns the created task."""
    status_code, body = await http_client.post_status(
        _BASE,
        {
            "previewId": preview_id,
            "semanticSignature": semantic_signature,
            "originalRequest": original_request,
            "parsedIntent": parsed_intent,
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
