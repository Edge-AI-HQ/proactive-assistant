"""RedisFrameBus — Redis Streams fan-out with cursor replay (fakeredis).

Covers the two properties the resumable SSE stream rests on:
  * replay-strictly-after-cursor → a reconnect carrying Last-Event-ID gets the
    missed frames and NO duplicates (fixes the reconnect-gap loss).
  * keepalive tick yields None, never closes the generator → an idle stream
    stays open (fixes the old wait_for(anext) self-disconnect).
"""

from __future__ import annotations

import pytest
from fakeredis import FakeAsyncRedis

from pinai_agents.web.agent_core.framebus import Frame, RedisFrameBus


def _bus() -> RedisFrameBus:
    # Own fake server per test; short block so the idle keepalive tick fires fast.
    return RedisFrameBus(FakeAsyncRedis(decode_responses=True), block_ms=50)


async def _drain_backlog(
    bus: RedisFrameBus, sid: str, *, last_id: str = "0", limit: int = 10
) -> list[tuple[str, Frame]]:
    """Collect (entry_id, frame) from last_id until the first keepalive tick
    (= backlog exhausted) or `limit`."""
    out: list[tuple[str, Frame]] = []
    async for item in bus.subscribe(sid, last_id=last_id):
        if item is None:
            break  # XREAD BLOCK elapsed → backlog drained
        out.append(item)
        if len(out) >= limit:
            break
    return out


@pytest.mark.asyncio
async def test_publish_then_replay_in_order() -> None:
    bus = _bus()
    await bus.publish("s1", {"type": "chat:delta", "data": {"delta": "hi"}})
    await bus.publish("s1", {"type": "chat:done"})
    got = await _drain_backlog(bus, "s1")
    assert [f["type"] for _id, f in got] == ["chat:delta", "chat:done"]
    # entry ids are monotonic → usable as the SSE cursor / Last-Event-ID
    ids = [i for i, _f in got]
    assert ids == sorted(ids)


@pytest.mark.asyncio
async def test_replay_strictly_after_cursor() -> None:
    # The core resumability guarantee: reconnect from a cursor gets only what
    # came AFTER it — no loss, no duplication.
    bus = _bus()
    await bus.publish("s2", {"type": "chat:delta", "data": {"delta": "a"}})
    first = await _drain_backlog(bus, "s2")
    cursor = first[0][0]
    await bus.publish("s2", {"type": "chat:delta", "data": {"delta": "b"}})
    after = await _drain_backlog(bus, "s2", last_id=cursor)
    assert [f["data"]["delta"] for _id, f in after] == ["b"]


@pytest.mark.asyncio
async def test_keepalive_tick_when_idle_keeps_stream_open() -> None:
    # Nothing published: the first item is the keepalive sentinel (None), and
    # the generator is STILL ALIVE afterwards — this is the bug we fixed (the
    # old keepalive cancelled the generator and ended the stream).
    bus = _bus()
    agen = bus.subscribe("idle", last_id="$")
    assert await agen.__anext__() is None
    assert await agen.__anext__() is None  # still ticking, not StopAsyncIteration
    await agen.aclose()


@pytest.mark.asyncio
async def test_stream_exists() -> None:
    bus = _bus()
    assert await bus.stream_exists("nope") is False
    await bus.publish("here", {"type": "chat:done"})
    assert await bus.stream_exists("here") is True


@pytest.mark.asyncio
async def test_fanout_two_subscribers_both_replay() -> None:
    bus = _bus()
    await bus.publish("s3", {"type": "chat:done"})
    a = await _drain_backlog(bus, "s3")
    b = await _drain_backlog(bus, "s3")
    assert [f["type"] for _i, f in a] == ["chat:done"]
    assert [f["type"] for _i, f in b] == ["chat:done"]


@pytest.mark.asyncio
async def test_history_reads_full_stream_oldest_first() -> None:
    # /history scans this (by traceId) to locate an in-flight turn's replay
    # cursor on a refresh.
    bus = _bus()
    await bus.publish("h1", {"type": "chat:thinking", "traceId": "run1", "data": {}})
    await bus.publish("h1", {"type": "chat:delta", "traceId": "run1", "data": {"delta": "yo"}})
    hist = await bus.history("h1")
    assert [f["type"] for _id, f in hist] == ["chat:thinking", "chat:delta"]
    ids = [i for i, _f in hist]
    assert ids == sorted(ids)  # oldest → newest, so cursor scanning works


@pytest.mark.asyncio
async def test_history_empty_stream_is_empty_list() -> None:
    bus = _bus()
    assert await bus.history("nope") == []


@pytest.mark.asyncio
async def test_redis_read_timeout_is_a_keepalive_not_a_crash() -> None:
    # redis-py 8.x applies a ~5s default read timeout even when
    # socket_timeout=None, so a quiet XREAD BLOCK window longer than that
    # raises TimeoutError instead of returning an empty read. The subscribe
    # loop must surface it as a keepalive tick — the resumable SSE stream
    # must NOT die every quiet window (regression: 2026-06-10 local stack,
    # stream died every ~5s and the client reconnect-looped).
    from redis.exceptions import TimeoutError as RedisTimeoutError

    bus = _bus()
    await bus.publish("s-timeout", {"type": "chat:done"})

    calls = {"n": 0}
    real_xread = bus._redis.xread

    async def flaky_xread(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RedisTimeoutError("Timeout reading from redis:6379")
        return await real_xread(*args, **kwargs)

    bus._redis.xread = flaky_xread

    gen = bus.subscribe("s-timeout", last_id="0")
    first = await anext(gen)
    assert first is None  # the timeout became a keepalive, not an exception
    second = await anext(gen)
    assert second is not None and second[1]["type"] == "chat:done"
