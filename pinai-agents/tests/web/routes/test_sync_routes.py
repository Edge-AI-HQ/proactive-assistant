"""/api/sync/* delta 协议（Sync-B1）— repo 的 since 读 + cursor 编解码。

锁的契约：messages 的单调 id cursor 不丢不重（append-only 回放一次）、
threads 的复合 cursor 在 updated_at 平局时靠 thread_id tie-break 不跳行、
坏 cursor 按 bootstrap 容错。
"""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.chat_messages import (
    ChatMessagesRepository,
    row_to_history_message,
)
from pinai_agents.web.db.repositories.chat_threads import ChatThreadsRepository
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.routes.ui.sync import (
    decode_threads_cursor,
    encode_threads_cursor,
)


def _text(t: str) -> list[dict]:
    return [{"type": "text", "text": t}]


@pytest.mark.asyncio
async def test_messages_get_since_replays_in_order_without_loss_or_dup(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-sync1"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        i1 = await repo.append_turn(thread_id=tid, role="user", parts=_text("m1"))
        await repo.append_turn(thread_id=tid, role="assistant", parts=_text("m2"))
        i3 = await repo.append_turn(thread_id=tid, role="user", parts=_text("m3"))

    # Bootstrap（since=0）拿全量，oldest first。
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatMessagesRepository(user_a, conn).get_since(thread_id=tid)
    assert [r["parts"][0]["text"] for r in rows] == ["m1", "m2", "m3"]

    # 从第一页 cursor 续拉：不重（m1 不再出现）不丢（m2/m3 都到）。
    async with user_scoped_tx(pool, user_a) as conn:
        delta = await ChatMessagesRepository(user_a, conn).get_since(thread_id=tid, since_id=i1)
    assert [r["parts"][0]["text"] for r in delta] == ["m2", "m3"]

    # 追平后空页。
    async with user_scoped_tx(pool, user_a) as conn:
        empty = await ChatMessagesRepository(user_a, conn).get_since(thread_id=tid, since_id=i3)
    assert empty == []


@pytest.mark.asyncio
async def test_messages_get_since_limit_pages_cleanly(pool, user_ids):
    user_a, _ = user_ids
    tid = f"main-{user_a}-sync2"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatMessagesRepository(user_a, conn)
        for i in range(5):
            await repo.append_turn(thread_id=tid, role="user", parts=_text(f"m{i}"))

    async with user_scoped_tx(pool, user_a) as conn:
        page1 = await ChatMessagesRepository(user_a, conn).get_since(thread_id=tid, limit=2)
    assert len(page1) == 2
    async with user_scoped_tx(pool, user_a) as conn:
        page2 = await ChatMessagesRepository(user_a, conn).get_since(
            thread_id=tid, since_id=int(page1[-1]["id"]), limit=10
        )
    texts = [r["parts"][0]["text"] for r in page1 + page2]
    assert texts == ["m0", "m1", "m2", "m3", "m4"]


@pytest.mark.asyncio
async def test_messages_rows_serialize_to_history_shape(pool, user_ids):
    # sync 行与 /history 行同形（同一序列化函数）——协议演进纪律。
    user_a, _ = user_ids
    tid = f"main-{user_a}-sync3"
    async with user_scoped_tx(pool, user_a) as conn:
        await ChatMessagesRepository(user_a, conn).append_turn(
            thread_id=tid, role="user", parts=_text("hi"), client_msg_id="cid-1"
        )
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatMessagesRepository(user_a, conn).get_since(thread_id=tid)
    msg = row_to_history_message(rows[0])
    assert msg["role"] == "user"
    assert msg["clientMsgId"] == "cid-1"
    assert isinstance(msg["createdAt"], int)
    assert "trigger" not in msg  # user trigger 不下发


@pytest.mark.asyncio
async def test_messages_get_since_is_user_scoped(pool, user_ids):
    user_a, user_b = user_ids
    tid = f"main-{user_a}-sync4"
    async with user_scoped_tx(pool, user_a) as conn:
        await ChatMessagesRepository(user_a, conn).append_turn(
            thread_id=tid, role="user", parts=_text("secret")
        )
    # 他人读同一 thread_id → 空页（增量语义下与"无变更"同形）。
    async with user_scoped_tx(pool, user_b) as conn:
        rows = await ChatMessagesRepository(user_b, conn).get_since(thread_id=tid)
    assert rows == []


@pytest.mark.asyncio
async def test_threads_list_since_advances_on_bump(pool, user_ids):
    user_a, _ = user_ids
    card_id = f"ts2-{user_a}"
    t1, t2 = f"main-{user_a}-ts1", f"card-thread-{card_id}"
    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=t1, kind="main")
        await repo.insert_thread(thread_id=t2, kind="card", card_id=card_id)

    # Bootstrap 拿到两行（oldest-change first）。
    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatThreadsRepository(user_a, conn).list_since()
    ids = [r["thread_id"] for r in rows]
    assert t1 in ids and t2 in ids
    cursor_at, cursor_tid = rows[-1]["updated_at"].isoformat(), rows[-1]["thread_id"]

    # 追平后空页。
    async with user_scoped_tx(pool, user_a) as conn:
        empty = await ChatThreadsRepository(user_a, conn).list_since(
            updated_after=cursor_at, after_thread_id=cursor_tid
        )
    assert empty == []

    # bump 推进 updated_at → 该行重新出现在增量里（状态变化即 upsert）。
    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).bump_after_send(thread_id=t1)
    async with user_scoped_tx(pool, user_a) as conn:
        delta = await ChatThreadsRepository(user_a, conn).list_since(
            updated_after=cursor_at, after_thread_id=cursor_tid
        )
    assert [r["thread_id"] for r in delta] == [t1]
    assert int(delta[0]["message_count"]) == 1


def test_threads_cursor_roundtrip_and_corruption_tolerance():
    class _Ts:
        def isoformat(self) -> str:
            return "2026-06-11T00:00:00+00:00"

    cursor = encode_threads_cursor({"updated_at": _Ts(), "thread_id": "main-1-x"})
    assert decode_threads_cursor(cursor) == ("2026-06-11T00:00:00+00:00", "main-1-x")
    # 坏 cursor → bootstrap 语义（None, None），不 500。
    assert decode_threads_cursor(None) == (None, None)
    assert decode_threads_cursor("") == (None, None)
    assert decode_threads_cursor("garbage-without-sep") == (None, None)
