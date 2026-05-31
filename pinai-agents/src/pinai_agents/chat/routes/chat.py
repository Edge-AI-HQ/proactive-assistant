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
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)
from pydantic import BaseModel, Field

from ..agents.card_execution import make_card_execution_agent
from ..agents.main_chat import make_main_chat_agent
from ..auth.run_jwt import RunJWTError, RunPrincipal, verify_run_jwt
from ..runtime.checkpoint import get_checkpointer
from ..runtime.ctx import ClientHints, run_context
from ..streaming import chat_done, chat_error, langgraph_to_sse
from ..tools.local_sandbox import (
    create_local_sandbox_backend,
    local_chat_root_dir,
    use_local_sandbox,
)
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
    the device that's actually displaying them.

    `regenerate=True` makes `message` optional — the worker pops the
    trailing AI / Tool messages from LangGraph state and resumes the
    run from the existing HumanMessage at the tail.
    """

    session_key: str = Field(min_length=1, max_length=200)
    message: str = Field(default="", max_length=8000)
    card_context: dict[str, Any] | None = None
    client_hints: ClientHintsBody | None = None
    regenerate: bool = False


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


def _extract_human_text(msg: HumanMessage | None) -> str:
    """Return the plain-text portion of a HumanMessage, regardless of
    whether its `content` is a bare string (legacy / Anthropic non-v1)
    or a v1-protocol block list (langchain-core 1.x). Used by the
    regenerate-edit diff to decide whether the frontend is asking us to
    replace the trailing HumanMessage with new text or just rerun the
    existing one."""
    if msg is None:
        return ""
    c = msg.content
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        out: list[str] = []
        for block in c:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if isinstance(t, str):
                    out.append(t)
        return "".join(out)
    return ""


def _card_context_message(card_context: dict[str, Any]) -> SystemMessage:
    """Wrap card context JSON as the `<card_context>` SystemMessage both
    the card-thread first-turn path and the main-thread per-turn path
    inject. SystemMessages are filtered out of /history, so this never
    renders to the user."""
    ctx_json = json.dumps(card_context, ensure_ascii=False, indent=2)
    return SystemMessage(
        content=(
            "<card_context>\n"
            "The user is giving feedback on this exact current card. "
            "If they say \"this card\", \"这张卡\", \"这个任务\", or ask what "
            "the current feedback card is, answer from this JSON. "
            "Do not call cards_recent to identify it.\n"
            f"{ctx_json}\n"
            "</card_context>"
        ),
    )


def _build_send_messages(
    *,
    message: str,
    card_context: dict[str, Any] | None,
    is_card_thread: bool,
    is_first_turn: bool,
) -> list[Any]:
    """Assemble the input messages for a normal (non-regenerate) send.

    Two card-context injection rules, by thread kind:
      * Card thread (`card-thread-…`): inject once, on the first turn only.
        The thread is short-lived (one per card); later turns rely on the
        checkpoint retaining the SystemMessage.
      * Main thread (per-user singleton, migration 053): inject on ANY turn
        that carries card_context. The first turn happens once in the
        user's lifetime, so a first-turn guard would never re-fire — the
        trigger is "this turn opened main chat from a card", not "first
        turn". `is_first_turn` is irrelevant here.

    Pure + side-effect-free so the branch logic is unit-testable without
    spinning up the agent / sandbox.
    """
    msgs: list[Any] = []
    if is_card_thread:
        if card_context is not None and is_first_turn:
            msgs.append(_card_context_message(card_context))
    elif card_context is not None:
        msgs.append(_card_context_message(card_context))
    msgs.append({"role": "user", "content": message})
    return msgs


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
        backend = await _get_thread_backend(req.session_key, raw_jwt=raw_jwt)
    except Exception as e:
        logger.exception(
            "sandbox provisioning failed session_key=%s", req.session_key,
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

    # ── regenerate / edit state surgery (optional) ──
    # `regenerate=True` covers two frontend flows:
    #
    #   - Pure regenerate (Retry on last user msg, Regenerate on last
    #     assistant msg): pop trailing AI / Tool messages, leave the
    #     trailing HumanMessage untouched, rerun. `req.message` here
    #     equals the trailing HumanMessage's current text (the adapter
    #     just echoes back the current last-user text); no replacement
    #     is needed.
    #
    #   - Edit-and-rerun (user edited the last user msg, hit Send): pop
    #     trailing AI / Tool messages AND replace the trailing
    #     HumanMessage with `req.message` (the edited text), then rerun.
    #
    # We auto-detect which case we're in by diffing `req.message`
    # against the trailing HumanMessage's text content. Identical → pure
    # regenerate, no human-side change. Different → edit, drop + add.
    input_messages: list[Any] = []
    if req.regenerate:
        state_config: dict[str, Any] = {
            "configurable": {"thread_id": req.session_key},
        }
        try:
            snapshot = await agent.aget_state(state_config)
        except Exception as e:
            logger.exception(
                "regenerate state read failed session=%s", req.session_key,
            )
            yield chat_error(
                f"regenerate state read failed: {type(e).__name__}: {e}",
            )
            yield chat_done()
            return
        msgs = (snapshot.values or {}).get("messages", []) if snapshot else []
        to_remove_ids: list[str] = []
        trailing_human: HumanMessage | None = None
        # Walk back: collect AI/Tool ids to drop until we hit the first
        # non-AI/Tool message. If it's a HumanMessage we remember it for
        # the edit-diff check below.
        for msg in reversed(msgs):
            if isinstance(msg, (AIMessage, ToolMessage)):
                mid = getattr(msg, "id", None)
                if mid:
                    to_remove_ids.append(mid)
                continue
            if isinstance(msg, HumanMessage):
                trailing_human = msg
            break

        new_text = (req.message or "").strip()
        trailing_text = (
            _extract_human_text(trailing_human) if trailing_human else ""
        )
        is_edit = bool(new_text) and new_text != trailing_text.strip()

        if is_edit and trailing_human is not None:
            th_id = getattr(trailing_human, "id", None)
            if th_id:
                to_remove_ids.append(th_id)

        if to_remove_ids:
            try:
                await agent.aupdate_state(
                    state_config,
                    {"messages": [RemoveMessage(id=mid) for mid in to_remove_ids]},
                )
            except Exception as e:
                logger.exception(
                    "regenerate pop failed session=%s", req.session_key,
                )
                yield chat_error(
                    f"regenerate pop failed: {type(e).__name__}: {e}",
                )
                yield chat_done()
                return
            logger.info(
                "regenerate popped %d trailing messages session=%s is_edit=%s",
                len(to_remove_ids), req.session_key, is_edit,
            )

        # If edit, add the replacement HumanMessage; if pure regen, leave
        # input_messages empty so LangGraph reruns from the popped state.
        if is_edit:
            input_messages.append({"role": "user", "content": new_text})

    # ── input messages (normal-send path) ──
    if not req.regenerate:
        if not req.message.strip():
            yield chat_error("message is required when not regenerating")
            yield chat_done()
            return
        # Only card threads need the (async) first-turn probe; main threads
        # inject per-turn so we skip the checkpoint read for them.
        is_first_turn = (
            await _is_first_turn(req.session_key) if is_card_thread else False
        )
        input_messages.extend(
            _build_send_messages(
                message=req.message,
                card_context=req.card_context,
                is_card_thread=is_card_thread,
                is_first_turn=is_first_turn,
            ),
        )

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


async def _get_thread_backend(session_key: str, *, raw_jwt: str) -> Any:
    if use_local_sandbox():
        root_dir = local_chat_root_dir(session_key)
        logger.info(
            "chat using local sandbox backend session_key=%s root_dir=%s",
            session_key,
            root_dir,
        )
        return create_local_sandbox_backend(run_jwt=raw_jwt, root_dir=root_dir)
    backend, _ = await get_or_create_thread_sandbox(session_key, run_jwt=raw_jwt)
    return backend
