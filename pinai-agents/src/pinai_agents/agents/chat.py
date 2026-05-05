"""Chat agent factory (Step 1.6).

Two flavors share the same DeepAgents harness; only system_prompt differs:

    - main_chat: user's persistent conversation (`agent:main:proactive-ai:chat:*`)
    - card_chat: scoped to one IntentCard (`chat:card:<card_id>`)

Tool surface is the DeepAgents default (todo / fs / subagent), no sandbox
in Step 1 — fs/todo writes go to in-memory state. Step 4 wires browser tool
on top of this base.

Thread continuity: caller passes session_key as thread_id; LangGraph
checkpointer (Step 1.4) restores prior turns.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends.protocol import BackendProtocol

from ..checkpoint import get_checkpointer
from ..llm import make_chat_model

logger = logging.getLogger(__name__)


_MAIN_CHAT_INSTRUCTIONS = """You are the **Chat** agent in the Proactive AI system.

Be terse, accurate, and helpful. Match the user's language. When you don't
have enough context to answer, say so plainly — do not invent specifics.

You have access to default scratch tools (todo / file / subagent) for
internal planning. Do NOT explain to the user that you used them. The user
sees only your final reply, not your intermediate reasoning.

Step 1 stub: this build does not yet have access to the user's memory,
signals, or connector data — say "I don't have that data hooked up yet"
when asked about anything user-specific (e.g. recent emails, calendar,
past chats outside this thread)."""


_CARD_CHAT_INSTRUCTIONS_HEADER = """You are the **Card Chat** agent in the
Proactive AI system. The user is focused on the IntentCard below; help them
decide whether to confirm, modify, or dismiss it. Stay scoped to this one
decision unless the user explicitly asks to broaden.

Be terse and decision-oriented. Match the user's language."""


def make_main_chat_agent(
    *,
    virtual_key: str,
    backend: BackendProtocol,
    model: str | None = None,
) -> Any:
    """Build the main-chat agent. Caller passes thread_id at invoke time and
    provides a thread-scoped sandbox backend (see sandbox.get_or_create_thread_sandbox)."""
    return create_deep_agent(
        model=make_chat_model(virtual_key=virtual_key, model=model, streaming=True),
        system_prompt=_MAIN_CHAT_INSTRUCTIONS,
        backend=backend,
        checkpointer=get_checkpointer(),
    )


def make_card_chat_agent(
    *,
    virtual_key: str,
    backend: BackendProtocol,
    card_context: dict[str, Any] | None,
    model: str | None = None,
) -> Any:
    """Build the card-chat agent. card_context is the card JSON the user is
    looking at. None falls back to main chat instructions."""
    if card_context is None:
        return make_main_chat_agent(virtual_key=virtual_key, backend=backend, model=model)

    # JSON-stringified context block. Uses ensure_ascii=False so CJK text
    # in card titles isn't escaped (cleaner prompt, no token waste).
    context_block = json.dumps(card_context, ensure_ascii=False, indent=2)
    instructions = f"""{_CARD_CHAT_INSTRUCTIONS_HEADER}

<card_context>
{context_block}
</card_context>

Step 1 stub: this build does not yet have access to memory / signals /
connector data outside this card. If the user asks for context beyond the
card itself, say "I don't have that data hooked up yet"."""

    return create_deep_agent(
        model=make_chat_model(virtual_key=virtual_key, model=model, streaming=True),
        system_prompt=instructions,
        backend=backend,
        checkpointer=get_checkpointer(),
    )
