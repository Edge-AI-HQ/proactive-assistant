"""FrameBus — live frame fan-out for streaming agent output.

Frames are NEVER persisted (history truth is pai_chat_messages; reconnect
shows a waiting state and reads the final result — Claude-app model, plan
§四.4). So the bus only needs live fan-out, not a durable stream + cursor.

InMemoryFrameBus: dev / single web instance — process-local asyncio fan-out.
RedisFrameBus (Redis pub/sub): REQUIRED before prod multi-instance, because
process-local fan-out can't reach a subscriber on a different instance than
the worker running the run. The FrameBus Protocol keeps that swap one-file.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, Protocol, runtime_checkable

# One SSE-envelope wire dict (shared/sse_envelope shape). Not persisted.
Frame = dict[str, Any]


@runtime_checkable
class FrameBus(Protocol):
    async def publish(self, session_id: str, frame: Frame) -> None: ...

    def subscribe(self, session_id: str) -> AsyncIterator[Frame]: ...


class InMemoryFrameBus:
    """Process-local fan-out. dev / single-instance only — see module docstring."""

    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[Frame]]] = {}

    async def publish(self, session_id: str, frame: Frame) -> None:
        # snapshot to tuple: a subscriber may unsubscribe (mutate the set)
        # while we iterate.
        for q in tuple(self._subs.get(session_id, ())):
            q.put_nowait(frame)

    async def subscribe(self, session_id: str) -> AsyncIterator[Frame]:
        """Live frames from now on (no replay — reconnect uses run status +
        pai_chat_messages, not this)."""
        queue: asyncio.Queue[Frame] = asyncio.Queue()
        self._subs.setdefault(session_id, set()).add(queue)
        try:
            while True:
                yield await queue.get()
        finally:
            subs = self._subs.get(session_id)
            if subs is not None:
                subs.discard(queue)
                if not subs:
                    self._subs.pop(session_id, None)
