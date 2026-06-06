from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import AgentRun, current_agent_run, current_user
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.repositories.profile import ProfileRepository
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
    app.dependency_overrides[current_agent_run] = lambda: AgentRun(
        user_id=user_id,
        run_id="run_feedback_flow_agent_read",
        scope="test",
    )
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_feedback_flow_for_silicon_valley_ai_engineer(pool, user_ids) -> None:
    user_a, _ = user_ids
    cards = [
        {
            "id": "card_ai_pr_review",
            "intentKey": "work:ai-pr-review",
            "goalBasket": "work",
            "title": "Review the agent eval PR",
            "summary": "A concrete engineering task.",
            "whyNow": "The PR is waiting.",
            "primaryAction": {"label": "Review PR", "type": "confirm"},
            "sources": ["github pr_42"],
        },
        {
            "id": "card_vc_rumors",
            "intentKey": "tech:vc-rumors",
            "goalBasket": "tech",
            "title": "VC funding rumor roundup",
            "summary": "A high-level funding gossip card.",
            "whyNow": "Trending in newsletters.",
            "primaryAction": {"label": "Read rumors", "type": "confirm"},
            "sources": ["newsletter rum_1"],
        },
        {
            "id": "card_calendar_digest",
            "intentKey": "work:calendar-digest",
            "goalBasket": "work",
            "title": "Calendar digest",
            "summary": "A shallow daily agenda.",
            "whyNow": "Morning planning.",
            "primaryAction": {"label": "Open digest", "type": "confirm"},
            "sources": ["gcal evt_1"],
        },
    ]

    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_profile(
            display_name="Avery",
            locale="en-US",
            timezone="America/Los_Angeles",
            summary="Silicon Valley AI engineer building infra products.",
            facts={"role": "AI engineer", "location": "San Francisco Bay Area"},
            preferences={"content_depth": "technical, source-backed, low hype"},
        )
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
                "run_feedback_flow",
                "run_feedback_flow",
                json.dumps(cards),
                datetime(2026, 6, 2, 9, 0, tzinfo=UTC),
                datetime(2026, 6, 2, 9, 1, tzinfo=UTC),
            ),
        )

    client = await _client_for(pool, user_a)
    async with client:
        for body in [
            {
                "kind": "card_action",
                "action": "complete",
                "intentCardId": "card_ai_pr_review",
                "intentKey": "work:ai-pr-review",
                "basket": "work",
                "channel": "web",
            },
            {
                "kind": "dismiss",
                "intentCardId": "card_calendar_digest",
                "intentKey": "work:calendar-digest",
                "basket": "work",
                "channel": "web",
            },
            {
                "kind": "snooze",
                "intentCardId": "card_vc_rumors",
                "intentKey": "tech:vc-rumors",
                "basket": "tech",
                "channel": "web",
            },
            {
                "kind": "text_feedback",
                "intentCardId": "card_vc_rumors",
                "intentKey": "tech:vc-rumors",
                "basket": "tech",
                "text": "Stop showing me VC funding rumor cards; I want technical AI infra papers.",
                "metadata": {"surface": "card_thread_reply"},
                "channel": "card_thread",
            },
        ]:
            res = await client.post("/api/feedback", json=body)
            assert res.status_code == 200, res.text
            assert res.json()["received"] is True

        dismissed = await client.get("/api/feedback/dismissed")
        completed = await client.get("/api/feedback/completed")
        card_res = await client.get("/api/cards")
        agent_feedback = await client.get("/api/agent/feedback/list", params={"limit": 20})
        agent_preferences = await client.get("/api/agent/preferences/list")

    assert set(dismissed.json()["dismissedCardIds"]) == {
        "card_calendar_digest",
        "card_vc_rumors",
    }
    assert completed.json()["completedCardIds"] == ["card_ai_pr_review"]
    cards_by_id = {entry["card"]["id"]: entry for entry in card_res.json()["cards"]}
    assert cards_by_id["card_ai_pr_review"]["latestOutcome"] == "complete"
    assert cards_by_id["card_calendar_digest"]["latestOutcome"] == "dismiss"
    assert cards_by_id["card_vc_rumors"]["latestOutcome"] == "snooze"
    assert any(
        item["kind"] == "text_feedback"
        and item["text"]
        == "Stop showing me VC funding rumor cards; I want technical AI infra papers."
        for item in agent_feedback.json()["items"]
    )
    assert [item["statement"] for item in agent_preferences.json()["items"]] == [
        "Stop showing me VC funding rumor cards; I want technical AI infra papers."
    ]

    async with user_scoped_tx(pool, user_a) as conn:
        cur = await conn.execute(
            """
            SELECT statement, polarity, source, evidence
            FROM pai_preference_records
            WHERE user_id = %s AND status = 'active'
            """,
            (user_a,),
        )
        pref = await cur.fetchone()
        cur = await conn.execute(
            """
            SELECT intent, basket, ctr_7d, last_open_at, last_dismiss_at
            FROM pai_user_intent_pref
            WHERE user_id = %s
            ORDER BY intent
            """,
            (user_a,),
        )
        fingerprint_rows = await cur.fetchall()

    assert pref["statement"] == (
        "Stop showing me VC funding rumor cards; I want technical AI infra papers."
    )
    assert pref["polarity"] == "negative"
    assert pref["source"] == "user"
    assert pref["evidence"]["card_id"] == "card_vc_rumors"
    assert pref["evidence"]["surface"] == "card_thread_reply"

    fp_by_intent = {r["intent"]: r for r in fingerprint_rows}
    assert fp_by_intent["work:ai-pr-review"]["ctr_7d"] == 1.0
    assert fp_by_intent["work:ai-pr-review"]["last_open_at"] is not None
    assert fp_by_intent["work:calendar-digest"]["ctr_7d"] == 0.0
    assert fp_by_intent["work:calendar-digest"]["last_dismiss_at"] is not None
    assert fp_by_intent["tech:vc-rumors"]["ctr_7d"] == 0.0
    assert fp_by_intent["tech:vc-rumors"]["last_dismiss_at"] is not None
