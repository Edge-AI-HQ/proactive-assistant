from __future__ import annotations

import json
from datetime import UTC, datetime

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.routes.ui.reward_dashboard import (
    CASEBOOK_OFFSET_MAX,
    REWARD_TEXT_FILTER_MAX_LENGTH,
)


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


def _cards(prefix: str) -> list[dict]:
    return [
        {
            "id": f"{prefix}_card_00",
            "intentKey": "work:route",
            "goalBasket": "work",
            "title": "Route the review",
            "summary": "Review and send the draft.",
            "whyNow": "Review is due today.",
            "sources": ["signal id=sig_route"],
        },
    ]


async def _insert_run(conn, user_id: int, run_id: str) -> str:
    cards = _cards(run_id)
    await conn.execute(
        """
        INSERT INTO pai_pipeline_runs
          (user_id, id, run_id, status, total_iterations, final_cards, trigger,
           started_at, completed_at)
        VALUES (%s, %s, %s, 'completed', 1, %s::jsonb, 'manual', %s, %s)
        """,
        (
            user_id,
            run_id,
            run_id,
            json.dumps(cards),
            datetime(2026, 5, 13, 9, 0, tzinfo=UTC),
            datetime(2026, 5, 13, 9, 1, tzinfo=UTC),
        ),
    )
    await conn.execute(
        """
        INSERT INTO pai_card_evaluations
          (user_id, card_id, run_id, intent_key, basket, overall, pass,
           evaluator, feedback_text, evaluated_at)
        VALUES (%s, %s, %s, 'work:route', 'work', 7, true, 'self', 'good', %s)
        """,
        (user_id, cards[0]["id"], run_id, datetime(2026, 5, 13, 9, 2, tzinfo=UTC)),
    )
    return cards[0]["id"]


