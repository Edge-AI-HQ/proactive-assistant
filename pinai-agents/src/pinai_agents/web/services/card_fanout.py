"""Generator → per-card chat-thread bootstrap (pre-run fan-out).

After ``persist_generator_run`` writes a generator's ``final_cards`` to
``pai_pipeline_runs``, this fans out one background task per card that
opens its ``card-thread-<card_id>`` chat thread and sends a bootstrap
HumanMessage. The card-execution agent then runs (in the chat process)
until it calls ``propose_action`` and ends its turn naturally — the
LangGraph checkpointer persists the conversation state including the
``propose_action`` tool call's args, which the frontend reads later
via ``/api/chat-stream/history`` to render the pre-review drawer and
the chat detail's chip+input panel.

Wire path used:

  web (this file) ── stream_chat() ──> chat /agent/chat
                                       ─ card_execution.py agent
                                       ─ propose_action tool
                                       ─ LangGraph checkpointer

We deliberately reuse the same ``stream_chat`` proxy the user-facing
``/api/chat-stream/send`` route uses. That keeps a single code path
for "send a turn to the card-execution agent" — no separate state
machine, no new HTTP endpoint, no new DB table. The only difference
from the user-clicking-Confirm path is who sends the first
HumanMessage: here it's the fan-out task instead of the user.

Idempotency: LangGraph's checkpointer keys threads by ``thread_id``
(= session_key) so a duplicate fan-out for the same card resumes the
existing thread rather than re-running the agent. We additionally
short-circuit by probing chat ``/exists`` first — if the thread
already has any persisted turn, we skip.

Failure mode: each card's task is fire-and-forget. A failed fan-out
leaves the card with no pre-run; when the user later opens it, the
frontend's CardChat path will bootstrap the same way (user-driven
Confirm gesture), so the worst case degrades back to upstream's
manual flow rather than blocking the home view.

Env flag: ``PINAI_CARD_FANOUT_ENABLED=0`` disables spawning. Useful
for local debug when iterating the generator without burning LLM
tokens on the downstream card agent.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .chat_proxy import call_chat_exists, stream_chat

logger = logging.getLogger(__name__)

# Pin task references — without holding these, Python's GC drops the
# coroutine reference mid-execution and the relay silently dies.
# Documented Python footgun:
# https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task
_PINNED_TASKS: set[asyncio.Task[Any]] = set()

_CARD_THREAD_PREFIX = "card-thread-"


def _fanout_enabled() -> bool:
    val = os.environ.get("PINAI_CARD_FANOUT_ENABLED", "1").strip().lower()
    return val not in ("0", "false", "no", "")


def _bootstrap_message_for(card: dict[str, Any]) -> str:
    """Derive the bootstrap HumanMessage for a card.

    Mirrors AppShell.handleConfirmCard's logic so the agent receives the
    same first turn whether the fanout fired or the user clicked
    Confirm manually: card.primaryAction.label, falling back to title.
    """
    primary = card.get("primaryAction")
    if isinstance(primary, dict):
        label = primary.get("label")
        if isinstance(label, str) and label.strip():
            return label.strip()
    title = card.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    return ""


def _card_context_for(card: dict[str, Any]) -> dict[str, Any]:
    """Project the generator's card payload into the shape
    ``card_execution.py`` expects on its first turn.

    Mirrors CardChat.tsx's `cardContext` projection so the agent sees
    the same JSON whether the bootstrap originates from the FE Confirm
    path or this fan-out path.
    """
    keys = (
        "id",
        "title",
        "goalBasket",
        "whyNow",
        "summary",
        "primaryAction",
        "secondaryActions",
        "confidence",
        "urgency",
        "importance",
        "sources",
    )
    return {k: card[k] for k in keys if k in card}


async def _virtual_key_for(pool: AsyncConnectionPool, user_id: int) -> str:
    """Read the user's LiteLLM virtual key (service_tx — no JWT here)."""
    from ..db.rls import service_tx  # noqa: PLC0415

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT litellm_virtual_key FROM users WHERE id = %s",
            (user_id,),
        )
        row = await cur.fetchone()
    if row is None:
        return ""
    return row.get("litellm_virtual_key") or ""


