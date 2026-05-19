from datetime import UTC, datetime
from typing import Any, cast

import pytest

from pinai_agents.web.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.scheduler.dispatcher import DefaultDispatcher


def test_generator_tasks_use_long_running_lease():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)

    assert dispatcher._lease_for("generator.manual") == 600
    assert dispatcher._lease_for("generator.auto") == 600


@pytest.mark.asyncio
async def test_dream_dispatch_persists_summary_and_output_counts(
    pool, user_ids, monkeypatch,
):
    user_a, _ = user_ids
    scheduled_for = datetime.now(UTC)

    async with user_scoped_tx(pool, user_a) as conn:
        task = await ScheduledTasksRepository(user_a, conn).upsert(
            id="dream.auto.test",
            kind="auto.dreaming",
            trigger_kind="schedule",
            cron_expr="0 6 * * *",
            next_run_at=None,
            payload={"trigger": "auto"},
            timezone="Asia/Shanghai",
        )
    task.last_run_at = scheduled_for

    async def fake_call_chat(self, path, task_arg, run_id, *, extra=None):
        assert path == "/agent/run/dream"
        async with service_tx(pool) as conn:
            await conn.execute(
                """
                INSERT INTO pai_memory
                  (user_id, id, text, source, source_run_id, subject)
                VALUES
                  (%s, 'mem_dream_one', 'Dream memory one', 'agent', %s, 'work'),
                  (%s, 'mem_dream_two', 'Dream memory two', 'agent', %s, 'life')
                """,
                (user_a, run_id, user_a, run_id),
            )
        return {
            "summary": (
                '{"memoriesWritten":2,"memoriesSuperseded":0,'
                '"profileFieldsUpdated":["facts"],'
                '"summary":"Wrote two useful memories."}'
            ),
        }

    monkeypatch.setattr(DefaultDispatcher, "_call_chat", fake_call_chat)

    dispatcher = DefaultDispatcher(pool=pool, lease_seconds=60, owner="test")
    await dispatcher.dispatch(task)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT id, status, context_summary, memories_written,
                   profile_updated, profile_changed_keys, refs_produced, details
            FROM pai_evolution_runs
            WHERE user_id = %s AND id LIKE 'dream.auto.test.%%'
            ORDER BY started_at DESC
            LIMIT 1
            """,
            (user_a,),
        )
        evol = await cur.fetchone()
        cur = await conn.execute(
            """
            SELECT status FROM pai_scheduled_task_runs
            WHERE user_id = %s AND task_id = 'dream.auto.test'
            ORDER BY fired_at DESC
            LIMIT 1
            """,
            (user_a,),
        )
        task_run = await cur.fetchone()

    assert evol is not None
    assert evol["status"] == "completed"
    assert evol["context_summary"] == "Wrote two useful memories."
    assert evol["memories_written"] == 2
    assert evol["profile_updated"] is True
    assert evol["profile_changed_keys"] == ["facts"]
    assert evol["refs_produced"]["pai_memory"] == [
        "mem_dream_one",
        "mem_dream_two",
    ]
    assert evol["details"]["outputSummary"]["memories_written"] == 2
    assert task_run is not None
    assert task_run["status"] == "success"