async def _client_for(pool, user_id: int):
    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_id)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_reward_dashboard_routes_roundtrip(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        card_id = await _insert_run(conn, user_a, "run_route_reward")

    client = await _client_for(pool, user_a)
    async with client:
        runs_resp = await client.get("/api/reward-dashboard/runs")
        assert runs_resp.status_code == 200
        runs = runs_resp.json()["runs"]
        assert [r["runId"] for r in runs] == ["run_route_reward"]

        trimmed_trigger_resp = await client.get("/api/reward-dashboard/runs?trigger=%20manual%20")
        assert trimmed_trigger_resp.status_code == 200
        assert [r["runId"] for r in trimmed_trigger_resp.json()["runs"]] == ["run_route_reward"]

        oversized_trigger_resp = await client.get(
            f"/api/reward-dashboard/runs?trigger={'x' * (REWARD_TEXT_FILTER_MAX_LENGTH + 1)}",
        )
        assert oversized_trigger_resp.status_code == 422
        assert oversized_trigger_resp.json()["detail"] == (
            f"trigger must be at most {REWARD_TEXT_FILTER_MAX_LENGTH} characters"
        )

        dead_runs_resp = await client.get("/api/reward-dashboard/runs?quality=dead")
        assert dead_runs_resp.status_code == 200
        assert [r["runId"] for r in dead_runs_resp.json()["runs"]] == ["run_route_reward"]

        score_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"score": 9, "reason": "clear and timely"},
        )
        assert score_resp.status_code == 200
        assert score_resp.json()["event"]["source"] == "reviewer"

        reviewer_aha_resp = await client.get("/api/reward-dashboard/runs?quality=reviewer_aha")
        assert reviewer_aha_resp.status_code == 200
        assert [r["runId"] for r in reviewer_aha_resp.json()["runs"]] == ["run_route_reward"]

        zero_score_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"score": 0},
        )
        assert zero_score_resp.status_code == 422

        missing_score_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={},
        )
        assert missing_score_resp.status_code == 422

        null_score_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"score": None},
        )
        assert null_score_resp.status_code == 422

        bool_score_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"score": True},
        )
        assert bool_score_resp.status_code == 422
        assert bool_score_resp.json()["detail"] == "score must be a number"

        invalid_event_type_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"eventType": ["reviewer_score"], "score": 8},
        )
        assert invalid_event_type_resp.status_code == 422
        assert invalid_event_type_resp.json()["detail"] == "invalid score event"

        invalid_source_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"source": ["reviewer"], "score": 8},
        )
        assert invalid_source_resp.status_code == 422
        assert invalid_source_resp.json()["detail"] == "invalid score source"

        unsupported_event_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"eventType": "imported_feedback", "source": "system"},
        )
        assert unsupported_event_resp.status_code == 422
        assert unsupported_event_resp.json()["detail"] == "invalid score event"

        open_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"eventType": "card_open", "source": "user"},
        )
        assert open_resp.status_code == 200
        assert open_resp.json()["event"]["score"] == 1.0

        blank_run_id_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"score": 8, "runId": "   "},
        )
        assert blank_run_id_resp.status_code == 200
        assert blank_run_id_resp.json()["event"]["runId"] == "run_route_reward"

        invalid_run_id_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/score",
            json={"score": 8, "runId": ["run_route_reward"]},
        )
        assert invalid_run_id_resp.status_code == 422
        assert invalid_run_id_resp.json()["detail"] == "run_id must be a string"

        case_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/casebook",
            json={"label": "great", "reviewerNote": "good few-shot"},
        )
        assert case_resp.status_code == 200
        assert case_resp.json()["casebook"]["snapshot"]["card"]["id"] == card_id

        blank_primary_note_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/casebook",
            json={"label": "great", "reviewerNote": "", "note": "fallback note"},
        )
        assert blank_primary_note_resp.status_code == 200
        assert blank_primary_note_resp.json()["casebook"]["reviewerNote"] is None

        invalid_primary_note_resp = await client.post(
            f"/api/reward-dashboard/cards/{card_id}/casebook",
            json={"label": "great", "reviewerNote": 123, "note": "fallback note"},
        )
        assert invalid_primary_note_resp.status_code == 422
        assert invalid_primary_note_resp.json()["detail"] == "reviewerNote must be a string"

        case_list_resp = await client.get("/api/reward-dashboard/casebook")
        assert case_list_resp.status_code == 200
        case_list = case_list_resp.json()
        assert len(case_list["items"]) == 1
        assert case_list["total"] == 1

        trimmed_casebook_filters_resp = await client.get(
            "/api/reward-dashboard/casebook?basket=%20work%20&intent=%20route%20",
        )
        assert trimmed_casebook_filters_resp.status_code == 200
        assert trimmed_casebook_filters_resp.json()["total"] == 1

        oversized_intent_resp = await client.get(
            f"/api/reward-dashboard/casebook?intent={'x' * (REWARD_TEXT_FILTER_MAX_LENGTH + 1)}",
        )
        assert oversized_intent_resp.status_code == 422
        assert oversized_intent_resp.json()["detail"] == (
            f"intent must be at most {REWARD_TEXT_FILTER_MAX_LENGTH} characters"
        )

        oversized_casebook_offset_resp = await client.get(
            f"/api/reward-dashboard/casebook?offset={CASEBOOK_OFFSET_MAX + 1}",
        )
        assert oversized_casebook_offset_resp.status_code == 422

        invalid_trace_force_resp = await client.post(
            "/api/reward-dashboard/runs/run_route_reward/trace",
            json={"force": "yes"},
        )
        assert invalid_trace_force_resp.status_code == 422
        assert invalid_trace_force_resp.json()["detail"] == "force must be a boolean"


@pytest.mark.asyncio
async def test_reward_dashboard_rejects_cross_user_card(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_b) as conn:
        other_card_id = await _insert_run(conn, user_b, "run_route_other")

    client = await _client_for(pool, user_a)
    async with client:
        run_resp = await client.get("/api/reward-dashboard/runs/run_route_other")
        assert run_resp.status_code == 404

        score_resp = await client.post(
            f"/api/reward-dashboard/cards/{other_card_id}/score",
            json={"score": 7},
        )
        assert score_resp.status_code == 404

        casebook_resp = await client.post(
            f"/api/reward-dashboard/cards/{other_card_id}/casebook",
            json={"label": "great", "reviewerNote": "not mine"},
        )
        assert casebook_resp.status_code == 404

        detail_resp = await client.get(f"/api/reward-dashboard/cards/{other_card_id}")
        assert detail_resp.status_code == 404

        trace_get_resp = await client.get("/api/reward-dashboard/runs/run_route_other/trace")
        assert trace_get_resp.status_code == 404

        trace_build_resp = await client.post(
            "/api/reward-dashboard/runs/run_route_other/trace",
            json={"force": True},
        )
        assert trace_build_resp.status_code == 404
