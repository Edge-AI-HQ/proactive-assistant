"""Development feedback native @tool.

Use this for product/UI/feature suggestions that need team review, not for
personalization preferences that should shape the next generation.
"""

from __future__ import annotations

from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from ...harness.ctx import current_session_key
from .. import http_client


class DevelopmentFeedbackLogInput(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=4000,
        description="The user's original product/UI/feature suggestion.",
    )
    category: Literal["ui", "feature", "bug_like", "workflow", "settings", "other"] = Field(
        description=("Product triage bucket: ui, feature, bug_like, workflow, settings, or other."),
    )
    surface: Literal["main_chat", "card_detail", "settings", "ambient", "unknown"] = Field(
        default="main_chat",
        description="Where the suggestion came from.",
    )
    summary: str | None = Field(
        default=None,
        max_length=500,
        description="One short product-review summary.",
    )
    conversation_id: str | None = Field(
        default=None,
        max_length=200,
        description="Current chat thread/conversation id when known.",
    )
    message_id: str | None = Field(
        default=None,
        max_length=200,
        description="Current user message id when known.",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Small structured context such as card id, viewport, or page.",
    )


@tool("development_feedback_log", args_schema=DevelopmentFeedbackLogInput)
async def development_feedback_log(
    text: str,
    category: Literal["ui", "feature", "bug_like", "workflow", "settings", "other"],
    surface: Literal["main_chat", "card_detail", "settings", "ambient", "unknown"] = "main_chat",
    summary: str | None = None,
    conversation_id: str | None = None,
    message_id: str | None = None,
    metadata: dict[str, Any] | None = None,
):
    """Record a product development suggestion for team review.

    Use for requests like "add a button", "make this screen easier on
    mobile", "support export", or "add a setting". Do not use for content
    preferences such as "show fewer finance cards"; those go through
    an `event_append` with event_type="preference".
    """
    effective_conversation_id = conversation_id or current_session_key.get() or None
    return await http_client.post(
        "/api/agent/development-feedback/log",
        {
            "text": text,
            "summary": summary,
            "category": category,
            "surface": surface,
            "conversationId": effective_conversation_id,
            "messageId": message_id,
            "metadata": metadata or {},
        },
    )
