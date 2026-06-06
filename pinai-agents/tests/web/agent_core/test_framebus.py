"""InMemoryFrameBus — live fan-out, no replay, no DB."""

from __future__ import annotations

import asyncio

import pytest

from pinai_agents.web.agent_core.framebus import InMemoryFrameBus


@pytest.mark.asyncio
async def test_framebus_fanout_in_order():
    bus = InMemoryFrameBus()
    sid = "s1"
    received: list[dict] = []

    async def consume() -> None:
        async for frame in bus.subscribe(sid):
            received.append(frame)
            if frame.get("type") == "chat:done":
                break

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.01)  # let the subscriber register before publishing
    await bus.publish(sid, {"type": "chat:delta", "data": {"delta": "hi"}})
    await bus.publish(sid, {"type": "chat:done"})
    await asyncio.wait_for(task, timeout=2)
    assert [f["type"] for f in received] == ["chat:delta", "chat:done"]


@pytest.mark.asyncio
async def test_framebus_publish_no_subscriber_is_noop():
    bus = InMemoryFrameBus()
    # batch run with no live subscriber: publish must not raise
    await bus.publish("nobody", {"type": "chat:delta", "data": {"delta": "x"}})


@pytest.mark.asyncio
async def test_framebus_two_subscribers_both_receive():
    bus = InMemoryFrameBus()
    sid = "s2"
    got_a: list[dict] = []
    got_b: list[dict] = []

    async def consume(sink: list[dict]) -> None:
        async for frame in bus.subscribe(sid):
            sink.append(frame)
            if frame.get("type") == "chat:done":
                break

    ta = asyncio.create_task(consume(got_a))
    tb = asyncio.create_task(consume(got_b))
    await asyncio.sleep(0.01)
    await bus.publish(sid, {"type": "chat:done"})
    await asyncio.wait_for(asyncio.gather(ta, tb), timeout=2)
    assert got_a and got_b  # fan-out reached both
