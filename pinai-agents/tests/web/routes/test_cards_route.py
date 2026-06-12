from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.rls import user_scoped_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


async def _client_for(pool, user_id: int) -> httpx.AsyncClient:
    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_id)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_cards_include_latest_user_outcome(pool, user_ids) -> None:
    user_a, _ = user_ids
    run_id = "run_cards_outcome"
    card_id = "card_cards_outcome"
    card = {
        "id": card_id,
        "intentKey": "work:openai-ticket",
        "goalBasket": "work",
        "title": "OpenAI ticket follow-up",
        "summary": "Draft the reply.",
        "whyNow": "The customer is waiting.",
        "primaryAction": {"label": "Draft a reply", "type": "confirm"},
        "sources": ["gmail msg_1"],
    }
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_pipeline_runs
              (user_id, id, run_id, status, total_iterations, final_cards,
               trigger, started_at, completed_at)
            VALUES (%s, %s, %s, 'completed', 1, %s::jsonb,
                    'manual', %s, %s)
            """,
            (
                user_a,
                run_id,
                run_id,
                json.dumps([card]),
                datetime(2026, 5, 18, 9, 0, tzinfo=UTC),
                datetime(2026, 5, 18, 9, 1, tzinfo=UTC),
            ),
        )
        await conn.execute(
            """
            INSERT INTO pai_feedback_events
              (user_id, id, kind, action, intent_card_id, basket, channel, created_at)
            VALUES
              (%s, 'fb_cards_confirm', 'card_action', 'confirm', %s, 'work', 'web', %s),
              (%s, 'fb_cards_complete', 'card_action', 'complete', %s, 'work', 'web', %s)
            """,
            (
                user_a,
                card_id,
                datetime(2026, 5, 18, 9, 2, tzinfo=UTC),
                user_a,
                card_id,
                datetime(2026, 5, 18, 9, 5, tzinfo=UTC),
            ),
        )

    client = await _client_for(pool, user_a)
    async with client:
        res = await client.get("/api/cards")

    assert res.status_code == 200, res.text
    cards = res.json()["cards"]
    assert cards[0]["card"]["id"] == card_id
    assert cards[0]["latestOutcome"] == "complete"
    assert cards[0]["outcomeAt"] == "2026-05-18T09:05:00+00:00"
    # No pai_agent_runs row for this card's thread → no execution status.
    assert cards[0]["runStatus"] is None


@pytest.mark.asyncio
async def test_cards_include_latest_run_status(pool, user_ids) -> None:
    """runStatus reflects the NEWEST pai_agent_runs row of the card's
    execution thread (card-thread-<card_id>), not any earlier one, and
    other users' runs never leak in."""
    user_a, user_b = user_ids
    run_id = "run_cards_runstatus"
    card_id = "card_cards_runstatus"
    card = {
        "id": card_id,
        "intentKey": "work:status-card",
        "goalBasket": "work",
        "title": "Status card",
        "summary": "Check the run status plumbing.",
        "primaryAction": {"label": "Do the thing", "type": "confirm"},
        "sources": [],
    }
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_pipeline_runs
              (user_id, id, run_id, status, total_iterations, final_cards,
               trigger, started_at, completed_at)
            VALUES (%s, %s, %s, 'completed', 1, %s::jsonb,
                    'manual', %s, %s)
            """,
            (
                user_a,
                run_id,
                run_id,
                json.dumps([card]),
                datetime(2026, 5, 18, 10, 0, tzinfo=UTC),
                datetime(2026, 5, 18, 10, 1, tzinfo=UTC),
            ),
        )
        # Older succeeded run, then a newer running one — the endpoint must
        # surface the newer status.
        await conn.execute(
            """
            INSERT INTO pai_agent_runs
              (session_id, user_id, agent_kind, trigger, status, created_at, started_at)
            VALUES
              (%s, %s, 'card_execution', 'user', 'succeeded', %s, %s),
              (%s, %s, 'card_execution', 'user', 'running', %s, %s)
            """,
            (
                f"card-thread-{card_id}",
                user_a,
                datetime(2026, 5, 18, 10, 2, tzinfo=UTC),
                datetime(2026, 5, 18, 10, 2, tzinfo=UTC),
                f"card-thread-{card_id}",
                user_a,
                datetime(2026, 5, 18, 10, 5, tzinfo=UTC),
                datetime(2026, 5, 18, 10, 5, tzinfo=UTC),
            ),
        )
    # Another user's newer run on a same-named thread must not leak in.
    async with user_scoped_tx(pool, user_b) as conn:
        await conn.execute(
            """
            INSERT INTO pai_agent_runs
              (session_id, user_id, agent_kind, trigger, status, created_at, started_at)
            VALUES (%s, %s, 'card_execution', 'user', 'failed', %s, %s)
            """,
            (
                f"card-thread-{card_id}",
                user_b,
                datetime(2026, 5, 18, 10, 9, tzinfo=UTC),
                datetime(2026, 5, 18, 10, 9, tzinfo=UTC),
            ),
        )

    client = await _client_for(pool, user_a)
    async with client:
        res = await client.get("/api/cards")

    assert res.status_code == 200, res.text
    by_id = {c["card"]["id"]: c for c in res.json()["cards"]}
    assert by_id[card_id]["runStatus"] == "running"
