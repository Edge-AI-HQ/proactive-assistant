"""record_failure_and_decide + requeue_once + archive_after_success
behavior on the consolidated pai_scheduled_tasks queue."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from pinai_agents.web.db.repositories.scheduled_tasks import (
    ScheduledTasksRepository,
    archive_after_success,
    backoff_seconds_for_attempt,
    enqueue_once,
    record_failure_and_decide,
    requeue_once,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx


def test_backoff_schedule():
    assert backoff_seconds_for_attempt(0) == 30
    assert backoff_seconds_for_attempt(1) == 30
    assert backoff_seconds_for_attempt(2) == 120
    assert backoff_seconds_for_attempt(3) == 600
    assert backoff_seconds_for_attempt(99) == 600


@pytest.mark.asyncio
async def test_enqueue_once_idempotent_on_existing(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        first = await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidA",
            kind="connector.init",
            payload={"toolkit": "gmail"},
            max_attempts=3,
        )
        second = await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidA",
            kind="connector.init",
            payload={"toolkit": "gmail"},
            max_attempts=3,
        )
    assert first is True
    assert second is False


@pytest.mark.asyncio
async def test_requeue_once_resets_archived(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidB",
            kind="connector.init",
            payload={"toolkit": "gmail"},
            max_attempts=3,
        )
    # Simulate a prior fire that archived the row
    async with service_tx(pool) as conn:
        await conn.execute(
            "UPDATE pai_scheduled_tasks SET status='archived', "
            "next_run_at=NULL, attempts=2, last_error='boom' "
            "WHERE user_id=%s AND id=%s",
            (user_a, "init.gmail.cidB"),
        )
    async with user_scoped_tx(pool, user_a) as conn:
        await requeue_once(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidB",
            kind="connector.init",
            payload={"toolkit": "gmail", "reason": "reconnect"},
            max_attempts=3,
        )
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status, attempts, last_error, payload, next_run_at "
            "FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, "init.gmail.cidB"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "active"
    assert row["attempts"] == 0
    assert row["last_error"] is None
    assert row["payload"] == {"toolkit": "gmail", "reason": "reconnect"}
    assert row["next_run_at"] is not None


@pytest.mark.asyncio
async def test_record_failure_decides_retry_then_archive(pool, user_ids):
    """First two failures schedule a retry; the third archives."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidC",
            kind="connector.init",
            payload={"toolkit": "gmail"},
            max_attempts=3,
        )

    # Fail 1 → retry
    async with service_tx(pool) as conn:
        attempts, status = await record_failure_and_decide(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidC",
            last_error="net 1",
            retry_backoff_seconds=30,
        )
    assert attempts == 1
    assert status == "active"

    # Fail 2 → retry
    async with service_tx(pool) as conn:
        attempts, status = await record_failure_and_decide(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidC",
            last_error="net 2",
            retry_backoff_seconds=120,
        )
    assert attempts == 2
    assert status == "active"

    # Fail 3 → archive (attempts+1=3 == max_attempts, no more retries)
    async with service_tx(pool) as conn:
        attempts, status = await record_failure_and_decide(
            conn,
            user_id=user_a,
            task_id="init.gmail.cidC",
            last_error="net 3",
            retry_backoff_seconds=600,
        )
    assert attempts == 3
    assert status == "archived"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status, attempts, last_error, next_run_at "
            "FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, "init.gmail.cidC"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "archived"
    assert row["attempts"] == 3
    assert row["last_error"] == "net 3"
    assert row["next_run_at"] is None


@pytest.mark.asyncio
async def test_recurring_failure_stays_active_after_max_attempts(pool, user_ids):
    user_a, _ = user_ids
    next_run_at = datetime.now(UTC) + timedelta(hours=12)
    async with user_scoped_tx(pool, user_a) as conn:
        await ScheduledTasksRepository(user_a, conn).upsert(
            id="gen.auto.retry",
            kind="generator.auto",
            trigger_kind="schedule",
            interval_seconds=12 * 60 * 60,
            next_run_at=next_run_at,
            payload={"trigger": "auto"},
        )

    for attempt in range(3):
        async with service_tx(pool) as conn:
            attempts, status = await record_failure_and_decide(
                conn,
                user_id=user_a,
                task_id="gen.auto.retry",
                last_error=f"net {attempt + 1}",
                retry_backoff_seconds=600,
            )

    assert attempts == 3
    assert status == "active"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status, attempts, last_error, next_run_at "
            "FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, "gen.auto.retry"),
        )
        row = await cur.fetchone()

    assert row is not None
    assert row["status"] == "active"
    assert row["attempts"] == 3
    assert row["last_error"] == "net 3"
    assert row["next_run_at"] is not None


@pytest.mark.asyncio
async def test_archive_after_success_only_touches_once(pool, user_ids):
    """Cron tasks should NOT be archived by archive_after_success — that
    helper is once-only. Guards against the dispatcher accidentally
    archiving a recurring task on success."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ScheduledTasksRepository(user_a, conn)
        await repo.upsert(
            id="cron_task",
            kind="auto.dreaming",
            trigger_kind="schedule",
            cron_expr="0 6 * * *",
            next_run_at=None,
        )
    async with service_tx(pool) as conn:
        await archive_after_success(
            conn,
            user_id=user_a,
            task_id="cron_task",
        )
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_a, "cron_task"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "active"  # untouched
