"""Generator → per-card chat-thread bootstrap (pre-run fan-out).

After ``persist_generator_run`` writes a generator's ``final_cards`` to
``pai_pipeline_runs``, this enqueues one bootstrap turn per card onto the
Agent Core actor kernel: the card's ``card-thread-<card_id>`` session gets a
mailbox message (the bootstrap text + ``card_context`` meta) and the
AgentRunWorker drives the card-execution agent until it calls
``propose_action`` and ends its turn. Like any kernel turn it persists to
``pai_chat_messages`` and streams over the FrameBus — a user who opens the
card mid-bootstrap watches it live (conversation /history `active` rebuild +
replay), and the drawer reads the persisted ``propose_action`` afterwards via
``/api/conversation/history``.

Wire path:

  web (this file) ── AgentRunService.post_message ──> mailbox
      → AgentRunWorker → chat /agent/chat → card_execution agent
      → propose_action → pai_chat_messages + FrameBus

This is the same path a user-sent card turn takes (``/api/conversation/send``)
— the only difference is who enqueues the first message. Enqueueing is a
couple of cheap DB writes, so cards are dispatched inline (no background
tasks to babysit); the agent turns themselves run asynchronously in the
worker, one at a time per session (drain lease).

Idempotency: a thread that already has persisted turns is skipped, and
``post_message`` carries ``idempotency_key="card-bootstrap-<card_id>"`` so a
duplicate dispatch (generator retry) dedupes at the mailbox.

Failure mode: best-effort per card. A failed enqueue leaves the card with no
pre-run; when the user later opens it, the FE bootstrap path sends the same
first message (CardChat / drawer Confirm), so the worst case degrades to the
manual flow rather than blocking the home view.

Env flags: ``PINAI_CARD_FANOUT_ENABLED=0`` disables spawning;
``PINAI_CARD_FANOUT_LIMIT`` caps how many cards preheat per generation
(default 2 — an 8-card run must not immediately burn 8 agent turns).
"""

from __future__ import annotations

import logging
import os
from typing import Any

from pinai_db.rls import user_scoped_tx
from psycopg_pool import AsyncConnectionPool

from ...control.kernel import AgentRunService
from ...platform.db.repositories.chat_messages import ChatMessagesRepository
from ...platform.db.repositories.chat_threads import ChatThreadsRepository

logger = logging.getLogger(__name__)

_CARD_THREAD_PREFIX = "card-thread-"
_DEFAULT_FANOUT_LIMIT = 2


def _fanout_enabled() -> bool:
    val = os.environ.get("PINAI_CARD_FANOUT_ENABLED", "1").strip().lower()
    return val not in ("0", "false", "no", "")


def _fanout_limit() -> int:
    raw = os.environ.get("PINAI_CARD_FANOUT_LIMIT")
    if raw is None or raw.strip() == "":
        return _DEFAULT_FANOUT_LIMIT
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("fanout: invalid PINAI_CARD_FANOUT_LIMIT=%r; using default", raw)
        return _DEFAULT_FANOUT_LIMIT


def _bootstrap_message_for(card: dict[str, Any]) -> str:
    """Derive the bootstrap message for a card.

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
        "cardKind",
        "scheduleTaskId",
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


async def _bootstrap_one_card(
    *,
    pool: AsyncConnectionPool,
    service: AgentRunService,
    user_id: int,
    card: dict[str, Any],
) -> bool:
    """Enqueue a single card's bootstrap turn. Returns True when enqueued.

    Steps:
      1. Derive the bootstrap message — a card with neither
         primaryAction.label nor title has nothing to act on → skip.
      2. Skip a thread that already has persisted turns (idempotent
         re-fanout).
      3. Insert the pai_chat_threads metadata row so the thread list
         surfaces the card chat before the user first opens it.
      4. post_message onto the session mailbox — the worker picks it up
         and drives the card-execution agent asynchronously.
    """
    card_id = card["id"]  # caller validated non-empty str
    session_key = f"{_CARD_THREAD_PREFIX}{card_id}"
    bootstrap = _bootstrap_message_for(card)
    if not bootstrap:
        logger.debug("fanout: card=%s missing bootstrap message; skip", card_id)
        return False

    async with user_scoped_tx(pool, user_id) as conn:
        already = await ChatMessagesRepository(user_id, conn).latest_id(thread_id=session_key)
        if already is not None:
            logger.info(
                "fanout: thread already has turns user=%d session=%s — skip",
                user_id,
                session_key,
            )
            return False
        await ChatThreadsRepository(user_id=user_id, conn=conn).insert_thread(
            thread_id=session_key,
            kind="card",
            card_id=card_id,
        )

    await service.post_message(
        session_key,
        user_id=user_id,
        agent_kind="card_execution",
        source="user",
        content=bootstrap,
        meta={"card_context": _card_context_for(card)},
        idempotency_key=f"card-bootstrap-{card_id}",
    )
    logger.info("fanout: bootstrap enqueued user=%d session=%s", user_id, session_key)
    return True


async def dispatch_card_bootstrap(
    *,
    pool: AsyncConnectionPool,
    service: AgentRunService,
    user_id: int,
    final_cards: list[dict[str, Any]],
) -> list[str]:
    """Enqueue a bootstrap turn for up to ``PINAI_CARD_FANOUT_LIMIT`` cards.

    Returns the card_ids actually enqueued (for logging / test assertions).
    The agent turns run asynchronously in the worker — this only writes the
    mailbox rows. No-op when ``PINAI_CARD_FANOUT_ENABLED=0``.
    """
    if not _fanout_enabled():
        logger.info(
            "fanout: disabled by PINAI_CARD_FANOUT_ENABLED env; skipping %d cards user=%d",
            len(final_cards),
            user_id,
        )
        return []

    limit = _fanout_limit()
    if limit <= 0:
        logger.info(
            "fanout: PINAI_CARD_FANOUT_LIMIT=%d; skipping %d cards user=%d",
            limit,
            len(final_cards),
            user_id,
        )
        return []

    dispatched: list[str] = []
    for card in final_cards:
        if len(dispatched) >= limit:
            break
        if not isinstance(card, dict):
            continue
        card_id = card.get("id")
        if not isinstance(card_id, str) or not card_id:
            continue
        try:
            if await _bootstrap_one_card(pool=pool, service=service, user_id=user_id, card=card):
                dispatched.append(card_id)
        except Exception:
            logger.exception(
                "fanout: enqueue failed user=%d card=%s — continuing",
                user_id,
                card_id,
            )
    logger.info("fanout: enqueued %d card bootstrap(s) user=%d", len(dispatched), user_id)
    return dispatched
