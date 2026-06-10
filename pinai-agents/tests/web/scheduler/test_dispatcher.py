from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest

from pinai_agents.web.db.repositories.profile import ProfileRepository
from pinai_agents.web.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.scheduler.dispatcher import (
    _AGENT_RUN_KIND,
    DefaultDispatcher,
    _dream_result_fields,
    _generation_context_since,
)


def test_generator_tasks_use_ten_minute_lease():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)

    assert dispatcher._lease_for("generator.manual") == 600
    assert dispatcher._lease_for("generator.auto") == 600
    assert dispatcher._lease_for("generator.scheduled") == 600
    assert dispatcher._lease_for("auto.dreaming") == 600


def test_reminder_card_uses_default_lease():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)
    assert dispatcher._lease_for("reminder.card") == 60


def test_scheduled_generator_maps_to_existing_generator_agent_kind():
    assert _AGENT_RUN_KIND["generator.scheduled"] == "generator"


def test_generation_context_since_covers_24h_or_last_success_cycle():
    now = datetime(2026, 6, 4, 12, 0, tzinfo=UTC)

    assert _generation_context_since(now=now, last_success_at=None) == now - timedelta(hours=24)
    assert _generation_context_since(
        now=now,
        last_success_at=now - timedelta(hours=6),
    ) == now - timedelta(hours=24)
    assert _generation_context_since(
        now=now,
        last_success_at=now - timedelta(hours=30),
    ) == now - timedelta(hours=30)


def test_dream_result_fields_extracts_fenced_json_from_text_block_string():
    fields = _dream_result_fields(
        {
            "summary": (
                "[{'type': 'text', 'text': '```json\\n"
                '{"memoriesWritten":1,"memoriesSuperseded":0,'
                '"profileFieldsUpdated":["facts"],'
                '"summary":"Daily context covered."}'
                "\\n```'}]"
            ),
        }
    )

    assert fields["context_summary"] == "Daily context covered."
    assert fields["profile_updated"] is True
    assert fields["profile_changed_keys"] == ["facts"]


