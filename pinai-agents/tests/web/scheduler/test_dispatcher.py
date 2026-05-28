from datetime import UTC, datetime
from typing import Any, cast

import pytest

from pinai_agents.web.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.scheduler.dispatcher import DefaultDispatcher, _dream_result_fields


def test_generator_tasks_use_long_running_lease():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)

    assert dispatcher._lease_for("generator.manual") == 1800
    assert dispatcher._lease_for("generator.auto") == 1800
    assert dispatcher._lease_for("auto.dreaming") == 600


def test_dream_result_fields_extracts_fenced_json_from_text_block_string():
    fields = _dream_result_fields({
        "summary": (
            "[{'type': 'text', 'text': '```json\\n"
            '{"memoriesWritten":1,"memoriesSuperseded":0,'
            '"profileFieldsUpdated":["facts"],'
            '"summary":"Daily context covered."}'
            "\\n```'}]"
        ),
    })

    assert fields["context_summary"] == "Daily context covered."
    assert fields["profile_updated"] is True
    assert fields["profile_changed_keys"] == ["facts"]


@pytest.mark.asyncio
async def test_recurring_success_clears_previous_failure_state(
    pool, user_ids, monkeypatch,
):
    user_a, _ = user_ids
    scheduled_for = datetime.now(UTC)

    async with user_scoped_tx(pool, user_a) as conn:
        task = await ScheduledTasksRepository(user_a, conn).upsert(
            id="gen.auto.test",
            kind="generator.auto",
            trigger_kind="schedule",
            interval_seconds=720 * 60,
            next_run_at=None,
            payload={"trigger": "auto"},
        )
        await conn.execute(
            """
            UPDATE pai_scheduled_tasks
            SET attempts = 2,
                last_error = 'old validation error',
                last_run_status = 'failed'
            WHERE user_id = %s AND id = %s
            """,
            (user_a, task.id),
        )
    task.last_run_at = scheduled_for

    async def fake_handle_kind(self, task_arg, run_id):
        assert task_arg.id == task.id
        assert run_id.startswith(f"{task.id}.")

    monkeypatch.setattr(DefaultDispatcher, "_handle_kind", fake_handle_kind)

    dispatcher = DefaultDispatcher(pool=pool, lease_seconds=60, owner="test")
    await dispatcher.dispatch(task)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT status, attempts, last_error, last_run_status
            FROM pai_scheduled_tasks
            WHERE user_id = %s AND id = %s
            """,
            (user_a, task.id),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["status"] == "active"
    assert row["attempts"] == 0
    assert row["last_error"] is None
    assert row["last_run_status"] == "success"


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
