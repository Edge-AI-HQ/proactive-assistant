"""Realtime change signal for the L1 event stream (the SSE signal plane).

Publish: EventsRepository.append() fires `pg_notify('pai_events_changed',
user_id)` inside the writing transaction. Postgres delivers NOTIFY on COMMIT
(rollback = no signal) and folds duplicate (channel, payload) pairs within one
transaction — a batch ingest of N rows lands as ONE notification. Every writer
(projector, agent event_append, feedback, world fan-out, card decisions) goes
through append, so one publish point covers them all, including future callers.

Listen: each api instance runs ONE dedicated LISTEN connection (autocommit,
outside the pool — pooled connections get recycled, which would drop the
LISTEN). Notifications fan out in-process to per-user signal queues; the SSE
endpoint (ui.py /api/events/stream) awaits those queues. Cross-instance
delivery is inherent: every instance LISTENs to the same Postgres.

The signal is stateless ("something changed — refetch"); the data plane stays
the existing REST reads. A dropped signal degrades to the frontend's fallback
poll, so the listener favors simplicity over delivery guarantees.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

import psycopg

logger = logging.getLogger(__name__)

EVENTS_CHANGED_CHANNEL = "pai_events_changed"

_RECONNECT_DELAY_S = 3.0


class EventsChangeListener:
    """Process-wide LISTEN connection fanned out to per-user signal queues.

    Queues are maxsize-1 signal slots (put_nowait, drop when full): a
    subscriber only ever needs "changed since you last looked", never a
    backlog — bursts coalesce into one wake-up.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._subscribers: dict[int, set[asyncio.Queue[None]]] = {}
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="pinai-events-listen")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def subscribe(self, user_id: int) -> asyncio.Queue[None]:
        q: asyncio.Queue[None] = asyncio.Queue(maxsize=1)
        self._subscribers.setdefault(user_id, set()).add(q)
        return q

    def unsubscribe(self, user_id: int, q: asyncio.Queue[None]) -> None:
        subs = self._subscribers.get(user_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subscribers.pop(user_id, None)

    def _signal(self, user_id: int) -> None:
        for q in self._subscribers.get(user_id, ()):
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(None)

    def _signal_all(self) -> None:
        for user_id in list(self._subscribers):
            self._signal(user_id)

    async def _run(self) -> None:
        while True:
            try:
                conn = await psycopg.AsyncConnection.connect(self._dsn, autocommit=True)
                try:
                    await conn.execute(f"LISTEN {EVENTS_CHANGED_CHANNEL}")
                    logger.info("events LISTEN connected")
                    # A (re)connect may have missed notifications while down —
                    # wake every live subscriber once so clients refetch and
                    # close the gap.
                    self._signal_all()
                    async for n in conn.notifies():
                        try:
                            self._signal(int(n.payload))
                        except ValueError:
                            logger.warning("events NOTIFY bad payload: %r", n.payload)
                finally:
                    with contextlib.suppress(Exception):
                        await conn.close()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "events LISTEN dropped — reconnecting in %.0fs", _RECONNECT_DELAY_S
                )
                await asyncio.sleep(_RECONNECT_DELAY_S)
