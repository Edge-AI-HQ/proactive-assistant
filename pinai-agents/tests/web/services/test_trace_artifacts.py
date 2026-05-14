from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from pinai_agents import config
from pinai_agents.web.db.repositories.reward import RewardRepository
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.services import trace_artifacts
from pinai_agents.web.services.trace_artifacts import TraceArtifactService


async def _insert_run(conn, user_id: int, run_id: str) -> None:
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
            json.dumps([
                {
                    "id": f"{run_id}_card_00",
                    "intentKey": "work:trace",
                    "goalBasket": "work",
                    "title": "Trace this card",
                    "summary": "Trace summary",
                    "whyNow": "Trace now",
                    "sources": ["signal id=sig_trace"],
                },
            ]),
            datetime(2026, 5, 13, 10, 0, tzinfo=UTC),
            datetime(2026, 5, 13, 10, 1, tzinfo=UTC),
        ),
    )


@pytest.mark.asyncio
async def test_trace_artifact_missing_without_langsmith_key(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.delenv("LANGCHAIN_API_KEY", raising=False)
    config.get_web_settings.cache_clear()
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            await _insert_run(conn, user_a, "run_trace_missing")
            repo = RewardRepository(user_a, conn)
            artifact = await TraceArtifactService(repo).get_or_generate("run_trace_missing")
    finally:
        config.get_web_settings.cache_clear()

    assert artifact["status"] == "missing"
    assert "LANGSMITH_API_KEY" in artifact["error"]


class _FakeLangSmithClient:
    def list_runs(self, **kwargs):
        if kwargs.get("is_root"):
            return [
                SimpleNamespace(
                    id="root-run",
                    trace_id="trace-1",
                    parent_run_id=None,
                    name="generator orchestrator",
                    run_type="chain",
                    start_time=datetime(2026, 5, 13, 10, 0, tzinfo=UTC),
                    end_time=datetime(2026, 5, 13, 10, 1, tzinfo=UTC),
                    error=None,
                    inputs={"run": "input"},
                outputs={"run": "output"},
                extra={"metadata": {"pinai_run_id": "run_trace_ready"}},
                url="https://smith.langchain.com/o/org/projects/p/project/r/root-run",
            ),
            ]
        return [
            SimpleNamespace(
                id="data-run",
                trace_id="trace-1",
                parent_run_id="root-run",
                name="task",
                run_type="tool",
                start_time=datetime(2026, 5, 13, 10, 0, tzinfo=UTC),
                end_time=datetime(2026, 5, 13, 10, 0, 10, tzinfo=UTC),
                error=None,
                inputs={"subagent_type": "data-collector"},
                outputs={"output": "phase1 written: profile=ok, memory=2 rows, signals=1 open"},
                extra={},
                url=None,
            ),
            SimpleNamespace(
                id="planner-run",
                trace_id="trace-1",
                parent_run_id="root-run",
                name="task",
                run_type="tool",
                start_time=datetime(2026, 5, 13, 10, 0, 12, tzinfo=UTC),
                end_time=datetime(2026, 5, 13, 10, 0, 20, tzinfo=UTC),
                error=None,
                inputs={"subagent_type": "planner"},
                outputs={"output": '{"plan": [], "skipped_duplicates": ["old intent"]}'},
                extra={},
                url=None,
            ),
            SimpleNamespace(
                id="eval-run",
                trace_id="trace-1",
                parent_run_id="root-run",
                name="evaluator",
                run_type="chain",
                start_time=datetime(2026, 5, 13, 10, 0, 30, tzinfo=UTC),
                end_time=datetime(2026, 5, 13, 10, 0, 40, tzinfo=UTC),
                error=None,
                inputs={},
                outputs={},
                extra={},
                url=None,
            ),
        ]


@pytest.mark.asyncio
async def test_trace_artifact_ready_from_langsmith_runs(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    monkeypatch.setattr(trace_artifacts, "_client", lambda: _FakeLangSmithClient())
    async with user_scoped_tx(pool, user_a) as conn:
        await _insert_run(conn, user_a, "run_trace_ready")
        repo = RewardRepository(user_a, conn)
        artifact = await TraceArtifactService(repo).get_or_generate("run_trace_ready")

    assert artifact["status"] == "ready"
    assert artifact["langsmithTraceId"] == "trace-1"
    assert artifact["summary"]["stages"]["data-collector"]["seen"] is True
    assert artifact["summary"]["stages"]["planner"]["seen"] is True
    assert artifact["summary"]["stages"]["evaluator"]["seen"] is True
    assert artifact["summary"]["dataSources"] == ["memory", "profile", "signals"]
    assert artifact["summary"]["skippedIntents"]
    assert artifact["langsmithUrl"] == "https://smith.langchain.com/o/org/projects/p/project/r/root-run"
    assert artifact["traceTree"]["langsmithUrl"] == artifact["langsmithUrl"]
    assert "<svg" in artifact["traceTree"]["svg"]


@pytest.mark.asyncio
async def test_trace_artifact_resolves_scheduler_task_id_to_fire_run(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    monkeypatch.setattr(trace_artifacts, "_client", lambda: _FakeLangSmithClient())
    async with user_scoped_tx(pool, user_a) as conn:
        await _insert_run(conn, user_a, "gen.trace_task.abc123ef")
        repo = RewardRepository(user_a, conn)
        artifact = await TraceArtifactService(repo).get_or_generate("gen.trace_task")

    assert artifact["status"] == "ready"
    assert artifact["runId"] == "gen.trace_task.abc123ef"
    assert artifact["imagePath"] == "inline-svg:gen.trace_task.abc123ef"
