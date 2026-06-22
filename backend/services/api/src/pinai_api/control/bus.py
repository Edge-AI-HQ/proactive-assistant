"""AgentBus — pg_notify control signals for the actor kernel.

These are SIGNALS (small, session-keyed), distinct from frame DATA (which
goes through FrameBus — high-volume, may need Redis). Postgres LISTEN/NOTIFY
fits signals with no Redis dependency (same transport as proactive_bus):

  * notify_message    — wake a worker to drain a session. Low-latency only;
                        the worker's interval poll is the correctness
                        fallback (plan §十一 "worker 正确性靠轮询,不靠通知").
  * notify_cancel     — cross-instance cancel: whichever web instance holds
                        the in-flight run aborts it (plan §十一 cancel 真停).
  * notify_run_status — run state change for the frontend reconnect/waiting
                        view (plan §四.4 Claude-app model): an SSE-route
                        subscriber learns running→terminal without polling.

One LISTEN loop per web process fans notifications in to the worker's
wake/cancel callbacks + run-status subscriber queues.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from typing import Any

from pinai_db.rls import service_tx
from psycopg_pool import AsyncConnectionPool

logger = logging.getLogger(__name__)

_CH_WAKE = "pai_agent_wake"
_CH_CANCEL = "pai_agent_cancel"
_CH_RUN_STATUS = "pai_agent_run_status"
_QUEUE_MAXSIZE = 1000


async def _emit(pool: AsyncConnectionPool, channel: str, payload: str) -> None:
    """Best-effort NOTIFY. A dropped signal is recovered by the worker's
    interval poll (wake) or the TTL reaper (status) — never raise into a
    caller (publish must not break the enqueue / cancel path)."""
    try:
        async with service_tx(pool) as conn:
            await conn.execute("SELECT pg_notify(%s, %s)", (channel, payload))
    except Exception:
        logger.exception("agent bus emit failed channel=%s", channel)


async def notify_message(pool: AsyncConnectionPool, session_id: str) -> None:
    await _emit(pool, _CH_WAKE, session_id)


async def notify_cancel(pool: AsyncConnectionPool, session_id: str) -> None:
    await _emit(pool, _CH_CANCEL, session_id)


async def notify_run_status(
    pool: AsyncConnectionPool, *, session_id: str, run_id: str, status: str
) -> None:
    await _emit(
        pool,
        _CH_RUN_STATUS,
        json.dumps({"s": session_id, "r": run_id, "st": status}),
    )


class AgentBus:
    """Per-process LISTEN fan-in. Module singleton below."""

    def __init__(self) -> None:
        self._pool: AsyncConnectionPool | None = None
        self._task: asyncio.Task[None] | None = None
        self._on_wake: Callable[[str], None] | None = None
        self._on_cancel: Callable[[str], None] | None = None
        # session_id → run-status subscriber queues (frontend reconnect view)
        self._status_subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}

    async def start(
        self,
        pool: AsyncConnectionPool,
        *,
        on_wake: Callable[[str], None],
        on_cancel: Callable[[str], None],
    ) -> None:
        self._pool = pool
        self._on_wake = on_wake
        self._on_cancel = on_cancel
        self._task = asyncio.create_task(self._listen_loop(), name="agent-bus-listen")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def subscribe_run_status(self, session_id: str) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_MAXSIZE)
        self._status_subs.setdefault(session_id, set()).add(q)
        return q

    def unsubscribe_run_status(self, session_id: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        subs = self._status_subs.get(session_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._status_subs.pop(session_id, None)

    def _fanout_status(self, session_id: str, event: dict[str, Any]) -> None:
        for q in tuple(self._status_subs.get(session_id, ())):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(event)

    async def _listen_loop(self) -> None:
        """Hold a dedicated connection LISTENing on the three channels; fan
        each notification to the right sink. Recycles on error so a dropped
        connection doesn't blackhole signals (interval poll still covers
        wake; status subscribers reconnect)."""
        assert self._pool is not None
        while True:
            try:
                async with self._pool.connection() as conn:
                    await conn.set_autocommit(True)
                    async with conn.cursor() as cur:
                        await cur.execute(f"LISTEN {_CH_WAKE}")
                        await cur.execute(f"LISTEN {_CH_CANCEL}")
                        await cur.execute(f"LISTEN {_CH_RUN_STATUS}")
                    logger.info("agent bus LISTEN started")
                    async for n in conn.notifies():
                        self._dispatch(n.channel, n.payload)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("agent bus LISTEN crashed; reconnecting in 1s")
                await asyncio.sleep(1)

    def _dispatch(self, channel: str, payload: str) -> None:
        if channel == _CH_WAKE:
            if self._on_wake is not None:
                self._on_wake(payload)
        elif channel == _CH_CANCEL:
            if self._on_cancel is not None:
                self._on_cancel(payload)
        elif channel == _CH_RUN_STATUS:
            try:
                obj = json.loads(payload)
                session_id = str(obj["s"])
            except (ValueError, KeyError, TypeError):
                logger.warning("agent bus bad run_status payload")
                return
            self._fanout_status(session_id, obj)


# Module singleton — one bus per web process.
agent_bus = AgentBus()
