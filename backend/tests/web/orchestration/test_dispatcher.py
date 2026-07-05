from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pytest
from pinai_api.config import WebSettings
from pinai_api.orchestration.dispatcher import (
    _AGENT_RUN_KIND,
    DefaultDispatcher,
    _dream_result_fields,
)
from pinai_api.platform.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_db.rls import service_tx, user_scoped_tx


def test_generator_tasks_lease_covers_generate_budget():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)

    # generator lease = generate_timeout_seconds + 120s buffer(默认 600+120),
    # 跟随 env GENERATE_TIMEOUT_SECONDS 同步放大,防长跑 run 被 tick 回收。
    expected = int(WebSettings().generate_timeout_seconds) + 120
    assert dispatcher._lease_for("generator.manual") == expected
    assert dispatcher._lease_for("generator.auto") == expected
    assert dispatcher._lease_for("generator.scheduled") == expected
    # These are not generator kinds, but can run past the default 60s lease.
    assert dispatcher._lease_for("auto.dreaming") == 600
    assert dispatcher._lease_for("connector.preview") == 600


def test_reminder_card_uses_default_lease():
    dispatcher = DefaultDispatcher(pool=cast(Any, None), lease_seconds=60)
    assert dispatcher._lease_for("reminder.card") == 60


def test_scheduled_generator_maps_to_existing_generator_agent_kind():
    assert _AGENT_RUN_KIND["generator.scheduled"] == "generator"


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
        # Skills are the only run-attributable output summarize_outputs still
        # aggregates (memory/signals reads were retired — that audit dimension
        # is now an events-based gap). Write two skills tagged with this run.
        async with service_tx(pool) as conn:
            await conn.execute(
                """
                INSERT INTO pai_skill_index
                  (user_id, id, title, status, body_hash, source, created_run_id,
                   last_updated_run_id)
                VALUES
                  (%s, 'skill_dream_one', 'Dream skill one', 'enabled', 'h1',
                   'agent', %s, %s),
                  (%s, 'skill_dream_two', 'Dream skill two', 'enabled', 'h2',
                   'agent', %s, %s)
                """,
                (user_a, run_id, run_id, user_a, run_id, run_id),
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
            SELECT id, status, context_summary, skills_added,
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
    # context_summary + profile fields still flow from the agent report,
    # independent of summarize_outputs' SQL aggregation.
    assert evol["context_summary"] == "Wrote two useful memories."
    assert evol["profile_updated"] is True
    assert evol["profile_changed_keys"] == ["facts"]
    # summarize_outputs now audits only skills (the run-attributable output).
    assert evol["skills_added"] == 2
    assert sorted(evol["refs_produced"]["pai_skill_index"]) == [
        "skill_dream_one",
        "skill_dream_two",
    ]
    assert evol["details"]["outputSummary"]["skills_added"] == 2
    assert task_run is not None
    assert task_run["status"] == "success"


@pytest.mark.asyncio
async def test_reminder_card_dispatch_writes_card_and_notifies(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    pushed: list[dict] = []

    async def fake_notify(pool_, *, user_id, title, message, task_id):
        pushed.append({"user_id": user_id, "title": title, "message": message, "task_id": task_id})
        return 1

    from pinai_api.platform import notification

    monkeypatch.setattr(notification, "notify_reminder", fake_notify)

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
    # Explicit type + owning-task ref: the FE switches the drawer on cardKind
    # (no Approve for reminders) and the chat agent edits the schedule via
    # scheduleTaskId — both stamped at birth, never inferred.
    assert card["cardKind"] == "reminder"
    assert card["scheduleTaskId"] == "sched.once.remtest"
    assert task_run is not None and task_run["status"] == "success"
    assert pushed == [
        {"user_id": user_a, "title": "喝水", "message": "该喝水了", "task_id": "sched.once.remtest"}
    ]


@pytest.mark.asyncio
async def test_generator_scheduled_final_failure_fires_fallback_reminder(
    pool, user_ids, monkeypatch
):
    """Event-briefing once task: when the generator burns its LAST retry the
    dispatcher degrades to the payload's fallback_reminder (zero-LLM card +
    ungated push) — and does NOT fire it while retries remain."""
    user_a, _ = user_ids
    pushed: list[dict] = []

    async def fake_notify(pool_, *, user_id, title, message, task_id):
        pushed.append({"user_id": user_id, "title": title, "task_id": task_id})
        return 1

    from pinai_api.platform import notification

    monkeypatch.setattr(notification, "notify_reminder", fake_notify)

    async def boom(self, task, run_id):
        msg = "generator exploded"
        raise RuntimeError(msg)

    monkeypatch.setattr(DefaultDispatcher, "_handle_kind", boom)

    payload = {
        "confirmed_brief": {"title": "会前 briefing", "topic": "明天 15:00 的会议"},
        "fallback_reminder": {"title": "开会提醒", "message": "明天 3 点开会"},
        "schedule_label": "一次 · 06-12 14:30",
        "trigger": "scheduled",
    }
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ScheduledTasksRepository(user_a, conn)
        fresh = await repo.upsert(
            id="sched.once.brief.fresh",
            kind="generator.scheduled",
            trigger_kind="once",
            next_run_at=datetime.now(UTC) + timedelta(hours=1),
            timezone="Asia/Shanghai",
            payload=payload,
        )
        final = await repo.upsert(
            id="sched.once.brief.final",
            kind="generator.scheduled",
            trigger_kind="once",
            next_run_at=datetime.now(UTC) + timedelta(hours=1),
            timezone="Asia/Shanghai",
            payload=payload,
        )
        # `final` is one failure away from archiving (the decision is
        # SQL-side on the row's attempts/max_attempts).
        await conn.execute(
            "UPDATE pai_scheduled_tasks SET attempts = max_attempts - 1 "
            "WHERE user_id = %s AND id = %s",
            (user_a, final.id),
        )
    fresh.last_run_at = datetime.now(UTC)
    final.last_run_at = datetime.now(UTC)

    dispatcher = DefaultDispatcher(pool=pool, lease_seconds=60, owner="test")

    # Retries remain → no fallback card, no push.
    await dispatcher.dispatch(fresh)
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT 1 FROM pai_pipeline_runs "
            "WHERE user_id = %s AND id LIKE 'sched.once.brief.fresh.%%.fb'",
            (user_a,),
        )
        assert await cur.fetchone() is None
    assert pushed == []

    # Last retry burned → fallback reminder card lands + push fires.
    await dispatcher.dispatch(final)
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT trigger, final_cards FROM pai_pipeline_runs "
            "WHERE user_id = %s AND id LIKE 'sched.once.brief.final.%%.fb'",
            (user_a,),
        )
        run = await cur.fetchone()
    assert run is not None and run["trigger"] == "reminder"
    card = run["final_cards"][0]
    assert card["title"] == "开会提醒"
    assert card["cardKind"] == "reminder"
    assert card["scheduleTaskId"] == "sched.once.brief.final"
    assert pushed == [{"user_id": user_a, "title": "开会提醒", "task_id": "sched.once.brief.final"}]
