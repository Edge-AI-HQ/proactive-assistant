"""POST /agent/chat — main + card chat SSE endpoint.

Trust boundary: every request carries a verified per-run JWT in the
Authorization header. The user's LiteLLM `virtual_key` rides in the JWT
claims (signed by web; chat verifies with the public key only) — chat
process never reads the users table itself.

Card threads:
    session_key shape `card-thread-<card_id>` is the contract from web.
    On the very first turn of such a thread we persist the supplied
    `card_context` JSON as a SystemMessage so subsequent turns retain
    the card without the frontend needing to re-send it. SystemMessages
    are filtered out of /agent/chat/history, so they don't pollute the
    rendered conversation.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any, Literal

import daytona
from fastapi import APIRouter, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from langchain_core.messages import SystemMessage
from pydantic import BaseModel, Field

from ..agents.card_execution import make_card_execution_agent
from ..agents.main_chat import make_main_chat_agent
from ..auth.run_jwt import RunJWTError, RunPrincipal, verify_run_jwt
from ..runtime.checkpoint import get_checkpointer
from ..runtime.ctx import ClientHints, run_context
from ..streaming import chat_done, chat_error, langgraph_to_sse
from ..tools.sandbox import evict_thread, get_or_create_thread_sandbox

logger = logging.getLogger(__name__)

# Card threads use this session_key prefix — see web/routes/ui/chat.py.
_CARD_THREAD_PREFIX = "card-thread-"


def _is_sandbox_dead(exc: BaseException) -> bool:
    """True iff the exception means the cached sandbox is unrecoverable.

    Scope of this catch is narrow: `langgraph_to_sse` already swallows
    `Exception` into `chat:error` SSE events, so DaytonaError raised from
    a tool call rarely reaches us here. Two paths still hit:
      - BaseException-not-Exception (CancelledError on client disconnect)
        — never a Daytona issue, returns False.
      - Errors during the StreamingResponse `yield chunk` transport —
        also not Daytona.
    The cache-validation path in `tools/sandbox.py:_validate_cached`
    handles dead sandboxes lazily on the next turn (DaytonaNotFoundError
    from `refresh_data` → drop entry → recreate). This route-level
    check stays as a defensive backstop in case future paths bubble a
    DaytonaNotFoundError directly through the StreamingResponse.
    """
    return isinstance(exc, daytona.DaytonaNotFoundError)


router = APIRouter()


class ClientHintsBody(BaseModel):
    """Per-request device hints from the frontend (matches web's
    `shared.api_models.ClientHints` — snake_case here because chat
    accepts the canonical body shape that web's proxy forwards)."""

    viewport_width: int = Field(ge=200, le=4096)
    viewport_height: int = Field(ge=200, le=4096)
    device_kind: Literal["mobile", "tablet", "desktop"] = "desktop"


class ChatRequest(BaseModel):
    """Request body. Notably absent: virtual_key (JWT claim) and model
    (single deployment-wide model). card_context is consumed only on the
    first turn of a card thread. client_hints carries the frontend's
    panel CSS size + device kind so browser_tool sizes BB sessions for
    the device that's actually displaying them."""

    session_key: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=8000)
    card_context: dict[str, Any] | None = None
    client_hints: ClientHintsBody | None = None


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization: Bearer <token> required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[len("bearer "):].strip()


def _verify_principal(token: str) -> RunPrincipal:
    """Bearer JWT → RunPrincipal. Raises 401 on bad-token; 400 if the
    token is well-formed but lacks the `vk` claim a chat-driving call
    requires."""
    try:
        principal = verify_run_jwt(token)
    except RunJWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"invalid run JWT: {e}",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e
    if not principal.virtual_key:
        # Defensive — web only signs chat tokens with `vk` set. Sandbox
        # tools / scheduler tokens skip `vk` and don't hit this route.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="run JWT missing `vk` claim — caller must be a chat-driving route",
        )
    return principal


async def _is_first_turn(session_key: str) -> bool:
    """True when the LangGraph thread for `session_key` has zero persisted
    messages. Used to guard one-shot card_context injection.

    On any checkpointer error we treat as "not first turn" — re-injecting
    is harmless under LangGraph's messages reducer (dedups by id), but
    skipping the snapshot read avoids us blocking on a transient pg blip
    just to make a polish-level decision.
    """
    try:
        cp = get_checkpointer()
        snapshot = await cp.aget_tuple(
            {"configurable": {"thread_id": session_key}},
        )
    except Exception:
        logger.exception("checkpoint probe failed session_key=%s", session_key)
        return False
    if snapshot is None:
        return True
    msgs = (snapshot.checkpoint.get("channel_values") or {}).get("messages") or []
    return len(msgs) == 0


