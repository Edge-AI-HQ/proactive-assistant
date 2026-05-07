"""In-process pub/sub for browser lifecycle events.

Subscribers (one per SSE connection) get the **current state** on connect
— a single `browser:opened` (with the session's current control mode +
takeover reason inlined) or a `browser:closed` marker — then live events
afterwards. Reconnect is idempotent: late subscribers see whatever the
session is right now, not a tape of past events.

Backpressure: bounded asyncio queue per subscriber, drop-oldest on
overflow. Lifecycle envelopes are state-replayed on the next change so
losing intermediate events is fine.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

logger = logging.getLogger(__name__)

_QUEUE_BOUND = 64


class _BrowserEventBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        # session_key → "current state" envelope. One entry per session_key:
        # either a browser:opened with control inlined, or a browser:closed.
        self._state: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def publish(self, session_key: str, envelope: dict[str, Any]) -> None:
        evt_type = envelope.get("type")
        if not isinstance(evt_type, str):
            return
        async with self._lock:
            self._update_state(session_key, envelope)
            subs = list(self._subs.get(session_key, ()))
        for q in subs:
            self._enqueue_drop_oldest(q, envelope)

    def _update_state(self, session_key: str, envelope: dict[str, Any]) -> None:
        """Maintain "what is the current state of this session?" so new
        subscribers can be brought up to date in one envelope."""
        evt_type = envelope.get("type")
        data = envelope.get("data") or {}
        if evt_type == "browser:opened":
            # Open replaces any prior state — and inlines control fields so
            # the replay envelope is self-contained.
            merged = dict(envelope)
            merged_data = dict(data)
            merged_data.setdefault("controlMode", "ai")
            merged_data.setdefault("takeoverReason", None)
            merged["data"] = merged_data
            self._state[session_key] = merged
        elif evt_type == "browser:closed":
            self._state[session_key] = envelope
        elif evt_type in ("browser:control:granted", "browser:control:takeover"):
            current = self._state.get(session_key)
            if current and current.get("type") == "browser:opened":
                current_data = dict(current.get("data") or {})
                current_data["controlMode"] = data.get("controlMode", current_data.get("controlMode", "ai"))
                current_data["takeoverReason"] = data.get("reason") if evt_type == "browser:control:takeover" else None
                current["data"] = current_data
        elif evt_type == "browser:navigated":
            current = self._state.get(session_key)
            if current and current.get("type") == "browser:opened":
                current_data = dict(current.get("data") or {})
                if isinstance(data.get("url"), str):
                    current_data["url"] = data["url"]
                current["data"] = current_data

    def _enqueue_drop_oldest(
        self, q: asyncio.Queue[dict[str, Any]], envelope: dict[str, Any],
    ) -> None:
        try:
            q.put_nowait(envelope)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                q.get_nowait()
            try:
                q.put_nowait(envelope)
            except asyncio.QueueFull:
                logger.warning("browser_events: subscriber too slow, dropping")

    @asynccontextmanager
    async def subscribe(
        self, session_key: str,
    ) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=_QUEUE_BOUND)
        async with self._lock:
            self._subs.setdefault(session_key, set()).add(q)
            current = self._state.get(session_key)
        if current is not None:
            self._enqueue_drop_oldest(q, current)
        try:
            yield q
        finally:
            async with self._lock:
                subs = self._subs.get(session_key)
                if subs is not None:
                    subs.discard(q)
                    if not subs:
                        self._subs.pop(session_key, None)

    def clear_session(self, session_key: str) -> None:
        """Drop the cached state for `session_key`. Called on destroy so
        a fresh connect after destruction sees nothing replayed."""
        self._state.pop(session_key, None)


browser_events = _BrowserEventBus()
