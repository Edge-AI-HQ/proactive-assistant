"""Scheduler main loop.

Runs in the web FastAPI process as an asyncio task started by lifespan.
Every N seconds:
  1. reap_stale_runs       — clear crashed-worker leases
  2. claim_due_tasks       — atomically pull due rows (SKIP LOCKED)
  3. for each row:
     - compute next_run_at (croniter)
     - update_after_fire   — bookkeeping
     - dispatch            — async, doesn't block tick

Multi-replica safe: SKIP LOCKED ensures only one web instance claims any
particular row. Crashed-worker leases are reclaimed by reap_stale_runs
(step 1) once they expire; there is no per-run lease heartbeat.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

from pinai_db.rls import service_tx
from psycopg_pool import AsyncConnectionPool

from ..control.kernel import AgentRunService
from ..platform.db.repositories.scheduled_tasks import (
    SCHEDULER_WAKE_CHANNEL,
    ScheduledTaskRow,
    claim_due_tasks,
    reap_stale_runs,
    update_after_fire,
)
from .cron import next_fire
from .dispatcher import DefaultDispatcher

logger = logging.getLogger(__name__)


# Type alias for testability — caller can swap in a fake dispatcher.
Dispatcher = Callable[[ScheduledTaskRow], Awaitable[None]]


async def run_tick_once(
    pool: AsyncConnectionPool,
    *,
    dispatcher: Dispatcher,
    batch: int = 16,
) -> int:
    """Single tick. Returns number of tasks dispatched (0 on idle).

    Exposed as a free function for testing — tick_loop is just an
    `await run_tick_once` in a sleep loop.
    """
    # Reap first: clears leases the next claim might race against.
    async with service_tx(pool) as conn:
        reaped = await reap_stale_runs(conn)
    if reaped:
        logger.info("scheduler reaped %d stale run(s)", reaped)

    async with service_tx(pool) as conn:
        claimed = await claim_due_tasks(conn, batch=batch)

    if not claimed:
        return 0

    logger.info("scheduler claimed %d task(s)", len(claimed))

    # Compute next_run_at + persist; then fire dispatch in parallel.
    update_coros = []
    for task in claimed:
        nxt = next_fire(
            trigger_kind=task.trigger_kind,
            cron_expr=task.cron_expr,
            interval_seconds=task.interval_seconds,
            timezone=task.timezone,
            after=task.last_run_at,
        )
        update_coros.append(_persist_next(pool, task, nxt))
    await asyncio.gather(*update_coros, return_exceptions=False)

    # Fire dispatch in background — tick loop must not wait on
    # potentially-long agent runs.
    for task in claimed:
        asyncio.create_task(_safe_dispatch(dispatcher, task))

    return len(claimed)


async def _persist_next(pool, task: ScheduledTaskRow, nxt) -> None:
    async with service_tx(pool) as conn:
        await update_after_fire(
            conn,
            user_id=task.user_id,
            task_id=task.id,
            next_run_at=nxt,
            last_run_status="dispatched",
            archive_if_once=(task.trigger_kind == "once"),
        )


async def _safe_dispatch(dispatcher: Dispatcher, task: ScheduledTaskRow) -> None:
    try:
        await dispatcher(task)
    except Exception:
        logger.exception("dispatcher raised user=%d task=%s", task.user_id, task.id)


async def tick_loop(
    pool: AsyncConnectionPool,
    *,
    interval_seconds: int,
    dispatcher: Dispatcher | None = None,
    lease_seconds: int = 60,
    service: AgentRunService | None = None,
) -> None:
    """Long-running tick task. Cancellable; cancellation cleanly exits.

    Pass a custom dispatcher (Dispatcher protocol) for testing; defaults
    to the real DefaultDispatcher routing by task.kind. `service` (RC-3) lets
    the default dispatcher mirror batch agent runs into pai_agent_runs.
    """
    actual_dispatcher: Dispatcher
    if dispatcher is not None:
        actual_dispatcher = dispatcher
    else:
        d = DefaultDispatcher(pool, lease_seconds=lease_seconds, service=service)
        actual_dispatcher = d.dispatch

    logger.info(
        "scheduler tick_loop started interval=%ds (NOTIFY %s wakes early)",
        interval_seconds,
        SCHEDULER_WAKE_CHANNEL,
    )
    # jti revocation sweep cadence — much rarer than the per-second
    # scheduler tick. Once an hour is plenty: rows past expires_at are
    # already harmless (the JWT exp gate rejects them).
    last_jti_sweep = 0.0
    jti_sweep_interval = 3600.0

    # NOTIFY listener runs in a separate background task; it sets the
    # event whenever a wake-up arrives, and the main loop awaits the
    # event with a timeout. This is the standard pattern for "tick or
    # event, whichever comes first" and keeps the loop body unchanged.
    wake_event = asyncio.Event()
    listen_task = asyncio.create_task(
        _listen_for_wake(pool, wake_event),
        name="scheduler-listen-wake",
    )

    try:
        while True:
            try:
                await run_tick_once(pool, dispatcher=actual_dispatcher)
            except Exception:
                logger.exception("scheduler tick failed; continuing")

            # Embedding queue drain — runs every tick. Cheap when empty
            # (single SELECT returns 0 rows), bursts up to BATCH_SIZE
            # when memories or signals were just written.
            try:
                await _drain_embeddings(pool)
            except Exception:
                logger.exception("embedding drain failed; continuing")

            now = asyncio.get_event_loop().time()
            if (now - last_jti_sweep) >= jti_sweep_interval:
                try:
                    await _sweep_jti(pool)
                except Exception:
                    logger.exception("jti sweep failed; continuing")
                last_jti_sweep = now

            # Wait for either the timeout (interval) or a NOTIFY wake.
            # asyncio.wait_for swallows TimeoutError and clears the event
            # exactly once per loop iteration.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    wake_event.wait(),
                    timeout=interval_seconds,
                )
            wake_event.clear()
    except asyncio.CancelledError:
        logger.info("scheduler tick_loop cancelled")
        listen_task.cancel()
        raise


async def _listen_for_wake(
    pool: AsyncConnectionPool,
    wake_event: asyncio.Event,
) -> None:
    """Hold a dedicated connection LISTENing on SCHEDULER_WAKE_CHANNEL.

    Each notification sets `wake_event`. Connection is recycled on any
    error so a single dropped pg connection doesn't blackhole future
    wake-ups — worst case the main loop's interval timer kicks in.

    Lives for the lifetime of the tick_loop; cancelled with the parent.
    """
    while True:
        try:
            # Bypass the pool: LISTEN occupies the connection for its
            # lifetime, which would starve the pool. Open a fresh raw
            # connection from the same DSN.
            async with pool.connection() as conn:
                # Autocommit so LISTEN's effect is immediately visible
                # to NOTIFY senders that aren't in the same session.
                await conn.set_autocommit(True)
                async with conn.cursor() as cur:
                    await cur.execute(f"LISTEN {SCHEDULER_WAKE_CHANNEL}")
                logger.info(
                    "scheduler LISTEN started channel=%s",
                    SCHEDULER_WAKE_CHANNEL,
                )
                async for _notify in conn.notifies():
                    # Coalesce burst notifies: a single wake_event.set()
                    # is enough — the next tick will pick up everything
                    # that was enqueued during the burst.
                    wake_event.set()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "scheduler LISTEN crashed; reconnecting in 1s",
            )
            await asyncio.sleep(1)


async def _drain_embeddings(pool: AsyncConnectionPool) -> None:
    """Pull pending rows from pai_embedding_queue, embed via LiteLLM,
    write vectors back to source tables. Cheap on empty queue (one
    SELECT). Skips silently when LiteLLM isn't configured (dev without
    full litellm stack)."""
    from ..platform.embeddings import drain_queue  # noqa: PLC0415

    async with service_tx(pool) as conn:
        n = await drain_queue(conn)
    if n > 0:
        logger.info("embedded %d row(s)", n)


async def _sweep_jti(pool: AsyncConnectionPool) -> None:
    """Drop pai_jti_revocations rows whose underlying JWT TTL has passed.
    Pure cleanup — never affects correctness (the JWT exp claim already
    rejects expired tokens), just bounds the table size."""
    from ..platform.db.repositories.jti_revocations import sweep_expired  # noqa: PLC0415

    async with service_tx(pool) as conn:
        n = await sweep_expired(conn)
    if n > 0:
        logger.info("jti sweep evicted %d expired revocation(s)", n)
