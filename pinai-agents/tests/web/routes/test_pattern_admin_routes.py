"""Phase 4-6 — pattern edit, status flip, demo promotion, health, pending review."""

from __future__ import annotations

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


async def _client_for(pool, user_id: int):
    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_id)
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest.mark.asyncio
async def test_pattern_edit_roundtrip(pool, user_ids) -> None:
    """Reviewer can update a pattern's abstract / card_skeleton; refresh persists."""
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)
    async with client:
        post = await client.post(
            "/api/reward-dashboard/patterns/routine_anchor_detected",
            json={
                "abstract": "edited abstract for testing",
                "cardSkeleton": {"hook": "edited hook"},
            },
        )
        assert post.status_code == 200, post.text
        body = post.json()
        assert body["pattern"]["abstract"] == "edited abstract for testing"
        assert body["pattern"]["cardSkeleton"] == {"hook": "edited hook"}

        # GET reflects the edit
        get = await client.get(
            "/api/reward-dashboard/patterns/routine_anchor_detected",
        )
        assert get.json()["pattern"]["abstract"] == "edited abstract for testing"

        # Restore original to keep seed clean.
        await client.post(
            "/api/reward-dashboard/patterns/routine_anchor_detected",
            json={
                "abstract": "从历史信号中识别出用户稳定的日常节律,主动告知并询问是否要协助",
                "cardSkeleton": {
                    "hook": "把识别出的节律具体描述",
                    "why_now": "引用观察到的天数和稳定度",
                    "evidence": "gps history range",
                    "action": "提议加入提醒或确认节律",
                    "title_strategy": {
                        "avoid": "泛泛“我发现了”/“可能会喜欢”/只问“要不要”;必须带证据和动作",
                        "example": "明早暴雨会吃掉你 15 分钟｜8:15 叫你出门",
                        "formula": "具体事实/数字/时间 + 人性刺点 + 立刻动作",
                    },
                },
            },
        )


@pytest.mark.asyncio
async def test_pattern_status_flip(pool, user_ids) -> None:
    """active → retired → active round-trip."""
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)
    async with client:
        retire = await client.post(
            "/api/reward-dashboard/patterns/meal_pattern_inferred/status",
            json={"status": "retired"},
        )
        assert retire.status_code == 200
        assert retire.json()["pattern"]["status"] == "retired"
        assert retire.json()["pattern"]["retiredAt"] is not None

        revive = await client.post(
            "/api/reward-dashboard/patterns/meal_pattern_inferred/status",
            json={"status": "active"},
        )
        assert revive.status_code == 200
        assert revive.json()["pattern"]["status"] == "active"
        assert revive.json()["pattern"]["retiredAt"] is None


@pytest.mark.asyncio
async def test_pattern_pending_approve(pool, user_ids) -> None:
    """An AI-extracted pending pattern can be approved → status flips to active."""
    user_a, _ = user_ids
    pattern_id = "__test_pending_pattern__"
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_card_patterns
              (id, category, abstract, signals_required, trigger_dsl, intent,
               card_skeleton, specializations, surprise_init, practical_init,
               tier, status, source)
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s,
                    %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
            """,
            (
                pattern_id,
                "test",
                "ai-extracted candidate",
                "[]",
                "[]",
                "test_intent",
                "{}",
                "[]",
                "m",
                "m",
                "warmup",
                "pending_review",
                "ai_extracted",
            ),
        )
    client = await _client_for(pool, user_a)
    async with client:
        pending = await client.get("/api/reward-dashboard/patterns/pending")
        assert pending.status_code == 200
        ids = [p["id"] for p in pending.json()["items"]]
        assert pattern_id in ids

        approve = await client.post(
            f"/api/reward-dashboard/patterns/pending/{pattern_id}/approve",
        )
        assert approve.status_code == 200
        assert approve.json()["pattern"]["status"] == "active"

        # Cleanup
        await client.post(
            f"/api/reward-dashboard/patterns/{pattern_id}/status",
            json={"status": "retired"},
        )
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            "DELETE FROM pai_card_patterns WHERE id = %s",
            (pattern_id,),
        )


@pytest.mark.asyncio
async def test_pattern_pending_reject(pool, user_ids) -> None:
    user_a, _ = user_ids
    pattern_id = "__test_pending_reject__"
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            """
            INSERT INTO pai_card_patterns
              (id, category, abstract, signals_required, trigger_dsl, intent,
               card_skeleton, specializations, surprise_init, practical_init,
               tier, status, source)
            VALUES (%s, %s, %s, %s::jsonb, %s::jsonb, %s,
                    %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
            """,
            (
                pattern_id,
                "test",
                "reject test",
                "[]",
                "[]",
                "test_intent",
                "{}",
                "[]",
                "m",
                "m",
                "warmup",
                "pending_review",
                "ai_extracted",
            ),
        )
    client = await _client_for(pool, user_a)
    async with client:
        reject = await client.post(
            f"/api/reward-dashboard/patterns/pending/{pattern_id}/reject",
        )
        assert reject.status_code == 200
        verify = await client.get(f"/api/reward-dashboard/patterns/{pattern_id}")
        assert verify.status_code == 404


@pytest.mark.asyncio
async def test_pattern_demo_promotion_from_raw_card(pool, user_ids) -> None:
    """Reviewer can attach a raw card snapshot as a golden demo on an existing pattern."""
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)
    async with client:
        promote = await client.post(
            "/api/reward-dashboard/patterns/routine_anchor_detected/demos",
            json={
                "source": "golden",
                "scenario": "test promotion scenario",
                "card": {
                    "hook": "promoted card hook",
                    "body": "body content",
                    "action": "do something",
                },
                "wowLevel": 4,
            },
        )
        assert promote.status_code == 200, promote.text
        demo = promote.json()["demo"]
        assert demo["source"] == "golden"
        assert demo["card"]["hook"] == "promoted card hook"
        # Cleanup: drop just the inserted demo.
    async with user_scoped_tx(pool, user_a) as conn:
        await conn.execute(
            "DELETE FROM pai_card_pattern_demos WHERE id = %s",
            (demo["id"],),
        )


@pytest.mark.asyncio
async def test_patterns_health_endpoint(pool, user_ids) -> None:
    """Health snapshot returns one row per pattern with the metric shape, no error."""
    user_a, _ = user_ids
    client = await _client_for(pool, user_a)
    async with client:
        resp = await client.get("/api/reward-dashboard/patterns/health")
        assert resp.status_code == 200, resp.text
        items = resp.json()["items"]
        assert isinstance(items, list)
        # 111 seed patterns at minimum; tests may add more.
        assert len(items) >= 111
        any_routine = next((r for r in items if r["patternId"] == "routine_anchor_detected"), None)
        assert any_routine is not None
        assert "hitRate7d" in any_routine
        assert "shouldRetire" in any_routine
        assert isinstance(any_routine["retireReasons"], list)
