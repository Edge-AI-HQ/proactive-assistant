from __future__ import annotations

import httpx
import pytest
from pinai_api.app import create_app
from pinai_api.domains.memory.curation.runs import EvolutionRepository
from pinai_api.platform.auth.deps import current_user
from pinai_api.platform.auth.user_service import User
from pinai_db.rls import user_scoped_tx


def _user(user_id: int) -> User:
    return User(
        id=user_id,
        supabase_user_id="00000000-0000-0000-0000-000000000001",
        email="ui-evolution@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.mark.asyncio
async def test_evolution_detail_surfaces_run_outputs(pool, user_ids):
    user_a, _ = user_ids
    run_id = "evolution-manual-test.outputs"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = EvolutionRepository(user_a, conn)
        await repo.create(
            trigger_kind="manual",
            context_summary="Evolution run starting",
            run_id=run_id,
        )
        # pai_memory is retired; produced ids now live under
        # refs_produced["pai_events"]. There's no per-event row hydration in
        # the UI route, so the journal's "What I noticed" section drops and
        # candidates degrade to bare produced-event refs.
        await repo.complete(
            run_id,
            context_summary="You kept returning to one important work thread.",
            profile_updated=True,
            profile_changed_keys=["facts.work"],
            refs_produced={"pai_events": ["evt_ui_one", "evt_ui_two"]},
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
        list_res = await client.get("/api/evolution/runs")
        detail_res = await client.get(f"/api/evolution/runs/{run_id}")

    assert list_res.status_code == 200, list_res.text
    run = next(r for r in list_res.json()["runs"] if r["id"] == run_id)
    assert run["summary"]["text"] == "You kept returning to one important work thread."

    assert detail_res.status_code == 200, detail_res.text
    detail = detail_res.json()["detail"]
    assert "## Evolution Journal" in detail["dreamMarkdown"]
    assert "personal assistant" in detail["dreamMarkdown"]
    # Memories detail degrades to empty (no pai_events row hydration), so the
    # journal renders from the run summary alone — the run-log style agentReport
    # summary is scrubbed and the "What I noticed" section is absent.
    assert "## What I noticed" not in detail["dreamMarkdown"]
    assert "112 signals" not in detail["dreamMarkdown"]
    assert "processed" not in detail["dreamMarkdown"].lower()
    assert detail["profileDelta"] == {
        "updated": True,
        "changedKeys": ["facts.work"],
    }
    assert detail["sourceBreakdown"][0]["itemCount"] == 112
    # Candidates surface produced-event refs (bare, no row hydration).
    assert [c["id"] for c in detail["candidates"]] == ["evt_ui_one", "evt_ui_two"]
    assert detail["candidates"][0]["type"] == "event"
