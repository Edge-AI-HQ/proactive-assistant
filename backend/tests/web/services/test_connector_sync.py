"""connector.sync mode tests — incremental cursor flow.

Verifies the run-time invariants of incremental sync:

  * First sync (no cursor) uses bootstrap lookback (24h ago).
  * Subsequent sync passes the prior cursor as `since`.
  * Cursor advances to the run's start time on raw-insert success.
  * Cursor stays put when fetch/raw fails (next attempt re-pulls).
  * Empty syncs (inserted=0) skip the evolve enqueue.
  * `_run_init` ensures the recurring sync schedule on success.

Tests use a fake toolkit by monkeypatching `ingest_runner.run_fetch`
and registering an upserter for "fake" so no real Composio calls
happen. DB is real because the cursor + scheduled task tables are
exactly what's under test. We also stub a recipe for "fake" so the
connector_ingest skip-check passes.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pinai_api.domains.connector.apps import connector_ingest, ingest_runner
from pinai_api.domains.connector.apps.connectors import ConnectorsRepository
from pinai_api.platform.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_db.rls import service_tx, user_scoped_tx


def _sync_task(user_id: int, cid: str, *, task_id: str | None = None) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=task_id or f"sync.fake.{cid}",
        kind="connector.sync",
        name=None,
        prompt=None,
        trigger_kind="schedule",
        cron_expr="*/30 * * * *",
        interval_seconds=None,
        event_filter=None,
        payload={"toolkit": "fake", "connectedAccountId": cid},
        timezone="UTC",
        status="active",
        next_run_at=None,
        last_run_at=datetime.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


def _init_task(user_id: int, cid: str) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=f"init.fake.{cid}",
        kind="connector.init",
        name=None,
        prompt=None,
        trigger_kind="once",
        cron_expr=None,
        interval_seconds=None,
        event_filter=None,
        payload={"toolkit": "fake", "connectedAccountId": cid, "limit": 50},
        timezone="UTC",
        status="archived",
        next_run_at=None,
        last_run_at=datetime.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


@pytest.fixture
def fake_adapter(monkeypatch):
    """Stub a 'fake' toolkit so `connector_ingest._run_sync` proceeds:
      * `ingest_runner.load_recipe('fake')` → a fake ingestable Recipe
      * `ingest_runner.run_fetch(...)` → returns whatever the test stages
      * `_UPSERTERS['fake']` → ack-all upserter

    Returns (captures, set_items): captures['since'] shows the `since`
    arg the runner saw; set_items(list) swaps what fetch returns."""
    state: dict = {"items": []}
    captured: dict = {}

    fake_recipe = ingest_runner.Recipe(
        toolkit="fake",
        slug="FAKE_LIST",
        connect_only=False,
    )

    def fake_load_recipe(toolkit: str):
        if toolkit == "fake":
            return fake_recipe
        return None

    async def fake_fetch(user_id, toolkit, cid, *, limit=100, since=None, pool=None):
        if toolkit != "fake":
            return []
        captured["user_id"] = user_id
        captured["cid"] = cid
        captured["limit"] = limit
        captured["since"] = since
        return list(state["items"])

    async def fake_upsert(conn, user_id, items):
        # Ack everything; tests count via what fake_fetch returned.
        return len(items)

    monkeypatch.setattr(ingest_runner, "load_recipe", fake_load_recipe)
    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    monkeypatch.setitem(connector_ingest._UPSERTERS, "fake", fake_upsert)

    def set_items(items: list[dict]) -> None:
        state["items"] = items

    return captured, set_items


@pytest.mark.asyncio
async def test_first_sync_uses_bootstrap_lookback(pool, user_ids, fake_adapter):
    """No prior cursor → fetcher receives `since` ≈ now - 24h."""
    user_a, _ = user_ids
    captured, set_items = fake_adapter
    set_items([{"id": "i1"}, {"id": "i2"}])

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.fake.cid1",
            kind="connector.sync",
            payload={"toolkit": "fake", "connectedAccountId": "cid1"},
        )

    started = datetime.now(UTC)
    await connector_ingest.run(pool, _sync_task(user_a, "cid1"), "run_a")

    since = captured.get("since")
    assert since is not None
    delta = started - since
    # ~24h ago, give a few seconds of slack for clock drift.
    assert timedelta(hours=23, minutes=58) < delta < timedelta(hours=24, minutes=2)


@pytest.mark.asyncio
async def test_sync_uses_existing_cursor_then_advances_it(
    pool,
    user_ids,
    fake_adapter,
):
    """Prior cursor → fetcher receives that timestamp; cursor advances
    to ~now after the run."""
    user_a, _ = user_ids
    captured, set_items = fake_adapter
    set_items([{"id": "i1"}])

    prior = datetime(2026, 5, 1, 10, 0, 0, tzinfo=UTC)
    async with user_scoped_tx(pool, user_a) as conn:
        await ConnectorsRepository(user_a, conn).set_cursor(
            toolkit="fake",
            connected_account_id="cid2",
            last_synced_at=prior,
        )
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.fake.cid2",
            kind="connector.sync",
            payload={"toolkit": "fake", "connectedAccountId": "cid2"},
        )

    started = datetime.now(UTC)
    await connector_ingest.run(pool, _sync_task(user_a, "cid2"), "run_b")

    assert captured["since"] == prior

    async with user_scoped_tx(pool, user_a) as conn:
        cursor = await ConnectorsRepository(user_a, conn).get_cursor(
            toolkit="fake",
            connected_account_id="cid2",
        )
    assert cursor is not None
    # Advanced to ~started (within a couple seconds).
    assert cursor.last_synced_at > prior
    assert (started - cursor.last_synced_at) < timedelta(seconds=3)


@pytest.mark.asyncio
async def test_sync_failure_leaves_cursor_untouched(pool, user_ids, monkeypatch):
    """Fetcher raising leaves the cursor at its prior value so the
    next attempt re-pulls the same window."""
    user_a, _ = user_ids
    prior = datetime(2026, 5, 1, 10, 0, 0, tzinfo=UTC)

    fake_recipe = ingest_runner.Recipe(
        toolkit="fake",
        slug="FAKE_LIST",
        connect_only=False,
    )

    def fake_load_recipe(toolkit: str):
        return fake_recipe if toolkit == "fake" else None

    async def boom_fetch(*args, **kwargs):
        msg = "composio 503"
        raise RuntimeError(msg)

    async def noop_upsert(conn, user_id, items):
        return 0

    monkeypatch.setattr(ingest_runner, "load_recipe", fake_load_recipe)
    monkeypatch.setattr(ingest_runner, "run_fetch", boom_fetch)
    monkeypatch.setitem(connector_ingest._UPSERTERS, "fake", noop_upsert)

    async with user_scoped_tx(pool, user_a) as conn:
        await ConnectorsRepository(user_a, conn).set_cursor(
            toolkit="fake",
            connected_account_id="cid3",
            last_synced_at=prior,
        )
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.fake.cid3",
            kind="connector.sync",
            payload={"toolkit": "fake", "connectedAccountId": "cid3"},
        )

    with pytest.raises(RuntimeError, match="composio 503"):
        await connector_ingest.run(pool, _sync_task(user_a, "cid3"), "run_c")

    async with user_scoped_tx(pool, user_a) as conn:
        cursor = await ConnectorsRepository(user_a, conn).get_cursor(
            toolkit="fake",
            connected_account_id="cid3",
        )
    assert cursor is not None
    assert cursor.last_synced_at == prior  # unchanged


@pytest.mark.asyncio
async def test_sync_empty_skips_evolve_enqueue(pool, user_ids, fake_adapter):
    """0 inserted → no connector.evolve task created. Empty syncs are
    common (cron fires every 30min) and don't need an LLM run."""
    user_a, _ = user_ids
    _captured, set_items = fake_adapter
    set_items([])  # nothing to fetch

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.fake.cid4",
            kind="connector.sync",
            payload={"toolkit": "fake", "connectedAccountId": "cid4"},
        )

    await connector_ingest.run(pool, _sync_task(user_a, "cid4"), "run_d")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT id FROM pai_scheduled_tasks WHERE user_id = %s AND kind = 'connector.evolve'",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert rows == []


