"""POST /agent/chat — main + card chat SSE endpoint.

Streams LangGraph events as the proactive-ai chat:* SSE protocol the
frontend already consumes. APIs is a pass-through in Step 1.7 — no event
translation on the Node side.

Single endpoint for both flavors:
    - main chat:  body={ session_key, message, virtual_key }
    - card chat:  body={ session_key, message, virtual_key, card_context }

session_key doubles as LangGraph thread_id, so multi-turn memory is restored
from Postgres checkpointer (Step 1.4).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..agents.chat import make_card_chat_agent, make_main_chat_agent
from ..sandbox import evict_thread, get_or_create_thread_sandbox
from ..streaming import chat_done, chat_error, langgraph_to_sse

# Errors raised by Daytona / langchain-daytona / DeepAgents fs+shell
# middleware that indicate the underlying sandbox is unhealthy / gone.
# Heuristic: any exception whose message contains these tokens evicts
# the thread's cached sandbox so the next chat send creates fresh.
# More precise typing requires the daytona SDK to expose a public
# exception hierarchy, which it doesn't (as of 0.13.x).
_SANDBOX_FAILURE_HINTS = (
    "sandbox", "Sandbox", "daytona", "Daytona", "404", "not found", "NotFound",
)


def _looks_like_sandbox_failure(exc: BaseException) -> bool:
    msg = f"{type(exc).__name__}: {exc}"
    return any(hint in msg for hint in _SANDBOX_FAILURE_HINTS)

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatRequest(BaseModel):
    virtual_key: str = Field(min_length=8)
    session_key: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=8000)
    card_context: dict[str, Any] | None = None
    model: str | None = None


@router.post("/agent/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    return StreamingResponse(
        _stream(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable nginx / proxy buffering so deltas land in real time.
            "X-Accel-Buffering": "no",
        },
    )


async def _stream(req: ChatRequest) -> AsyncIterator[bytes]:
    # Thread-scoped sandbox: created on first turn of this session_key,
    # reused on follow-up turns. NOT deleted at the end of this stream —
    # registry GC + Daytona TTL handle cleanup. See pinai_agents.sandbox.
    try:
        backend, _ = await get_or_create_thread_sandbox(req.session_key)
    except Exception as e:
        logger.exception("daytona sandbox provisioning failed session_key=%s", req.session_key)
        yield chat_error(f"sandbox provisioning failed: {type(e).__name__}: {e}")
        yield chat_done()
        return

    try:
        if req.card_context is not None:
            agent = make_card_chat_agent(
                virtual_key=req.virtual_key,
                backend=backend,
                card_context=req.card_context,
                model=req.model,
            )
        else:
            agent = make_main_chat_agent(
                virtual_key=req.virtual_key,
                backend=backend,
                model=req.model,
            )
    except Exception as e:
        logger.exception("chat agent build failed session_key=%s", req.session_key)
        yield chat_error(f"{type(e).__name__}: {e}")
        yield chat_done()
        return

    config = {"configurable": {"thread_id": req.session_key}}
    events = agent.astream_events(
        {"messages": [{"role": "user", "content": req.message}]},
        config=config,
        version="v2",
    )

    # Lazy liveness: if a tool call mid-stream raises a sandbox-related
    # error, evict the thread's cached sandbox so the user's next /chat
    # call creates a fresh one. We can't transparently retry because SSE
    # has already streamed earlier deltas to the client — surfacing
    # chat:error to the frontend (which has its own retry logic) is the
    # right call. langgraph_to_sse already wraps inner exceptions and
    # emits chat:error / chat:done, so we just need to evict on the way
    # out if the failure looked sandbox-shaped.
    saw_failure: BaseException | None = None
    try:
        async for chunk in langgraph_to_sse(events):
            yield chunk
    except BaseException as e:  # pyright: ignore[reportUnusedVariable]
        saw_failure = e
        raise
    finally:
        if saw_failure is not None and _looks_like_sandbox_failure(saw_failure):
            try:
                await evict_thread(req.session_key)
            except Exception:
                logger.exception("evict_thread on failure path failed session_key=%s", req.session_key)
