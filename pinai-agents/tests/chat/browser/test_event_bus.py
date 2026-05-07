"""Browser event bus — pub/sub + replay buffer.

Tests run inside pytest-asyncio so we can drive the asyncio.Queue
mechanics directly. No real Browserbase / playwright touched."""

from __future__ import annotations

import asyncio

import pytest

from pinai_agents.chat.browser.events import _BrowserEventBus


@pytest.fixture
def bus() -> _BrowserEventBus:
    # Fresh bus per test — the module-level `browser_events` would
    # leak state across tests.
    return _BrowserEventBus()


async def test_subscribe_receives_published_event(bus):
    async with bus.subscribe("sk1") as q:
        await bus.publish("sk1", {"type": "browser:opened", "ts": 1, "data": {}})
        envelope = await asyncio.wait_for(q.get(), timeout=1.0)
        assert envelope["type"] == "browser:opened"


async def test_publish_only_to_matching_session_key(bus):
    async with bus.subscribe("sk1") as q1, bus.subscribe("sk2") as q2:
        await bus.publish("sk1", {"type": "browser:opened", "ts": 1, "data": {}})
        ev = await asyncio.wait_for(q1.get(), timeout=1.0)
        assert ev["type"] == "browser:opened"
        # sk2 sees nothing within a short timeout.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q2.get(), timeout=0.2)


async def test_replay_delivers_one_state_envelope_with_control_inlined(bus):
    """A reconnecting frontend gets ONE envelope describing current state:
    browser:opened with the latest control mode + url folded in. Stateless
    reconnect — no event tape, just current state."""
    await bus.publish("sk1", {"type": "browser:opened", "ts": 1, "data": {"url": "x"}})
    await bus.publish(
        "sk1", {"type": "browser:control:granted", "ts": 2,
                "data": {"controlMode": "user"}},
    )
    await bus.publish(
        "sk1", {"type": "browser:navigated", "ts": 3, "data": {"url": "y"}},
    )
    async with bus.subscribe("sk1") as q:
        ev = await asyncio.wait_for(q.get(), timeout=1.0)
        assert ev["type"] == "browser:opened"
        assert ev["data"]["controlMode"] == "user"
        assert ev["data"]["url"] == "y"
        # No further replay envelopes — only the merged current state.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), timeout=0.1)


async def test_replay_keeps_latest_open(bus):
    await bus.publish("sk1", {"type": "browser:opened", "ts": 1, "data": {"v": "old"}})
    await bus.publish("sk1", {"type": "browser:opened", "ts": 2, "data": {"v": "new"}})
    async with bus.subscribe("sk1") as q:
        ev = await asyncio.wait_for(q.get(), timeout=1.0)
        assert ev["data"]["v"] == "new"
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), timeout=0.1)


async def test_close_replay_replaces_open(bus):
    """After close, a fresh subscriber gets browser:closed, not the prior open."""
    await bus.publish("sk1", {"type": "browser:opened", "ts": 1, "data": {}})
    await bus.publish("sk1", {"type": "browser:closed", "ts": 2, "data": {}})
    async with bus.subscribe("sk1") as q:
        ev = await asyncio.wait_for(q.get(), timeout=1.0)
        assert ev["type"] == "browser:closed"


async def test_clear_session_drops_replay_buffer(bus):
    await bus.publish("sk1", {"type": "browser:opened", "ts": 1, "data": {}})
    bus.clear_session("sk1")
    async with bus.subscribe("sk1") as q:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), timeout=0.2)


async def test_non_replayable_type_not_in_replay(bus):
    """browser:error is transient — subsequent subscribers shouldn't get
    a stale error replay."""
    await bus.publish("sk1", {"type": "browser:error", "ts": 1, "data": {"err": "x"}})
    async with bus.subscribe("sk1") as q:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), timeout=0.2)
