"""card_fanout — bootstrap-message derivation + dispatch wiring.

Heavy lifting (DB upsert into pai_chat_threads, SSE drain via httpx) is
mocked. We focus on the dispatch surface: which cards generate which
(session_key, bootstrap_message) pair, and that the per-card bootstrap
task is fired exactly once per well-formed card.
"""

from __future__ import annotations

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


# ── dispatch wiring ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_dispatch_skips_when_flag_disabled(monkeypatch):
    monkeypatch.setenv("PINAI_CARD_FANOUT_ENABLED", "0")
    dispatched = await card_fanout.dispatch_card_bootstrap(
        pool=None,  # type: ignore[arg-type]  # not used when disabled
        user_id=1,
        final_cards=[{"id": "card-1", "title": "X"}],
    )
    assert dispatched == []


@pytest.mark.asyncio
async def test_dispatch_skips_when_no_virtual_key(monkeypatch):
    monkeypatch.setenv("PINAI_CARD_FANOUT_ENABLED", "1")
    with patch(
        "pinai_agents.web.services.card_fanout._virtual_key_for",
        new=AsyncMock(return_value=""),
    ):
        dispatched = await card_fanout.dispatch_card_bootstrap(
            pool=None,  # type: ignore[arg-type]
            user_id=1,
            final_cards=[{"id": "card-1", "title": "X"}],
        )
    assert dispatched == []


@pytest.mark.asyncio
async def test_dispatch_fires_one_task_per_well_formed_card(monkeypatch):
    """One spawn per card with id + bootstrap message. Malformed entries
    (missing id, non-dict, empty bootstrap) are silently skipped."""
    monkeypatch.setenv("PINAI_CARD_FANOUT_ENABLED", "1")
    captured: list[tuple[int, str]] = []

    async def fake_bootstrap_one(
        *,
        pool,
        user_id,
        card,
        virtual_key,  # noqa: ARG001
    ):
        captured.append((user_id, card["id"]))

    with (
        patch(
            "pinai_agents.web.services.card_fanout._virtual_key_for",
            new=AsyncMock(return_value="vk_test"),
        ),
        patch(
            "pinai_agents.web.services.card_fanout._bootstrap_one_card",
            new=fake_bootstrap_one,
        ),
    ):
        dispatched = await card_fanout.dispatch_card_bootstrap(
            pool=None,  # type: ignore[arg-type]
            user_id=42,
            final_cards=[
                {"id": "card-A", "title": "A"},
                {"id": "card-B", "title": "B", "primaryAction": {"label": "B!"}},
                None,  # malformed — skipped
                {},  # missing id — skipped
                {"id": "", "title": "empty"},  # empty id — skipped
                "not a dict",  # malformed — skipped
                {"id": "card-C"},  # title fallback empty — still dispatched
            ],
        )

    # All cards with a non-empty id get a slot in `dispatched`; the
    # per-card task itself is what filters out cards with no bootstrap
    # message (card-C above has neither primaryAction nor title).
    assert dispatched == ["card-A", "card-B", "card-C"]
    # The fake bootstrap was awaited 0 times here (we patched it at the
    # function level, not at the task level, so the asyncio.create_task
    # body completes immediately with our mock).
    #
    # When create_task fires, the event loop has to schedule the
    # coroutine — pytest-asyncio's loop drains pending tasks on test
    # teardown, but we can't rely on ordering without awaiting them
    # ourselves. Capture-set assertion below is the durable check.
    #
    # Yield control once so the spawned tasks run.
    import asyncio  # noqa: PLC0415

    await asyncio.sleep(0)
    captured_card_ids = sorted(card_id for _, card_id in captured)
    assert captured_card_ids == ["card-A", "card-B", "card-C"]


# ── _bootstrap_one_card short-circuits ─────────────────────────────────


@pytest.mark.asyncio
async def test_bootstrap_one_card_skips_when_thread_already_has_turns():
    """If the chat thread already has any persisted turn, skip the
    bootstrap (idempotent re-fanout)."""
    stream_called = False

    async def fake_stream_chat(**_kwargs: Any):
        nonlocal stream_called
        stream_called = True
        if False:
            yield b""

    with (
        patch(
            "pinai_agents.web.services.card_fanout.call_chat_exists",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "pinai_agents.web.services.card_fanout._ensure_thread_row",
            new=AsyncMock(),
        ),
        patch(
            "pinai_agents.web.services.card_fanout.stream_chat",
            new=fake_stream_chat,
        ),
    ):
        await card_fanout._bootstrap_one_card(
            pool=None,  # type: ignore[arg-type]
            user_id=1,
            card={"id": "card-1", "title": "X"},
            virtual_key="vk_test",
        )
    assert stream_called is False


@pytest.mark.asyncio
async def test_bootstrap_one_card_skips_when_no_bootstrap_message():
    """Cards without primaryAction.label AND without title should not
    trigger a bootstrap — the agent has nothing to act on."""
    exists_called = False

    async def fake_exists(**_kwargs: Any):
        nonlocal exists_called
        exists_called = True
        return False

    with patch(
        "pinai_agents.web.services.card_fanout.call_chat_exists",
        new=fake_exists,
    ):
        await card_fanout._bootstrap_one_card(
            pool=None,  # type: ignore[arg-type]
            user_id=1,
            card={"id": "card-1"},  # no primaryAction, no title
            virtual_key="vk_test",
        )
    assert exists_called is False
