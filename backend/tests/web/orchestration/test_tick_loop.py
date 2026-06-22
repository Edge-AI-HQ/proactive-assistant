"""tick_loop.run_tick_once with a fake dispatcher.

Verify the tick:
  * claims due tasks
  * computes next_run_at via croniter and persists it
  * fires the dispatcher (background asyncio.create_task)
  * leaves non-due tasks alone

The fake dispatcher captures dispatched tasks via an asyncio.Event so we
can wait for the create_task'd dispatch to land.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from pinai_api.orchestration.tick_loop import run_tick_once
from pinai_api.platform.db.repositories.scheduled_tasks import (
    ScheduledTasksRepository,
)
from pinai_db.rls import service_tx, user_scoped_tx


@pytest.mark.xfail(
    reason="scheduler suite isolation: run_tick_once scans due tasks cross-user "
    "with a batch cap, so residual due tasks from other tests make this flaky "
    "under full/repeated runs. Pre-existing, not from the DB-test CI work. "
    "Needs a self-contained scheduled_tasks setup/teardown (see docs/plans "
    "TODO). strict=False: a fresh-DB pass shows as xpass.",
    strict=False,
)
@pytest.mark.asyncio
async def test_tick_dispatches_due_and_advances_next_run(pool, user_ids):
    user_a, _ = user_ids
    past = datetime.now(UTC) - timedelta(seconds=5)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ScheduledTasksRepository(user_a, conn)
        await repo.upsert(
            id="tick_test",
            kind="auto.dreaming",
            trigger_kind="schedule",
            cron_expr="0 6 * * *",
            next_run_at=past,
        )

    dispatched: list[tuple[int, str]] = []
    fired = asyncio.Event()

    async def fake_dispatcher(task) -> None:
        dispatched.append((task.user_id, task.id))
        fired.set()

    n = await run_tick_once(pool, dispatcher=fake_dispatcher, batch=10)
    assert n >= 1

    # Wait for create_task'd dispatch to actually run.
    await asyncio.wait_for(fired.wait(), timeout=5)
    assert (user_a, "tick_test") in dispatched

    # Verify next_run_at advanced to a future time
    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT next_run_at, last_run_at, run_count, last_run_status "
            "FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, "tick_test"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["next_run_at"] is not None
    assert row["next_run_at"] > datetime.now(UTC)
    assert row["last_run_at"] is not None
    assert row["run_count"] >= 1
    assert row["last_run_status"] == "dispatched"


@pytest.mark.asyncio
async def test_tick_archives_once_after_fire(pool, user_ids):
    user_a, _ = user_ids
    past = datetime.now(UTC) - timedelta(seconds=5)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ScheduledTasksRepository(user_a, conn)
        await repo.upsert(
            id="once_task",
            kind="user.prompt",
            trigger_kind="once",
            cron_expr=None,
            next_run_at=past,
        )

    async def noop(task) -> None:
        pass

    await run_tick_once(pool, dispatcher=noop, batch=10)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status, next_run_at FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, "once_task"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["status"] == "archived"
    assert row["next_run_at"] is None
