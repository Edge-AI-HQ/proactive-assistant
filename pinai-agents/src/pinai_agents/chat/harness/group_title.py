"""LLM titles for closed chat work groups.

A "work group" is the contiguous run of reasoning + tool calls between two
visible text segments of an assistant turn. When one closes, the transport
layer asks for a short title to label the collapsed group (Claude.ai's
research-segment headers are the reference UX). Cheap and best-effort by
contract:

  * small model (settings.group_title_model, Haiku tier) — one short call
    per closed group; transport applies a size gate before calling at all
  * the user's own message is passed as the language anchor: thinking often
    drifts to English, the title must not
  * any failure returns None — the frontend keeps its deterministic
    fallback label, nothing user-facing depends on this call
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from langchain_core.messages import HumanMessage, SystemMessage

from ...config import get_chat_settings
from .llm import make_chat_model

logger = logging.getLogger(__name__)

# One title call must never hold the stream's done-flush hostage; the
# transport flushes pending titles with its own (shorter) deadline and this
# is the hard cap on the call itself.
_TITLE_TIMEOUT_S = 8.0
_USER_TEXT_LIMIT = 200
_ITEMS_LIMIT = 30
_TITLE_CHAR_CAP = 60

# Receives the group's digest lines ("reasoning: …", "tool tavily_search: …",
# "task: …"); returns the title or None.
GroupTitleFn = Callable[[list[str]], Awaitable[str | None]]

_SYSTEM_PROMPT = (
    "You title a just-completed segment of an AI assistant's background "
    "work. Reply with ONLY the title: one short phrase, at most 12 words, "
    "past tense, in the SAME language as the user's message. No quotes, "
    "no trailing punctuation."
)


def make_group_title_fn(*, virtual_key: str, user_text: str) -> GroupTitleFn:
    """Build the per-run title generator the SSE translator schedules."""
    model = make_chat_model(
        virtual_key=virtual_key,
        model=get_chat_settings().group_title_model,
        temperature=0.0,
        streaming=False,
        enable_prompt_cache=False,
        enable_thinking=False,
    )
    anchor_text = user_text.strip()[:_USER_TEXT_LIMIT]

    async def generate(items: list[str]) -> str | None:
        digest = "\n".join(items[:_ITEMS_LIMIT])
        prompt = [
            SystemMessage(content=_SYSTEM_PROMPT),
            HumanMessage(
                content=(
                    f"User's message (match its language):\n{anchor_text}\n\n"
                    f"Work done in this segment:\n{digest}"
                )
            ),
        ]
        try:
            response = await asyncio.wait_for(model.ainvoke(prompt), timeout=_TITLE_TIMEOUT_S)
        except Exception:
            logger.warning("group title generation failed", exc_info=True)
            return None
        text = _content_text(response.content).strip().strip('"').strip()
        return text[:_TITLE_CHAR_CAP] or None

    return generate


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "") if isinstance(block, dict) else str(block) for block in content
        )
    return str(content)
