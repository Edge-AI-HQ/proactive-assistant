"""Per-user evolve coalescing + debounce (design §八: 同一用户同时只一个 evolve).

Locks in enqueue_user_evolve:
  * two connector triggers fold into ONE per-user task ("evolve" singleton),
    connectors accumulate, rawSources union (deduped)
  * debounce: a sync trigger arms the task ~2min out (NOT now) so sibling
    syncs finishing seconds apart merge instead of spawning serial runs;
    merging keeps the EARLIEST due (later triggers can't push it out)
  * immediate (init cold-start / custom-MCP manual): due now
  * an archived row (previous run done) is re-armed FRESH — its already-
    distilled connectors are not carried over

Plus the 4-hourly auto-evolution fire computation (croniter over the cron
expression, user-timezone aware).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from pinai_api.domains.connector.apps.connector_ingest import (
    _EVOLVE_DEBOUNCE_SECONDS,
    enqueue_user_evolve,
)
from pinai_api.domains.user_model.settings_ui import _next_auto_dreaming_fire
from pinai_db.rls import user_scoped_tx


async def _evolve_task(pool, user_id: int) -> dict | None:
    async with user_scoped_tx(pool, user_id) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT id, kind, status, next_run_at, payload FROM pai_scheduled_tasks "
            "WHERE user_id = %s AND id = 'evolve'",
            (user_id,),
        )
        return await cur.fetchone()


@pytest.mark.asyncio
async def test_two_connectors_fold_into_one_task(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_user_evolve(conn, user_id=user_a, connector="gmail")
        await enqueue_user_evolve(
            conn,
            user_id=user_a,
            connector="googlecalendar",
            raw_sources=[{"toolkit": "googlecalendar", "entity": "events"}],
        )
    task = await _evolve_task(pool, user_a)
    assert task is not None and task["kind"] == "connector.evolve"
    assert task["payload"]["connectors"] == ["gmail", "googlecalendar"]
    assert task["payload"]["rawSources"] == [{"toolkit": "googlecalendar", "entity": "events"}]

    # Re-trigger with a duplicate source: connectors + rawSources stay deduped.
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_user_evolve(
            conn,
            user_id=user_a,
            connector="gmail",
            raw_sources=[{"toolkit": "googlecalendar", "entity": "events"}],
        )
    task = await _evolve_task(pool, user_a)
    assert task["payload"]["connectors"] == ["gmail", "googlecalendar"]
    assert task["payload"]["rawSources"] == [{"toolkit": "googlecalendar", "entity": "events"}]


@pytest.mark.asyncio
async def test_debounce_arms_future_and_merge_keeps_earliest(pool, user_ids):
    user_a, _ = user_ids
    before = datetime.now(UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_user_evolve(conn, user_id=user_a, connector="gmail")
    first = await _evolve_task(pool, user_a)
    # Armed in the future (debounce), not immediately claimable.
    assert first["next_run_at"] > before
    assert first["next_run_at"] <= before + timedelta(seconds=_EVOLVE_DEBOUNCE_SECONDS + 5)

    # A second trigger merges and must NOT push the due time out.
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_user_evolve(conn, user_id=user_a, connector="slack")
    second = await _evolve_task(pool, user_a)
    assert second["next_run_at"] <= first["next_run_at"]


@pytest.mark.asyncio
async def test_immediate_fires_now(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_user_evolve(conn, user_id=user_a, connector="gmail", immediate=True)
    task = await _evolve_task(pool, user_a)
    assert task["next_run_at"] <= datetime.now(UTC)


@pytest.mark.asyncio
async def test_archived_row_rearms_fresh(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_user_evolve(conn, user_id=user_a, connector="gmail")
        # Simulate the dispatcher finishing the run (once → archived).
        await conn.execute(
            "UPDATE pai_scheduled_tasks SET status = 'archived' "
            "WHERE user_id = %s AND id = 'evolve'",
            (user_a,),
        )
        await enqueue_user_evolve(conn, user_id=user_a, connector="slack")
    task = await _evolve_task(pool, user_a)
    assert task["status"] == "active"
    # gmail was already distilled by the archived run — not carried over.
    assert task["payload"]["connectors"] == ["slack"]


def test_next_auto_evolution_fire_is_next_4h_boundary():
    tz = "America/Los_Angeles"
    # 2026-07-04 09:30 local → next boundary 12:00 local.
    after = datetime(2026, 7, 4, 9, 30, tzinfo=ZoneInfo(tz))
    fire = _next_auto_dreaming_fire(timezone=tz, after=after)
    assert fire.astimezone(ZoneInfo(tz)).hour == 12
    assert fire.astimezone(ZoneInfo(tz)).minute == 0
    # 23:59 local → next boundary 00:00 next day.
    after = datetime(2026, 7, 4, 23, 59, tzinfo=ZoneInfo(tz))
    fire = _next_auto_dreaming_fire(timezone=tz, after=after)
    local = fire.astimezone(ZoneInfo(tz))
    assert (local.hour, local.day) == (0, 5)
