"""Events SSE signal plane — listener fan-out (pure) + append→NOTIFY (DB).

The pure tests drive EventsChangeListener's subscriber bookkeeping without a
connection (start() is never called). The DB tests verify the publish side:
EventsRepository.append fires pg_notify on the events channel at COMMIT, and
a dedupe no-op stays silent. They need TEST_DATABASE_URL (same contract as
test_events.py).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime

import psycopg
import pytest
from pinai_api.domains.memory.events.notify import (
    EVENTS_CHANGED_CHANNEL,
    EventsChangeListener,
)
from pinai_api.domains.memory.events.repository import AppendEventInput, EventsRepository
from pinai_db.rls import user_scoped_tx

# ── listener fan-out (no connection) ─────────────────────────────────────


def test_signal_wakes_every_subscriber_of_that_user():
    listener = EventsChangeListener("postgresql://unused")
    q1 = listener.subscribe(1)
    q2 = listener.subscribe(1)
    other = listener.subscribe(2)

    listener._signal(1)

    assert q1.qsize() == 1
    assert q2.qsize() == 1
    assert other.qsize() == 0


def test_signal_coalesces_bursts_into_one_slot():
    listener = EventsChangeListener("postgresql://unused")
    q = listener.subscribe(1)

    for _ in range(5):
        listener._signal(1)

    # maxsize-1 queue: a burst collapses to a single pending wake-up.
    assert q.qsize() == 1


def test_unsubscribe_stops_delivery_and_drops_empty_user_entry():
    listener = EventsChangeListener("postgresql://unused")
    q = listener.subscribe(1)
    listener.unsubscribe(1, q)

    listener._signal(1)

    assert q.qsize() == 0
    assert 1 not in listener._subscribers


def test_signal_all_wakes_every_user():
    listener = EventsChangeListener("postgresql://unused")
    q1 = listener.subscribe(1)
    q2 = listener.subscribe(2)

    listener._signal_all()

    assert q1.qsize() == 1
    assert q2.qsize() == 1


# ── publish side: append → pg_notify on COMMIT (needs TEST_DATABASE_URL) ──


def _dsn() -> str:
    return os.environ["TEST_DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)


async def _wait_notify(conn: psycopg.AsyncConnection, timeout: float) -> str | None:
    """Next NOTIFY payload on `conn`, or None if the window closes quietly."""
    gen = conn.notifies()
    try:
        n = await asyncio.wait_for(anext(gen), timeout)
        return str(n.payload)
    except TimeoutError:
        return None
    finally:
        await gen.aclose()


@pytest.mark.asyncio
async def test_append_notifies_on_commit_and_dedupe_noop_is_silent(pool, user_ids):
    user_a, _ = user_ids
    listen_conn = await psycopg.AsyncConnection.connect(_dsn(), autocommit=True)
    try:
        await listen_conn.execute(f"LISTEN {EVENTS_CHANGED_CHANNEL}")

        inp = AppendEventInput(
            id="e_notify_1",
            source="device",
            event_type="utterance",
            occurred_at=datetime(2026, 6, 1, tzinfo=UTC),
            dedupe_key="k_notify_1",
            title="hello",
        )
        async with user_scoped_tx(pool, user_a) as conn:
            await EventsRepository(user_a, conn).append(inp)

        payload = await _wait_notify(listen_conn, timeout=5.0)
        assert payload == str(user_a)

        # Same dedupe_key again → conflict no-op → no notification.
        async with user_scoped_tx(pool, user_a) as conn:
            await EventsRepository(user_a, conn).append(inp)

        assert await _wait_notify(listen_conn, timeout=1.0) is None
    finally:
        await listen_conn.close()