@router.post("/agent/chat")
async def chat(
    req: ChatRequest,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    token = _extract_bearer(authorization)
    principal = _verify_principal(token)
    return StreamingResponse(
        _stream(req, principal, raw_jwt=token),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Run-Id": principal.run_id,
        },
    )


async def _stream(
    req: ChatRequest, principal: RunPrincipal, *, raw_jwt: str,
) -> AsyncIterator[bytes]:
    is_card_thread = req.session_key.startswith(_CARD_THREAD_PREFIX)
    # virtual_key is guaranteed non-None by _verify_principal.
    virtual_key = principal.virtual_key
    assert virtual_key is not None

    # ── sandbox ──
    try:
        backend, _ = await get_or_create_thread_sandbox(
            req.session_key, run_jwt=raw_jwt,
        )
    except Exception as e:
        logger.exception(
            "daytona sandbox provisioning failed session_key=%s", req.session_key,
        )
        yield chat_error(f"sandbox provisioning failed: {type(e).__name__}: {e}")
        yield chat_done()
        return

    # ── agent factory ──
    try:
        agent = (
            make_card_execution_agent(virtual_key=virtual_key, backend=backend)
            if is_card_thread
            else make_main_chat_agent(virtual_key=virtual_key, backend=backend)
        )
    except Exception as e:
        logger.exception("chat agent build failed session_key=%s", req.session_key)
        yield chat_error(f"{type(e).__name__}: {e}")
        yield chat_done()
        return

    # ── input messages ──
    # Card threads with card_context: inject the JSON as a SystemMessage
    # on the first turn only; subsequent turns rely on LangGraph's
    # checkpoint state to retain the context. SystemMessages are filtered
    # out of the rendered history, so this stays invisible to the user.
    input_messages: list[Any] = []
    if (
        is_card_thread
        and req.card_context is not None
        and await _is_first_turn(req.session_key)
    ):
        ctx_json = json.dumps(req.card_context, ensure_ascii=False, indent=2)
        input_messages.append(
            SystemMessage(content=f"<card_context>\n{ctx_json}\n</card_context>"),
        )
    input_messages.append({"role": "user", "content": req.message})

    config: dict[str, Any] = {
        "configurable": {"thread_id": req.session_key},
        "tags": [
            f"user:{principal.user_id}",
            f"session:{req.session_key}",
            f"run:{principal.run_id}",
        ],
        "metadata": {
            "user_id": principal.user_id,
            "run_id": principal.run_id,
            "session_key": req.session_key,
        },
        "run_name": f"chat:{req.session_key}",
        # deepagents wires `with_config({"recursion_limit": 9999})` on the
        # compiled graph, but `Runnable.astream_events` calls langchain-core's
        # `ensure_config(config)` which populates `recursion_limit=25` as a
        # default. That defaulted value then overrides the binding's 9999
        # inside `Pregel.astream`'s merge — net effect is a silent 25 cap.
        # Pin the runtime value here so the cap reflects what we actually want.
        "recursion_limit": 200,
    }
    saw_failure: BaseException | None = None

    # ContextVars carry per-run identity to native tools without threading
    # parameters through the agent → tool call chain. session_key doubles
    # as Daytona thread sandbox key — get_or_create_thread_sandbox uses
    # it to find the cached sandbox so DeepAgents fs + execute middleware
    # stay on the same cloud resource turn-to-turn.
    hints: ClientHints | None = None
    if req.client_hints is not None:
        hints = ClientHints(
            viewport_width=req.client_hints.viewport_width,
            viewport_height=req.client_hints.viewport_height,
            device_kind=req.client_hints.device_kind,
        )
    with run_context(
        user_id=principal.user_id,
        run_id=principal.run_id,
        run_jwt=raw_jwt,
        virtual_key=virtual_key,
        session_key=req.session_key,
        browserbase_context_id=principal.browserbase_context_id or "",
        client_hints=hints,
    ):
        events = agent.astream_events(
            {"messages": input_messages}, config=config, version="v2",
        )
        try:
            async for chunk in langgraph_to_sse(events):
                yield chunk
        except BaseException as e:
            saw_failure = e
            raise
        finally:
            if saw_failure is not None and _is_sandbox_dead(saw_failure):
                try:
                    await evict_thread(req.session_key)
                except Exception:
                    logger.exception(
                        "evict_thread on failure path failed session_key=%s",
                        req.session_key,
                    )
