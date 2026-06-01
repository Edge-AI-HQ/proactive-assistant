"""ChatMessagesRepository — pai_chat_messages CRUD + cursor pagination + RLS.

The append-only conversation log that decouples history *display* from the
agent's checkpoint state. Correctness here is what makes "open Main Chat →
see my history instantly" work without reconstructing agent state.
"""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.chat_messages import ChatMessagesRepository
from pinai_agents.web.db.rls import user_scoped_tx


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
async def test_delete_tail_removes_most_recent(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-m5"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        for i in range(4):
            await repo.append_turn(thread_id=tid, role="user", parts=_text(str(i)))
        deleted = await repo.delete_tail(thread_id=tid, count=2)
    assert deleted == 2
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatMessagesRepository(user_a, conn).get_page(thread_id=tid)
    assert [r["parts"][0]["text"] for r in reversed(rows)] == ["0", "1"]


@pytest.mark.asyncio
async def test_last_user_text_is_most_recent_user_turn(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-m6"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        await repo.append_turn(thread_id=tid, role="user", parts=_text("first q"))
        await repo.append_turn(thread_id=tid, role="assistant", parts=_text("a1"))
        await repo.append_turn(thread_id=tid, role="user", parts=_text("second q"))
        await repo.append_turn(thread_id=tid, role="assistant", parts=_text("a2"))
        assert await repo.last_user_text(thread_id=tid) == "second q"


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
