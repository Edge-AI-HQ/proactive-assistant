"""LangGraph Postgres checkpointer compat spike.

Verifies that thread state persists across:
    1. Multiple HTTP calls within the same pinai-agents process.
    2. pinai-agents process restarts (Postgres-backed).

Two endpoints:
    POST /agent/thread-spike/say  — append a user turn, return assistant reply.
    GET  /agent/thread-spike/inspect/{thread_id} — dump the saved checkpoint
        message count + last few messages, so we can verify state persists
        when called BEFORE any /say in a fresh process.

No sandbox / no tools — this spike isolates checkpointer behavior. The agent
is plain LangChain ChatOpenAI wrapped in a minimal LangGraph state graph;
reusing `create_deep_agent` would drag in fs/shell/subagent middleware that
isn't relevant to checkpoint persistence.
"""

from __future__ import annotations

import logging
from typing import Any

from deepagents import create_deep_agent
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..checkpoint import get_checkpointer
from ..llm import make_chat_model

logger = logging.getLogger(__name__)
router = APIRouter()


_AGENT_INSTRUCTIONS = (
    "You are a terse assistant for thread-state testing. "
    "Reply in fewer than 25 words. "
    "When asked to recall earlier turns, repeat them verbatim if you remember; "
    "say 'no memory' otherwise."
)


class SayRequest(BaseModel):
    virtual_key: str = Field(min_length=8)
    thread_id: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=2000)
    model: str | None = None


class SayResponse(BaseModel):
    thread_id: str
    reply: str
    message_count: int


class InspectResponse(BaseModel):
    thread_id: str
    found: bool
    message_count: int
    last_messages: list[dict[str, str]]


@router.post("/agent/thread-spike/say", response_model=SayResponse)
async def thread_say(req: SayRequest) -> SayResponse:
    """Append a user turn to the named thread; return the assistant reply.

    Run twice with the same thread_id to verify in-process memory.
    Restart pinai-agents and run again — should still recall.
    """
    try:
        checkpointer = get_checkpointer()
        agent = create_deep_agent(
            model=make_chat_model(virtual_key=req.virtual_key, model=req.model),
            system_prompt=_AGENT_INSTRUCTIONS,
            checkpointer=checkpointer,
        )
        config = {"configurable": {"thread_id": req.thread_id}}
        result: dict[str, Any] = await agent.ainvoke(
            {"messages": [{"role": "user", "content": req.message}]},
            config=config,
        )
        msgs = result.get("messages", [])
        reply = _final_assistant_text(msgs) or ""
        return SayResponse(thread_id=req.thread_id, reply=reply, message_count=len(msgs))
    except Exception as e:
        logger.exception("thread say failed")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


@router.get("/agent/thread-spike/inspect/{thread_id}", response_model=InspectResponse)
async def thread_inspect(thread_id: str) -> InspectResponse:
    """Read the checkpoint for `thread_id` directly from Postgres.

    Lets us verify state survives process restart without hitting an LLM.
    """
    try:
        checkpointer = get_checkpointer()
        config = {"configurable": {"thread_id": thread_id}}
        snapshot = await checkpointer.aget_tuple(config)
        if snapshot is None:
            return InspectResponse(thread_id=thread_id, found=False, message_count=0, last_messages=[])
        msgs = (snapshot.checkpoint.get("channel_values") or {}).get("messages") or []
        last = []
        for msg in msgs[-4:]:
            role = getattr(msg, "type", None) or "unknown"
            content = _content_to_short_text(getattr(msg, "content", ""))
            last.append({"role": role, "content_preview": content[:120]})
        return InspectResponse(
            thread_id=thread_id,
            found=True,
            message_count=len(msgs),
            last_messages=last,
        )
    except Exception as e:
        logger.exception("thread inspect failed")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}") from e


def _final_assistant_text(messages: list[Any]) -> str | None:
    for msg in reversed(messages):
        role = getattr(msg, "type", None) or (msg.get("role") if isinstance(msg, dict) else None)
        if role not in ("ai", "assistant"):
            continue
        content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
        text = _content_to_short_text(content)
        if text:
            return text
    return None


def _content_to_short_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            b.get("text", "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        return "\n".join(p for p in parts if p)
    return ""