@pytest.mark.asyncio
async def test_recurring_success_clears_previous_failure_state(
    pool,
    user_ids,
    monkeypatch,
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
    pool,
    user_ids,
    monkeypatch,
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


@pytest.mark.asyncio
async def test_reminder_card_dispatch_writes_card_and_notifies(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    pushed: list[dict] = []

    async def fake_notify(pool_, *, user_id, title, message, task_id):
        pushed.append({"user_id": user_id, "title": title, "message": message, "task_id": task_id})
        return 1

    from pinai_agents.web.services import push_notifier

    monkeypatch.setattr(push_notifier, "notify_reminder", fake_notify)

    async with user_scoped_tx(pool, user_a) as conn:
        task = await ScheduledTasksRepository(user_a, conn).upsert(
            id="sched.once.remtest",
            kind="reminder.card",
            trigger_kind="once",
            next_run_at=datetime.now(UTC) + timedelta(hours=1),  # 不可被真容器认领
            timezone="Asia/Shanghai",
            payload={
                "reminder": {"title": "喝水", "message": "该喝水了"},
                "schedule_label": "一次 · 06-09 18:05",
                "trigger": "reminder",
            },
        )
    task.last_run_at = datetime.now(UTC)

    dispatcher = DefaultDispatcher(pool=pool, lease_seconds=60, owner="test")
    await dispatcher.dispatch(task)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            """
            SELECT trigger, final_cards FROM pai_pipeline_runs
            WHERE user_id = %s AND id LIKE 'sched.once.remtest.%%'
            """,
            (user_a,),
        )
        run = await cur.fetchone()
        cur = await conn.execute(
            "SELECT status FROM pai_scheduled_task_runs "
            "WHERE user_id = %s AND task_id = 'sched.once.remtest'",
            (user_a,),
        )
        task_run = await cur.fetchone()

    assert run is not None and run["trigger"] == "reminder"
    card = run["final_cards"][0]
    assert card["title"] == "喝水"
    assert card["sourceKind"] == "scheduled" and card["sourceLabel"] == "喝水"
    assert task_run is not None and task_run["status"] == "success"
    assert pushed == [
        {"user_id": user_a, "title": "喝水", "message": "该喝水了", "task_id": "sched.once.remtest"}
    ]


@pytest.mark.asyncio
async def test_proactive_tick_archives_and_skips_when_disabled(
    pool,
    user_ids,
    monkeypatch,
):
    """proactive_enabled=false ⇒ the tick must NOT emit a heartbeat and must
    self-heal by archiving the still-active task. This is the runtime gate that
    stops a stale 'active' proactive.tick (flag flipped in DB / legacy row) from
    emitting heartbeats forever and growing an unbounded checkpoint."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_settings(proactive_enabled=False)
        task = await ScheduledTasksRepository(user_a, conn).upsert(
            id="proactive.tick",
            kind="proactive.tick",
            trigger_kind="schedule",
            interval_seconds=30,
            # 未来时刻:本地真容器的 scheduler 不会认领这行(历史 flaky 根因
            # 是测试与 make up 栈共库,到期行被真 dispatcher 抢跑、重复计数)
            next_run_at=datetime.now(UTC) + timedelta(hours=1),
            status="active",
        )
    task.last_run_at = datetime.now(UTC)

    async def boom(*args, **kwargs):
        raise AssertionError("build_heartbeat_message must not run when disabled")

    monkeypatch.setattr(
        "pinai_agents.web.services.proactive_window.build_heartbeat_message",
        boom,
    )

    dispatcher = DefaultDispatcher(pool=pool, lease_seconds=60, owner="test")
    await dispatcher.dispatch(task)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status, next_run_at FROM pai_scheduled_tasks "
            "WHERE user_id=%s AND id='proactive.tick'",
            (user_a,),
        )
        row = await cur.fetchone()
        cur = await conn.execute(
            "SELECT count(*) AS n FROM pai_agent_messages WHERE user_id=%s AND source='heartbeat'",
            (user_a,),
        )
        msgs = await cur.fetchone()

    assert row is not None
    assert row["status"] == "archived"
    assert row["next_run_at"] is None
    assert msgs is not None
    assert msgs["n"] == 0


@pytest.mark.asyncio
async def test_proactive_tick_enqueues_when_enabled(
    pool,
    user_ids,
    monkeypatch,
):
    """proactive_enabled=true ⇒ the gate lets the tick through: a heartbeat is
    enqueued onto the mailbox and the task stays active."""
    from pinai_agents.web.services.proactive_window import HeartbeatWindow

    user_a, _ = user_ids
    now = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_settings(proactive_enabled=True)
        task = await ScheduledTasksRepository(user_a, conn).upsert(
            id="proactive.tick",
            kind="proactive.tick",
            trigger_kind="schedule",
            interval_seconds=300,
            next_run_at=now + timedelta(hours=1),  # 不可被真容器认领,见上一测试注释
            status="active",
        )
    task.last_run_at = now

    async def fake_window(*args, **kwargs):
        return HeartbeatWindow(
            text="[heartbeat] test",
            window_start=now,
            window_end=now,
            event_count=0,
            advance_to=now,
        )

    notified: list[str] = []

    async def fake_notify(_pool, session_id):
        notified.append(session_id)

    monkeypatch.setattr(
        "pinai_agents.web.services.proactive_window.build_heartbeat_message",
        fake_window,
    )
    monkeypatch.setattr(
        "pinai_agents.web.agent_core.bus.notify_message",
        fake_notify,
    )

    dispatcher = DefaultDispatcher(pool=pool, lease_seconds=60, owner="test")
    await dispatcher.dispatch(task)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status FROM pai_scheduled_tasks WHERE user_id=%s AND id='proactive.tick'",
            (user_a,),
        )
        row = await cur.fetchone()
        cur = await conn.execute(
            "SELECT count(*) AS n FROM pai_agent_messages "
            "WHERE user_id=%s AND session_id=%s AND source='heartbeat'",
            (user_a, f"proactive-{user_a}"),
        )
        msgs = await cur.fetchone()

    assert row is not None
    assert row["status"] == "active"
    assert msgs is not None
    assert msgs["n"] == 1
    assert notified == [f"proactive-{user_a}"]
