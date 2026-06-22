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

from ...agents.card_execution import make_card_execution_agent
from ...agents.main_chat import make_main_chat_agent
from ...auth.run_jwt import RunJWTError, RunPrincipal, verify_run_jwt
from ...harness.compaction import (
    compact_thread,
    scrub_empty_ai_messages,
    should_attempt_compaction,
)
from ...harness.ctx import ClientHints, run_context
from ...harness.group_title import make_group_title_fn
from ...harness.session import (
    make_resume_input,
    read_state_messages,
    stream_events,
)
from ...tools.browser.manager import get_browser_manager
from ...tools.code_mode.lazy_sandbox import LazyThreadSandbox
from ...tools.code_mode.local_sandbox import (
    create_local_sandbox_backend,
    local_chat_root_dir,
    use_local_sandbox,
)
from ...tools.code_mode.sandbox import evict_thread
from ..sse import TurnStats, chat_done, chat_error, langgraph_to_sse
from ._session_auth import assert_session_key_principal

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
    """

    session_key: str = Field(min_length=1, max_length=200)
    message: str = Field(default="", max_length=8000)
    # Actor-kernel merge: when several user messages drain as one turn they're
    # sent as SEPARATE role=user messages (NOT concatenated — CORE-0 verified
    # LiteLLM/Anthropic accept consecutive user turns). Takes precedence over
    # `message` when non-empty; `message` stays for the single-message frontend
    # path (ui/chat /send).
    messages: list[str] = Field(default_factory=list, max_length=50)
    card_context: dict[str, Any] | None = None
    # IANA timezone of the user's device/profile (web resolves it — chat has
    # no DB). Carried into run_context; CurrentDatetimeMiddleware injects a
    # day-granular <current_datetime> anchor at model-call time so the agent
    # can resolve relative dates ("明天", "next Friday") instead of guessing.
    timezone: str | None = Field(default=None, max_length=64)
    client_hints: ClientHintsBody | None = None
    # "Bypass permissions" opt-in (composer toggle), per-run: when True the
    # agent is built WITHOUT HumanInTheLoopMiddleware so side-effect tools run
    # without the per-call approval pause. Per-run only — never persisted here;
    # the web process reads the user's setting and tags each run.
    bypass_permissions: bool = False
    # HITL resume: re-enter a thread paused on interrupt() with the human's
    # decision(s): {"decisions": [{"type": "approve"|"reject"|..., ...}]}
    # (HumanInTheLoopMiddleware schema). Mutually exclusive with messages —
    # when set, no new input is added; Command(resume=) re-enters.
    resume: dict[str, Any] | None = None


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization: Bearer <token> required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[len("bearer ") :].strip()


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
            'If they say "this card", "这张卡", "这个任务", or ask what '
            "the current feedback card is, answer from this JSON. "
            "Do not call cards_recent to identify it.\n"
            f"{ctx_json}\n"
            "</card_context>"
        ),
    )


def _build_send_messages(
    *,
    messages: list[str],
    card_context: dict[str, Any] | None,
    is_card_thread: bool,
    is_first_turn: bool,
) -> list[Any]:
    """Assemble the input messages for a normal send.

    `messages` is one-or-more user-message texts. The actor kernel's mailbox
    merge sends every pending user message as its OWN role=user message (NOT
    concatenated — CORE-0 verified LiteLLM/Anthropic accept consecutive user
    turns), so the model sees distinct turns. The single-message frontend path
    passes a one-element list.

    Two card-context injection rules, by thread kind:
      * Card thread (`card-thread-…`): inject once, on the first turn only.
        The thread is short-lived (one per card); later turns rely on the
        checkpoint retaining the SystemMessage.
      * Main thread (per-user singleton, migration 053): inject on ANY turn
        that carries card_context. The first turn happens once in the
        user's lifetime, so a first-turn guard would never re-fire — the
        trigger is "this turn opened main chat from a card", not "first
        turn". `is_first_turn` is irrelevant here.

    The `<current_datetime>` anchor is NOT injected here — it rides as a
    transient, day-granular system block added at model-call time by
    `CurrentDatetimeMiddleware` (it must not be persisted into thread state,
    or it accumulates and overflows Anthropic's cache_control breakpoints).

    Pure + side-effect-free so the branch logic is unit-testable without
    spinning up the agent / sandbox.
    """
    msgs: list[Any] = []
    if is_card_thread:
        if card_context is not None and is_first_turn:
            msgs.append(_card_context_message(card_context))
    elif card_context is not None:
        msgs.append(_card_context_message(card_context))
    msgs.extend({"role": "user", "content": text} for text in messages)
    return msgs


async def _is_first_turn(agent: Any, session_key: str) -> bool:
    """True when the LangGraph thread for `session_key` has zero persisted
    messages. Used to guard one-shot card_context injection.

    Reads through the compiled agent's aget_state() — under
    deepagents/langgraph 1.x the messages reducer state isn't surfaced
    by raw checkpointer.aget_tuple().channel_values, only by aget_state().

    On any read error we treat as "not first turn" — re-injecting is
    harmless under LangGraph's messages reducer (dedups by id), but
    skipping the probe avoids us blocking on a transient pg blip just
    to make a polish-level decision.
    """
    try:
        msgs = await read_state_messages(agent, session_key)
    except Exception:
        logger.exception("agent state probe failed session_key=%s", session_key)
        return False
    return len(msgs) == 0


@router.post("/agent/chat")
async def chat(
    req: ChatRequest,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    token = _extract_bearer(authorization)
    principal = _verify_principal(token)
    # Defense-in-depth: web validates session_key ownership before signing
    # the JWT, but this internal endpoint must not trust that single point.
    assert_session_key_principal(req.session_key, principal)
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
    req: ChatRequest,
    principal: RunPrincipal,
    *,
    raw_jwt: str,
) -> AsyncIterator[bytes]:
    is_card_thread = req.session_key.startswith(_CARD_THREAD_PREFIX)
    # virtual_key is guaranteed non-None by _verify_principal.
    virtual_key = principal.virtual_key
    assert virtual_key is not None

    # ── sandbox (lazy: the real Daytona sandbox is provisioned on the first
    # file/exec tool call, NOT now — a pure-text turn never touches it) ──
    try:
        backend = _get_thread_backend(req.session_key, raw_jwt=raw_jwt)
    except Exception as e:
        logger.exception(
            "sandbox backend init failed session_key=%s",
            req.session_key,
        )
        yield chat_error(f"sandbox backend init failed: {type(e).__name__}: {e}")
        yield chat_done()
        return

    # ── agent factory ──
    try:
        agent = (
            make_card_execution_agent(
                virtual_key=virtual_key,
                backend=backend,
                bypass_permissions=req.bypass_permissions,
            )
            if is_card_thread
            else make_main_chat_agent(
                virtual_key=virtual_key,
                backend=backend,
                bypass_permissions=req.bypass_permissions,
            )
        )
    except Exception as e:
        logger.exception("chat agent build failed session_key=%s", req.session_key)
        yield chat_error(f"{type(e).__name__}: {e}")
        yield chat_done()
        return

    # Language anchor for async work-group titles — the user's own words
    # (thinking drifts to English; the title must not). Stays empty on a HITL
    # resume turn: it degrades to the frontend's deterministic fallback label
    # by design.
    title_user_text = ""

    input_messages: list[Any] = []
    # ── input messages (normal-send path) ──
    if not req.resume:
        # Actor kernel sends `messages` (merge: ≥1 user message, each its own
        # role=user turn); the single-message frontend path sends `message`.
        # Prefer the list when present.
        user_texts = req.messages or ([req.message] if req.message.strip() else [])
        if not user_texts:
            yield chat_error("message(s) required when not regenerating")
            yield chat_done()
            return
        title_user_text = user_texts[-1]
        # Sending a new message = the user is done driving the browser, so
        # hand control back to the AI for this turn — sparing them a manual
        # "give control back" click. Mirror of touching the page = implicit
        # takeover (manager.apply_user_input). Normal-send only: a fresh user
        # signal; a HITL resume doesn't imply they finished. Best
        # effort — a browser-control hiccup must never block the chat.
        try:
            released = await get_browser_manager().release_to_ai_if_user_driving(
                req.session_key,
            )
            if released:
                logger.info(
                    "browser: user message handed control back to AI session=%s",
                    req.session_key,
                )
        except Exception:
            logger.exception("browser auto-release failed session=%s", req.session_key)
        # Only card threads need the (async) first-turn probe; main threads
        # inject per-turn so we skip the checkpoint read for them.
        is_first_turn = await _is_first_turn(agent, req.session_key) if is_card_thread else False
        input_messages.extend(
            _build_send_messages(
                messages=user_texts,
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
        timezone=req.timezone or "",
    ):
        # HITL resume re-enters the paused graph via Command(resume=); a
        # normal turn feeds the assembled messages.
        stream_input: Any = (
            make_resume_input(req.resume.get("decisions") or [])
            if req.resume
            else {"messages": input_messages}
        )
        events = stream_events(agent, stream_input, config)
        title_fn = (
            make_group_title_fn(virtual_key=virtual_key, user_text=title_user_text)
            if title_user_text.strip()
            else None
        )
        try:
            # trace_id stamps every frame's traceId with this run's id — the
            # FE classifies proactive tick turns by it, and web's /history
            # locates the in-flight turn's frames in the Redis stream by it
            # (refresh replay).
            stats = TurnStats()
            async for chunk in langgraph_to_sse(
                events,
                trace_id=principal.run_id,
                group_title_fn=title_fn,
                stats=stats,
            ):
                yield chunk
            # Maintain the thread once the turn finishes. Best-effort: a
            # failure must never surface after the user already got the reply.
            # Skip while a HITL decision is pending — the turn paused on
            # interrupt() and isn't finished; mutating state mid-interrupt
            # would corrupt what the resume re-enters. This runs INSIDE the
            # response generator (before it returns), so the control plane's worker —
            # which awaits the whole chat stream — can't start the next turn
            # until maintenance commits: the in-place rewrites are never
            # concurrent with another turn on this session.
            # Whether maintenance is needed at all comes from stream
            # observations (TurnStats), NOT from state reads — on a long
            # thread one `aget_state` costs seconds while the session lease
            # is still held, so the common clean turn must skip straight out.
            if not stats.interrupted:
                # Every thread kind, cards included: a 0-token final reply
                # persisted into the state breaks all later turns on strict
                # providers (Moonshot empty-assistant 400) — scrub it out.
                # Only when this turn actually produced one (same predicate
                # the scrub applies); request-path guards in harness/llm.py
                # keep any pre-existing stragglers harmless until then.
                if stats.saw_empty_ai_message:
                    try:
                        await scrub_empty_ai_messages(agent, thread_id=req.session_key)
                    except Exception:
                        logger.exception(
                            "empty-message scrub failed session_key=%s",
                            req.session_key,
                        )
                # Working-context compaction (card threads are short-lived —
                # skip). main + proactive share one path.
                if not is_card_thread and should_attempt_compaction(
                    input_tokens=stats.last_input_tokens,
                    message_count=stats.last_msg_count,
                ):
                    try:
                        await compact_thread(
                            agent,
                            thread_id=req.session_key,
                            virtual_key=virtual_key,
                        )
                    except Exception:
                        logger.exception(
                            "context compaction failed session_key=%s",
                            req.session_key,
                        )
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


def _get_thread_backend(session_key: str, *, raw_jwt: str) -> Any:
    if use_local_sandbox():
        root_dir = local_chat_root_dir(session_key)
        logger.info(
            "chat using local sandbox backend session_key=%s root_dir=%s",
            session_key,
            root_dir,
        )
        return create_local_sandbox_backend(run_jwt=raw_jwt, root_dir=root_dir)
    # Daytona: hand back a lazy proxy. The real sandbox is provisioned on the
    # first file/exec tool call, NOT now — a pure-text turn never touches
    # Daytona (P1 root-cause fix for the prod hang).
    return LazyThreadSandbox(session_key, run_jwt=raw_jwt)