@pytest.mark.asyncio
async def test_sync_with_inserts_enqueues_evolve(pool, user_ids, fake_adapter):
    user_a, _ = user_ids
    _captured, set_items = fake_adapter
    set_items([{"id": "i1"}, {"id": "i2"}])

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.fake.cid5",
            kind="connector.sync",
            payload={"toolkit": "fake", "connectedAccountId": "cid5"},
        )

    await connector_ingest.run(pool, _sync_task(user_a, "cid5"), "run_e")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT id, payload FROM pai_scheduled_tasks "
            "WHERE user_id = %s AND kind = 'connector.evolve'",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["id"] == "evolve.fake.cid5"


# ── _run_init enqueues a recurring sync schedule ────────────────────────


@pytest.mark.asyncio
async def test_init_creates_sync_schedule(pool, user_ids, fake_adapter):
    """After init succeeds, a connector.sync schedule for (toolkit, cid)
    must exist with cron_expr set."""
    user_a, _ = user_ids
    _captured, set_items = fake_adapter
    set_items([{"id": "i1"}])

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.fake.cid6",
            kind="connector.init",
            payload={"toolkit": "fake", "connectedAccountId": "cid6", "limit": 50},
        )

    await connector_ingest.run(pool, _init_task(user_a, "cid6"), "run_f")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT id, cron_expr, status, trigger_kind FROM pai_scheduled_tasks "
            "WHERE user_id = %s AND id = %s",
            (user_a, "sync.fake.cid6"),
        )
        row = await cur.fetchone()
    assert row is not None
    assert row["cron_expr"] == connector_ingest._SYNC_CRON_EXPR
    assert row["status"] == "active"
    assert row["trigger_kind"] == "schedule"


@pytest.mark.asyncio
async def test_init_sync_schedule_idempotent(pool, user_ids, fake_adapter):
    """Re-running init for the same (toolkit, cid) — e.g. user reconnects —
    must not reset the existing sync schedule's next_run_at (avoiding a
    Composio storm right after reconnect)."""
    user_a, _ = user_ids
    _captured, set_items = fake_adapter
    set_items([{"id": "i1"}])

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.fake.cid7",
            kind="connector.init",
            payload={"toolkit": "fake", "connectedAccountId": "cid7", "limit": 50},
        )
    await connector_ingest.run(pool, _init_task(user_a, "cid7"), "run_g1")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT next_run_at FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, "sync.fake.cid7"),
        )
        first = (await cur.fetchone())["next_run_at"]

    # Re-fire init (e.g. reconnect) by re-queuing + re-running.
    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="init.fake.cid7.again",
            kind="connector.init",
            payload={"toolkit": "fake", "connectedAccountId": "cid7", "limit": 50},
        )
    task = _init_task(user_a, "cid7")
    task.id = "init.fake.cid7.again"
    await connector_ingest.run(pool, task, "run_g2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT next_run_at FROM pai_scheduled_tasks WHERE user_id = %s AND id = %s",
            (user_a, "sync.fake.cid7"),
        )
        second = (await cur.fetchone())["next_run_at"]

    assert first == second  # ON CONFLICT DO NOTHING preserved next_run_at
