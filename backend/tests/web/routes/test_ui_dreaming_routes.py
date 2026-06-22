from __future__ import annotations

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.domains.user_model.evolution import EvolutionRepository
from pinai_api.platform.auth.deps import current_user
from pinai_api.platform.auth.user_service import User
from pinai_db.rls import user_scoped_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id="00000000-0000-0000-0000-000000000001",
        email="ui-dreaming@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.mark.asyncio
async def test_dreaming_detail_surfaces_run_outputs(pool, user_ids):
    user_a, _ = user_ids
    run_id = "dream-manual-test.outputs"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EvolutionRepository(user_a, conn)
        await repo.create(
            trigger_kind="manual",
            context_summary="Dream run starting",
            run_id=run_id,
        )
        await conn.execute(
            """
            INSERT INTO pai_memory
              (user_id, id, text, source, source_run_id, subject)
            VALUES
              (%s, 'mem_dream_ui_one', 'Useful dream output', 'agent', %s, 'work')
            """,
            (user_a, run_id),
        )
        await repo.complete(
            run_id,
            context_summary="You kept returning to one important work thread.",
            memories_written=1,
            profile_updated=True,
            profile_changed_keys=["facts.work"],
            refs_produced={"pai_memory": ["mem_dream_ui_one"]},
            details={
                "agentReport": {
                    "summary": (
                        "24h window: 112 signals and 8 raw rows processed. Profile facts refreshed."
                    ),
                    "totalSignals": 112,
                    "totalRawRows": 8,
                },
            },
        )

    app = create_app()
    app.state.pool = pool
    app.dependency_overrides[current_user] = lambda: _user(user_a)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        list_res = await client.get("/api/dreaming/runs")
        detail_res = await client.get(f"/api/dreaming/runs/{run_id}")

    assert list_res.status_code == 200, list_res.text
    run = next(r for r in list_res.json()["runs"] if r["id"] == run_id)
    assert run["summary"]["text"] == "You kept returning to one important work thread."

    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()["detail"]
    assert "## Dream Journal" in detail["dreamMarkdown"]
    assert "personal assistant" in detail["dreamMarkdown"]
    assert "## What I noticed" in detail["dreamMarkdown"]
    assert "Useful dream output" in detail["dreamMarkdown"]
    assert "Work thread" in detail["dreamMarkdown"]
    assert "112 signals" not in detail["dreamMarkdown"]
    assert "memory**" not in detail["dreamMarkdown"]
    assert "Memories written" not in detail["dreamMarkdown"]
    assert "processed" not in detail["dreamMarkdown"].lower()
    assert detail["profileDelta"] == {
        "updated": True,
        "changedKeys": ["facts.work"],
    }
    assert detail["sourceBreakdown"][0]["itemCount"] == 112
    assert detail["candidates"][0]["id"] == "mem_dream_ui_one"
    assert detail["candidates"][0]["reason"] == "Useful dream output"
