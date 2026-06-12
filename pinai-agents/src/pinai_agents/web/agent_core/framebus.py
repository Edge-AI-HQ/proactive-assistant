"""FrameBus — resumable live-frame fan-out over Redis Streams.

Each session has one stream `frames:<session_id>`. publish XADDs one SSE
envelope per entry; the auto-generated entry id (`<ms>-<seq>`, monotonic) is
the resume cursor — handed to the client as the SSE `id:` line and sent back as
`Last-Event-ID` on reconnect, so a dropped stream resumes exactly where it left
off (replay the entries after the cursor, then tail live).

Why Redis Streams (not the old in-memory bus, not Redis pub/sub):
  * Durable + cursored → a reconnect replays missed frames. pub/sub and the old
    InMemoryFrameBus are both fire-and-forget: a frame published while no
    subscriber is attached is lost, which is exactly the reconnect-gap bug.
  * Multi-instance safe by construction → any web instance XREADs the same
    stream, so the worker that produced the frames and the instance holding the
    SSE need not be the same process (a process-local bus can't do this).

Frames are short-lived (history truth is `pai_chat_messages`): each stream is
MAXLEN-capped and its TTL is refreshed on every publish, so an idle session's
stream evaporates on its own.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any, Protocol, cast, runtime_checkable

from redis.asyncio import Redis
from redis.exceptions import RedisError
from redis.exceptions import TimeoutError as RedisTimeoutError

logger = logging.getLogger(__name__)

# One SSE-envelope wire dict (shared/sse_envelope shape).
Frame = dict[str, Any]

# A subscribe() item: a (cursor_id, frame) pair to forward, or None as a
# keepalive tick — the XREAD BLOCK window elapsed with no new frame, so the
# caller emits a `: ping` comment WITHOUT tearing the stream down. (This is the
# bug the old `asyncio.wait_for(anext(gen))` keepalive had: a timeout cancelled
# the generator and ended the stream. A BLOCK timeout is just an empty read.)
SubItem = tuple[str, Frame] | None

# Decoded XREAD response (decode_responses=True): per stream a
# (name, [(entry_id, {field: value}), ...]) pair. redis-py types xread as the
# very wide ResponseT, so we assert the decoded shape at this Redis boundary.
_XReadResp = list[tuple[str, list[tuple[str, dict[str, str]]]]]

_STREAM_PREFIX = "frames:"


@runtime_checkable
class FrameBus(Protocol):
    """The seam the service/worker depend on (RedisFrameBus is the only impl;
    tests inject a fake)."""

    async def publish(self, session_id: str, frame: Frame) -> None: ...

    def subscribe(self, session_id: str, *, last_id: str = "$") -> AsyncIterator[SubItem]: ...

    async def stream_exists(self, session_id: str) -> bool: ...

    async def history(self, session_id: str) -> list[tuple[str, Frame]]: ...


async def publish_terminal_frames(
    bus: FrameBus, session_id: str, run_id: str, *, error: str | None = None
) -> None:
    """Terminal frames for runs that never get them from the chat stream.

    The happy path's `chat:done` rides the agent stream itself (chat's
    SSE layer emits it in a finally), but when no relay ever delivers a
    stream end — ChatRunError, user cancel, shutdown, reaped crash, or a
    cancel of an awaiting_input (HITL-paused) run that has NO in-flight
    relay anywhere — no terminal frame reaches the FrameBus and a connected
    client's spinner/approval card leaks until it re-polls. DB state is
    already terminal when this runs; the frames are best-effort UX, so
    publish failures only log. Shared by the worker (fail/cancel/reaper)
    and AgentRunService.cancel (awaiting-input cancel)."""
    ts = int(time.time() * 1000)
    frames: list[Frame] = []
    if error is not None:
        frames.append({"type": "chat:error", "ts": ts, "traceId": run_id, "data": {"error": error}})
    frames.append({"type": "chat:done", "ts": ts, "traceId": run_id, "data": {}})
    for frame in frames:
        try:
            await bus.publish(session_id, frame)
        except Exception:
            # Keep trying the rest — chat:done matters more than chat:error
            # (it's what stops the client spinner).
            logger.warning(
                "terminal frame publish failed session=%s run=%s type=%s",
                session_id,
                run_id,
                frame.get("type"),
            )


class RedisFrameBus:
    """Redis Streams fan-out. See module docstring.

    `block_ms` is the XREAD BLOCK window = keepalive cadence. `maxlen` caps a
    session stream (≈ a few turns of frames; history truth lives elsewhere).
    `ttl_seconds` is refreshed on every publish so idle streams expire.
    """

    def __init__(
        self,
        redis: Redis,
        *,
        block_ms: int = 15_000,
        maxlen: int = 2_000,
        ttl_seconds: int = 86_400,
    ) -> None:
        self._redis = redis
        self._block_ms = block_ms
        self._maxlen = maxlen
        self._ttl = ttl_seconds

    @staticmethod
    def _key(session_id: str) -> str:
        return f"{_STREAM_PREFIX}{session_id}"

    async def publish(self, session_id: str, frame: Frame) -> None:
        """XADD one frame + refresh the stream TTL. MAXLEN trim keeps the stream
        bounded (approximate `~` trim is cheaper and fine — replay only needs
        recent frames; completed turns are in pai_chat_messages)."""
        key = self._key(session_id)
        await self._redis.xadd(
            key,
            {"data": json.dumps(frame, ensure_ascii=False)},
            maxlen=self._maxlen,
            approximate=True,
        )
        await self._redis.expire(key, self._ttl)

    async def stream_exists(self, session_id: str) -> bool:
        """Whether the session's stream is still present. False after TTL
        expiry → a reconnect carrying a stale cursor must resync from history
        (the cursor can never catch up to a stream that no longer exists)."""
        return bool(await self._redis.exists(self._key(session_id)))

    async def history(self, session_id: str, *, count: int = 2_000) -> list[tuple[str, Frame]]:
        """Read the session's current stream oldest→newest (bounded by MAXLEN).
        Used to rebuild an in-flight turn on a FRESH connect (a refresh has no
        cursor to resume from): /history finds where the running turn starts so
        the client can replay it. Returns (entry_id, frame) pairs."""
        resp = cast(
            "list[tuple[str, dict[str, str]]]",
            await self._redis.xrange(self._key(session_id), count=count),
        )
        out: list[tuple[str, Frame]] = []
        for entry_id, fields in resp:
            raw = fields.get("data")
            if raw is None:
                continue
            try:
                out.append((entry_id, json.loads(raw)))
            except (ValueError, TypeError):
                logger.warning("frame decode failed session=%s entry=%s", session_id, entry_id)
                continue
        return out

    async def subscribe(self, session_id: str, *, last_id: str = "$") -> AsyncIterator[SubItem]:
        """Yield (entry_id, frame) from `last_id` onward, forever.

        `last_id`:
          * "$"  → only frames added after this call attaches (live tail; the
                   client's past is loaded from history, not replayed here).
          * a concrete entry id → replay every frame strictly after it, then
            tail live (this is the reconnect / Last-Event-ID path).

        On each XREAD BLOCK timeout (no new frame within `block_ms`) yields None
        so the caller can emit a keepalive without closing the stream.
        """
        key = self._key(session_id)
        cursor = last_id
        while True:
            try:
                resp = cast(
                    "_XReadResp | None",
                    await self._redis.xread({key: cursor}, block=self._block_ms, count=200),
                )
            except RedisTimeoutError:
                # redis-py 8.x enforces a ~5s default read timeout even with
                # socket_timeout=None, so a quiet BLOCK window longer than that
                # surfaces as TimeoutError instead of an empty read. Treat it
                # exactly like one — keepalive tick, stream stays open. MUST
                # precede the RedisError clause below (it's a subclass).
                yield None
                continue
            except RedisError as exc:
                # Anything else (connection refused, failover, …) is a real
                # disconnect — close gracefully; the client reconnects with
                # Last-Event-ID and resumes from its cursor.
                logger.warning("frame stream disconnected session=%s: %s", session_id, exc)
                return
            if not resp:
                yield None  # BLOCK window elapsed — keepalive tick, stream stays open
                continue
            # resp shape: [(stream_name, [(entry_id, {"data": <json>}), ...])]
            for _stream, entries in resp:
                for entry_id, fields in entries:
                    cursor = entry_id  # advance past "$" onto a concrete id
                    raw = fields.get("data")
                    if raw is None:
                        continue
                    try:
                        frame = json.loads(raw)
                    except (ValueError, TypeError):
                        logger.warning(
                            "frame decode failed session=%s entry=%s", session_id, entry_id
                        )
                        continue
                    yield (entry_id, frame)
