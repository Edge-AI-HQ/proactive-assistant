"""Tests for /api/reward-dashboard/patterns endpoints.

Assumes the seed (`scripts/seed_patterns.py`) has run against TEST_DATABASE_URL
so 111 patterns + 111 demos are present. The endpoints are read-only in
Phase 1, so we only assert listing / filtering / single-pattern shape.
"""

from __future__ import annotations

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user
from pinai_agents.web.auth.user_service import User


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


async def _client_for(pool, user_id: int):
    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_id)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_patterns_list_and_filters(pool, user_ids):
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)
    async with client:
        full = await client.get("/api/reward-dashboard/patterns?limit=500")
        assert full.status_code == 200
        body = full.json()
        assert body["ok"] is True
        assert body["total"] >= 111
        ids = {item["id"] for item in body["items"]}
        assert "routine_anchor_detected" in ids
        routine = next(item for item in body["items"] if item["id"] == "routine_anchor_detected")
        assert routine["humanInsight"]
        assert routine["demoTitle"]
        assert routine["demoSourceDataSummary"]
        assert isinstance(body["facets"]["categories"], list)
        assert "routine_observation" in body["facets"]["categories"]

        by_category = await client.get(
            "/api/reward-dashboard/patterns?category=routine_observation",
        )
        assert by_category.status_code == 200
        cat_items = by_category.json()["items"]
        assert cat_items
        assert all(p["category"] == "routine_observation" for p in cat_items)

        by_status = await client.get("/api/reward-dashboard/patterns?status=active")
        assert by_status.status_code == 200
        assert all(p["status"] == "active" for p in by_status.json()["items"])

        by_surprise = await client.get("/api/reward-dashboard/patterns?surprise=h")
        assert by_surprise.status_code == 200
        assert by_surprise.json()["items"]
        assert all(p["surpriseInit"] == "h" for p in by_surprise.json()["items"])

        by_tier = await client.get(
            "/api/reward-dashboard/patterns?tier=warmup",
        )
        assert by_tier.status_code == 200
        assert all(p["tier"] == "warmup" for p in by_tier.json()["items"])

        bad_status = await client.get("/api/reward-dashboard/patterns?status=garbage")
        assert bad_status.status_code == 422


@pytest.mark.asyncio
async def test_pattern_detail_and_demos(pool, user_ids):
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)
    async with client:
        resp = await client.get(
            "/api/reward-dashboard/patterns/routine_anchor_detected",
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        pattern = body["pattern"]
        assert pattern["id"] == "routine_anchor_detected"
        assert pattern["category"] == "routine_observation"
        assert pattern["status"] == "active"
        assert isinstance(pattern["triggerDsl"], list)
        assert pattern["cardSkeleton"]
        assert pattern["humanInsight"]
        assert "title_strategy" in pattern["cardSkeleton"]
        demos = body["demos"]
        assert isinstance(demos, list)
        assert demos
        first_demo = demos[0]
        assert first_demo["patternId"] == "routine_anchor_detected"
        assert first_demo["card"]
        assert first_demo["card"]["title"]
        assert first_demo["card"]["sourceData"]
        assert first_demo["redacted"] is True

        missing = await client.get("/api/reward-dashboard/patterns/__nope__")
        assert missing.status_code == 404
