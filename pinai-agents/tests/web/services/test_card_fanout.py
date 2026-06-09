"""card_fanout — bootstrap-message derivation + kernel enqueue wiring.

DB access (pai_chat_messages idempotency probe, pai_chat_threads insert) and
the AgentRunService are faked. We focus on: which cards derive which
bootstrap message, the skip conditions, and that exactly one mailbox
post_message (card_execution + card_context meta + idempotency key) fires per
well-formed card.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from pinai_agents.web.services import card_fanout

# ── bootstrap-message derivation ───────────────────────────────────────


def test_bootstrap_message_prefers_primary_action_label():
    msg = card_fanout._bootstrap_message_for(
        {
            "id": "card-1",
            "primaryAction": {"label": "Send the reply", "type": "send"},
            "title": "Reply to OpenAI support case",
        },
    )
    assert msg == "Send the reply"


def test_bootstrap_message_falls_back_to_title():
    msg = card_fanout._bootstrap_message_for(
        {
            "id": "card-1",
            # primaryAction missing label
            "title": "Review your Composio access",
        },
    )
    assert msg == "Review your Composio access"


def test_bootstrap_message_empty_when_both_missing():
    msg = card_fanout._bootstrap_message_for({"id": "card-1"})
    assert msg == ""


def test_bootstrap_message_trims_whitespace():
    msg = card_fanout._bootstrap_message_for(
        {"id": "x", "primaryAction": {"label": "  Send  "}},
    )
    assert msg == "Send"


# ── card_context projection ─────────────────────────────────────────────


def test_card_context_includes_only_expected_keys():
    """Mirrors CardChat.tsx's cardContext projection so the agent sees
    the same fields whether triggered by fan-out or by the user clicking
    Confirm in the frontend."""
    card = {
        "id": "card-1",
        "title": "Reply to OpenAI",
        "goalBasket": "work",
        "whyNow": "Case escalated",
        "summary": "Draft response",
        "primaryAction": {"label": "Send"},
        "secondaryActions": [],
        "confidence": 0.9,
        "urgency": 0.7,
        "importance": 0.8,
        "sources": ["Gmail"],
        "extra_internal_field": "should be dropped",
    }
    ctx = card_fanout._card_context_for(card)
    assert "extra_internal_field" not in ctx
    assert ctx["id"] == "card-1"
    assert ctx["title"] == "Reply to OpenAI"
    assert ctx["primaryAction"] == {"label": "Send"}
    assert ctx["sources"] == ["Gmail"]


# ── _bootstrap_one_card (kernel enqueue) ────────────────────────────────


@asynccontextmanager
async def _fake_tx(_pool, _user_id):
    yield object()  # opaque conn — the faked repos ignore it


class _FakeChatMessagesRepo:
    """latest_id result is set per-test via class attribute."""

    latest: int | None = None

    def __init__(self, _user_id, _conn):
        pass

    async def latest_id(self, *, thread_id):  # noqa: ARG002
        return type(self).latest


class _FakeChatThreadsRepo:
    inserted: list[dict[str, Any]] = []

    def __init__(self, *, user_id, conn):  # noqa: ARG002
        pass

    async def insert_thread(self, *, thread_id, kind, card_id):
        type(self).inserted.append({"thread_id": thread_id, "kind": kind, "card_id": card_id})


def _fakes(latest: int | None):
    """Patch the DB seams; returns the recording service mock."""
    _FakeChatMessagesRepo.latest = latest
    _FakeChatThreadsRepo.inserted = []
    service = AsyncMock()
    patches = (
        patch.object(card_fanout, "user_scoped_tx", _fake_tx),
        patch.object(card_fanout, "ChatMessagesRepository", _FakeChatMessagesRepo),
        patch.object(card_fanout, "ChatThreadsRepository", _FakeChatThreadsRepo),
    )
    return service, patches


@pytest.mark.asyncio
async def test_bootstrap_one_card_enqueues_with_card_context():
    service, patches = _fakes(latest=None)
    card = {
        "id": "card-1",
        "title": "Reply to OpenAI",
        "primaryAction": {"label": "Send the reply"},
        "whyNow": "Case escalated",
    }
    with patches[0], patches[1], patches[2]:
        ok = await card_fanout._bootstrap_one_card(
            pool=None,  # type: ignore[arg-type]  # faked tx ignores it
            service=service,
            user_id=42,
            card=card,
        )
    assert ok is True
    # thread metadata row inserted so the thread list surfaces the card chat
    assert _FakeChatThreadsRepo.inserted == [
        {"thread_id": "card-thread-card-1", "kind": "card", "card_id": "card-1"}
    ]
    service.post_message.assert_awaited_once()
    kwargs = service.post_message.await_args.kwargs
    assert service.post_message.await_args.args == ("card-thread-card-1",)
    assert kwargs["user_id"] == 42
    assert kwargs["agent_kind"] == "card_execution"
    assert kwargs["source"] == "user"
    assert kwargs["content"] == "Send the reply"
    assert kwargs["idempotency_key"] == "card-bootstrap-card-1"
    ctx = kwargs["meta"]["card_context"]
    assert ctx["id"] == "card-1" and ctx["whyNow"] == "Case escalated"


@pytest.mark.asyncio
async def test_bootstrap_one_card_skips_when_thread_already_has_turns():
    """Idempotent re-fanout: persisted turns present → no enqueue."""
    service, patches = _fakes(latest=7)
    with patches[0], patches[1], patches[2]:
        ok = await card_fanout._bootstrap_one_card(
            pool=None,  # type: ignore[arg-type]
            service=service,
            user_id=1,
            card={"id": "card-1", "title": "X"},
        )
    assert ok is False
    service.post_message.assert_not_awaited()
    assert _FakeChatThreadsRepo.inserted == []


@pytest.mark.asyncio
async def test_bootstrap_one_card_skips_when_no_bootstrap_message():
    """No primaryAction.label AND no title → nothing for the agent to act
    on; skipped before any DB access."""
    service, patches = _fakes(latest=None)
    with patches[0], patches[1], patches[2]:
        ok = await card_fanout._bootstrap_one_card(
            pool=None,  # type: ignore[arg-type]
            service=service,
            user_id=1,
            card={"id": "card-1"},
        )
    assert ok is False
    service.post_message.assert_not_awaited()


# ── dispatch wiring ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_skips_when_flag_disabled(monkeypatch):
    monkeypatch.setenv("PINAI_CARD_FANOUT_ENABLED", "0")
    dispatched = await card_fanout.dispatch_card_bootstrap(
        pool=None,  # type: ignore[arg-type]  # not used when disabled
        service=AsyncMock(),
        user_id=1,
        final_cards=[{"id": "card-1", "title": "X"}],
    )
    assert dispatched == []


@pytest.mark.asyncio
async def test_dispatch_enqueues_well_formed_cards_and_survives_errors(monkeypatch):
    """One enqueue per well-formed card; malformed entries skipped; a
    failing card doesn't block the rest; only ACTUALLY enqueued cards
    count (a no-bootstrap-message card returns False and frees its slot)."""
    monkeypatch.setenv("PINAI_CARD_FANOUT_ENABLED", "1")
    monkeypatch.setenv("PINAI_CARD_FANOUT_LIMIT", "10")
    seen: list[str] = []

    async def fake_bootstrap_one(*, pool, service, user_id, card):  # noqa: ARG001
        seen.append(card["id"])
        if card["id"] == "card-ERR":
            raise RuntimeError("boom")
        return card["id"] != "card-C"  # card-C: no bootstrap message → False

    with patch.object(card_fanout, "_bootstrap_one_card", fake_bootstrap_one):
        dispatched = await card_fanout.dispatch_card_bootstrap(
            pool=None,  # type: ignore[arg-type]
            service=AsyncMock(),
            user_id=42,
            final_cards=[
                {"id": "card-A", "title": "A"},
                None,  # malformed — skipped
                {},  # missing id — skipped
                {"id": "", "title": "empty"},  # empty id — skipped
                "not a dict",  # malformed — skipped
                {"id": "card-ERR", "title": "boom"},  # raises — logged, continues
                {"id": "card-C"},  # returns False — not counted
                {"id": "card-B", "primaryAction": {"label": "B!"}},
            ],
        )
    assert seen == ["card-A", "card-ERR", "card-C", "card-B"]
    assert dispatched == ["card-A", "card-B"]


@pytest.mark.asyncio
async def test_dispatch_limits_default_preheated_cards(monkeypatch):
    """8-card generation should not immediately enqueue 8 agent turns.
    Default preheat is top 2; the rest still bootstrap on user open."""
    monkeypatch.setenv("PINAI_CARD_FANOUT_ENABLED", "1")
    monkeypatch.delenv("PINAI_CARD_FANOUT_LIMIT", raising=False)

    async def fake_bootstrap_one(*, pool, service, user_id, card):  # noqa: ARG001
        return True

    with patch.object(card_fanout, "_bootstrap_one_card", fake_bootstrap_one):
        dispatched = await card_fanout.dispatch_card_bootstrap(
            pool=None,  # type: ignore[arg-type]
            service=AsyncMock(),
            user_id=42,
            final_cards=[{"id": f"card-{i}", "title": f"Card {i}"} for i in range(8)],
        )
    assert dispatched == ["card-0", "card-1"]