async def _ensure_thread_row(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    session_key: str,
    card_id: str,
) -> None:
    """Insert the pai_chat_threads metadata row.

    ``/api/chat-stream/init`` does this idempotently when the user opens
    the card, but we want the thread list endpoint to surface the card
    chat as soon as the fanout fires (even before the user opens it),
    so we insert proactively. ON CONFLICT DO NOTHING — safe if
    chat-init already wrote the row.
    """
    from ..db.repositories.chat_threads import ChatThreadsRepository  # noqa: PLC0415
    from ..db.rls import user_scoped_tx  # noqa: PLC0415

    try:
        async with user_scoped_tx(pool, user_id) as conn:
            await ChatThreadsRepository(
                user_id=user_id,
                conn=conn,
            ).insert_thread(
                thread_id=session_key,
                kind="card",
                card_id=card_id,
                title=None,
            )
    except Exception:
        logger.exception(
            "fanout: insert_thread failed user=%d session=%s — continuing",
            user_id,
            session_key,
        )


async def _bootstrap_one_card(
    *,
    pool: AsyncConnectionPool,
    user_id: int,
    card: dict[str, Any],
    virtual_key: str,
) -> None:
    """Drive a single card's bootstrap turn end-to-end.

    Steps:
      1. Compute session_key + bootstrap_message.
      2. Probe chat ``/exists`` — skip if the thread already has any
         persisted turn (idempotent re-fanout).
      3. Insert pai_chat_threads metadata row.
      4. Open ``stream_chat()`` and drain the SSE bytes to completion
         so the agent's run finishes (or hits its first
         propose_action and ends its turn).

    All errors are swallowed and logged — fanout is best-effort.
    """
    card_id = card.get("id")
    if not isinstance(card_id, str) or not card_id:
        return
    session_key = f"{_CARD_THREAD_PREFIX}{card_id}"
    bootstrap = _bootstrap_message_for(card)
    if not bootstrap:
        logger.debug(
            "fanout: card=%s missing bootstrap message; skip",
            card_id,
        )
        return

    try:
        already = await call_chat_exists(
            user_id=user_id,
            session_key=session_key,
        )
    except Exception:
        logger.exception(
            "fanout: chat_exists probe failed user=%d card=%s — proceeding",
            user_id,
            card_id,
        )
        already = False
    if already:
        logger.info(
            "fanout: thread already has turns user=%d session=%s — skip",
            user_id,
            session_key,
        )
        return

    await _ensure_thread_row(
        pool,
        user_id=user_id,
        session_key=session_key,
        card_id=card_id,
    )

    ctx = _card_context_for(card)
    try:
        # Drain the SSE response so the chat worker's StreamingResponse
        # gets fully consumed; otherwise the underlying httpx pool may
        # cancel the upstream agent mid-run. We discard the bytes — the
        # agent's state persists via LangGraph checkpointer and the FE
        # reads it later via /chat-stream/history.
        async for _ in stream_chat(
            user_id=user_id,
            session_key=session_key,
            message=bootstrap,
            card_context=ctx,
            virtual_key=virtual_key,
        ):
            pass
        logger.info(
            "fanout: bootstrap done user=%d card=%s session=%s",
            user_id,
            card_id,
            session_key,
        )
    except Exception:
        logger.exception(
            "fanout: bootstrap stream failed user=%d card=%s session=%s",
            user_id,
            card_id,
            session_key,
        )


def _pin_task(task: asyncio.Task[Any]) -> None:
    _PINNED_TASKS.add(task)
    task.add_done_callback(_PINNED_TASKS.discard)


async def dispatch_card_bootstrap(
    *,
    pool: AsyncConnectionPool,
    user_id: int,
    final_cards: list[dict[str, Any]],
) -> list[str]:
    """For each well-formed card, fire a background bootstrap task.

    Returns the list of card_ids that were dispatched (for logging /
    test assertions). Does NOT await the spawned tasks — they run in
    the background and may still be in flight when this returns.

    No-op when ``PINAI_CARD_FANOUT_ENABLED=0`` is set.
    """
    if not _fanout_enabled():
        logger.info(
            "fanout: disabled by PINAI_CARD_FANOUT_ENABLED env; skipping %d cards user=%d",
            len(final_cards),
            user_id,
        )
        return []

    virtual_key = await _virtual_key_for(pool, user_id)
    if not virtual_key:
        logger.warning(
            "fanout: user=%d has no litellm_virtual_key — "
            "skipping (chat would 502 on missing vk claim)",
            user_id,
        )
        return []

    dispatched: list[str] = []
    for card in final_cards:
        if not isinstance(card, dict):
            continue
        card_id = card.get("id")
        if not isinstance(card_id, str) or not card_id:
            continue
        dispatched.append(card_id)
        task = asyncio.create_task(
            _bootstrap_one_card(
                pool=pool,
                user_id=user_id,
                card=card,
                virtual_key=virtual_key,
            ),
            name=f"card_fanout:{user_id}:{card_id}",
        )
        _pin_task(task)
    logger.info(
        "fanout: dispatched %d card bootstraps user=%d",
        len(dispatched),
        user_id,
    )
    return dispatched
