"""ChatMessagesRepository — pai_chat_messages CRUD + cursor pagination + RLS.

The append-only conversation log that decouples history *display* from the
agent's checkpoint state. Correctness here is what makes "open Main Chat →
see my history instantly" work without reconstructing agent state.
"""

from __future__ import annotations

import pytest
from pinai_api.platform.db.repositories.chat_messages import ChatMessagesRepository
from pinai_db.rls import user_scoped_tx


def _text(t: str) -> list[dict]:
    return [{"type": "text", "text": t}]


@pytest.mark.asyncio
async def test_append_returns_increasing_ids_and_get_page_newest_first(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-m1"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        i1 = await repo.append_turn(thread_id=tid, role="user", parts=_text("hi"))
        i2 = await repo.append_turn(
            thread_id=tid,
            role="assistant",
            parts=_text("hello"),
        )
    assert i2 > i1
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatMessagesRepository(user_a, conn).get_page(thread_id=tid)
    assert [r["role"] for r in rows] == ["assistant", "user"]  # newest first
    assert rows[1]["parts"] == _text("hi")


@pytest.mark.asyncio
async def test_append_turn_stamps_client_msg_id(pool, user_ids):
    # client_msg_id (the send's clientMsgId, ridden through the mailbox as
    # idempotency_key) is stamped on the user row and read back by get_page so
    # the FE reconciles its optimistic bubble by identity. Assistant rows and
    # id-less sends stay NULL.
    user_a, _ = user_ids
    tid = f"main-{user_a}-cmid"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        await repo.append_turn(
            thread_id=tid, role="user", parts=_text("hi"), client_msg_id="uuid-1"
        )
        await repo.append_turn(thread_id=tid, role="assistant", parts=_text("hello"))
        await repo.append_turn(thread_id=tid, role="user", parts=_text("legacy send"))
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatMessagesRepository(user_a, conn).get_page(thread_id=tid)
    assert [r["client_msg_id"] for r in rows] == [None, None, "uuid-1"]  # newest first


@pytest.mark.asyncio
async def test_latest_id_none_then_value(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-m2"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        assert await repo.latest_id(thread_id=tid) is None
        i = await repo.append_turn(thread_id=tid, role="user", parts=_text("x"))
        assert await repo.latest_id(thread_id=tid) == i


@pytest.mark.asyncio
async def test_bulk_append_preserves_order(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-m3"
    turns = [{"role": "user", "parts": _text(f"q{i}")} for i in range(5)]
    async with user_scoped_tx(pool, user_a) as conn:
        n = await ChatMessagesRepository(user_a, conn).bulk_append(
            thread_id=tid,
            turns=turns,
        )
    assert n == 5
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatMessagesRepository(user_a, conn).get_page(
            thread_id=tid,
            limit=10,
        )
    assert [r["parts"][0]["text"] for r in reversed(rows)] == [
        "q0",
        "q1",
        "q2",
        "q3",
        "q4",
    ]


@pytest.mark.asyncio
async def test_get_page_cursor_walks_older(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-m4"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        ids = [
            await repo.append_turn(thread_id=tid, role="user", parts=_text(str(i)))
            for i in range(5)
        ]
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        page1 = await repo.get_page(thread_id=tid, limit=2)
        assert [r["id"] for r in page1] == [ids[4], ids[3]]
        page2 = await repo.get_page(
            thread_id=tid,
            before_id=page1[-1]["id"],
            limit=2,
        )
        assert [r["id"] for r in page2] == [ids[2], ids[1]]


@pytest.mark.asyncio
async def test_get_page_include_debug_filters_heartbeat_and_silent(pool, user_ids):
    # proactive debug-only rows: heartbeat inputs (role='heartbeat') and 'silent'
    # tick turns (trigger='tick' with no notify_user) are hidden when
    # include_debug=False; a tick turn that reached out (a notify_user part) and
    # plain user turns stay visible. Mirrors the FE Debug toggle so a reconnect
    # rebuilds the right view from the table.
    user_a, _ = user_ids
    tid = f"proactive-{user_a}"
    notify_parts = [
        {"type": "tool-call", "toolCallId": "t1", "toolName": "notify_user", "status": "ok"}
    ]
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        await repo.append_turn(
            thread_id=tid, role="heartbeat", parts=_text("[hb] window"), trigger="tick"
        )
        await repo.append_turn(
            thread_id=tid, role="assistant", parts=_text("silent think"), trigger="tick"
        )
        await repo.append_turn(thread_id=tid, role="user", parts=_text("hi"))
        await repo.append_turn(thread_id=tid, role="assistant", parts=notify_parts, trigger="tick")
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        full = await repo.get_page(thread_id=tid, include_debug=True)
        clean = await repo.get_page(thread_id=tid, include_debug=False)
    # Debug on: all four rows.
    assert len(full) == 4
    # Debug off: heartbeat row + silent tick turn dropped; the user turn and the
    # notify_user tick turn survive (oldest-first after reversing).
    assert [r["role"] for r in reversed(clean)] == ["user", "assistant"]
    assert clean[0]["parts"] == notify_parts  # the surviving assistant is the notify one


@pytest.mark.asyncio
async def test_rls_isolates_users(pool, user_ids):
    user_a, user_b = user_ids
    tid_a = f"main-{user_a}-rls"
    async with user_scoped_tx(pool, user_a) as conn:
        await ChatMessagesRepository(user_a, conn).append_turn(
            thread_id=tid_a,
            role="user",
            parts=_text("secret"),
        )
    async with user_scoped_tx(pool, user_b) as conn:
        rows = await ChatMessagesRepository(user_b, conn).get_page(thread_id=tid_a)
    assert rows == []
