"""ChatThreadsRepository — pai_chat_threads CRUD + RLS.

The metadata table that links a user to their LangGraph threads.
End-to-end correctness here is what makes "open Main Chat → resume
my latest conversation" work after localStorage gets cleared, or
on a fresh device.

Tests cover the full surface:
  * insert idempotent (init may re-fire for same sessionKey)
  * latest-main lookup with the exact sort order chat_init relies on
  * list filtering (kind + archived)
  * bump after send
  * archive soft-delete
  * CHECK constraint rejects malformed thread_id
  * RLS isolates user A from user B
"""

from __future__ import annotations

import uuid

import psycopg.errors
import pytest

from pinai_agents.web.db.repositories.chat_threads import ChatThreadsRepository
from pinai_agents.web.db.rls import user_scoped_tx


def _main_thread_id(user_id: int) -> str:
    return f"main-{user_id}-{uuid.uuid4().hex[:12]}"


def _card_thread_id(card_id: str) -> str:
    return f"card-thread-{card_id}"


# ── insert + idempotency ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_insert_thread_persists_row(pool, user_ids):
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=tid, kind="main", title="My first chat",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatThreadsRepository(user_a, conn).list_threads()
    assert len(rows) == 1
    assert rows[0].thread_id == tid
    assert rows[0].kind == "main"
    assert rows[0].title == "My first chat"
    assert rows[0].archived is False
    assert rows[0].message_count == 0


@pytest.mark.asyncio
async def test_insert_thread_idempotent_on_conflict(pool, user_ids):
    """ON CONFLICT DO NOTHING: re-firing init for the same sessionKey
    is a no-op, doesn't 500."""
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=tid, kind="main", title="first")
        await repo.insert_thread(thread_id=tid, kind="main", title="second")

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatThreadsRepository(user_a, conn).list_threads()
    # Second insert was a no-op — title stays at "first".
    assert len(rows) == 1
    assert rows[0].title == "first"


# ── card threads + CHECK constraint ────────────────────────────────────────


@pytest.mark.asyncio
async def test_insert_card_thread_with_card_id(pool, user_ids):
    user_a, _ = user_ids
    card_id = "gen.run123.cardA_card_00"
    tid = _card_thread_id(card_id)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=tid, kind="card", card_id=card_id,
        )

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatThreadsRepository(user_a, conn).list_threads(kind="card")
    assert len(rows) == 1
    assert rows[0].kind == "card"
    assert rows[0].card_id == card_id


@pytest.mark.asyncio
async def test_insert_rejects_main_thread_with_wrong_user_prefix(pool, user_ids):
    """CHECK constraint enforces thread_id LIKE 'main-<user_id>-%' so a
    bug that lets one user write under another user's prefix gets caught
    at the DB layer."""
    user_a, user_b = user_ids
    bad_tid = f"main-{user_b}-deadbeef0000"  # belongs to user_b naming-wise

    async with user_scoped_tx(pool, user_a) as conn:
        with pytest.raises(Exception) as exc:
            await ChatThreadsRepository(user_a, conn).insert_thread(
                thread_id=bad_tid, kind="main",
            )
        assert "check" in str(exc.value).lower() or "constraint" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_insert_rejects_card_thread_without_card_id(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            await ChatThreadsRepository(user_a, conn).insert_thread(
                thread_id="card-thread-xyz", kind="card", card_id=None,
            )


@pytest.mark.asyncio
async def test_insert_rejects_card_thread_id_card_id_mismatch(pool, user_ids):
    """thread_id MUST equal 'card-thread-' || card_id; mismatched values
    are rejected by the CHECK."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            await ChatThreadsRepository(user_a, conn).insert_thread(
                thread_id="card-thread-foo", kind="card", card_id="bar",
            )


# ── get_latest_main_thread_id sort order ───────────────────────────────────


@pytest.mark.asyncio
async def test_latest_main_returns_none_when_user_has_nothing(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        result = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert result is None


@pytest.mark.asyncio
async def test_latest_main_picks_thread_with_most_messages_when_timestamps_tie(
    pool, user_ids,
):
    """The migration backfills every existing thread with last_message_at
    = NOW() (single timestamp). Sort breaks ties by message_count DESC
    so the user's longest conversation is what they get back, not whichever
    row Postgres physical-ordered first.
    """
    user_a, _ = user_ids
    short_tid = _main_thread_id(user_a)
    long_tid = _main_thread_id(user_a)
    medium_tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        # All three inserted in the same tx → identical NOW(). After
        # insert, manually set message_count to simulate post-backfill state.
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=short_tid, kind="main")
        await repo.insert_thread(thread_id=long_tid, kind="main")
        await repo.insert_thread(thread_id=medium_tid, kind="main")
        await conn.execute(
            "UPDATE pai_chat_threads SET message_count = %s WHERE thread_id = %s",
            (3, short_tid),
        )
        await conn.execute(
            "UPDATE pai_chat_threads SET message_count = %s WHERE thread_id = %s",
            (75, long_tid),
        )
        await conn.execute(
            "UPDATE pai_chat_threads SET message_count = %s WHERE thread_id = %s",
            (28, medium_tid),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        latest = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert latest == long_tid


@pytest.mark.asyncio
async def test_latest_main_prefers_recent_activity_over_message_count(pool, user_ids):
    """When last_message_at differs, recency wins — even if an older
    thread has more turns."""
    user_a, _ = user_ids
    older_long = _main_thread_id(user_a)
    newer_short = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=older_long, kind="main")
        await conn.execute(
            "UPDATE pai_chat_threads SET message_count = 75, "
            "last_message_at = NOW() - INTERVAL '7 days' WHERE thread_id = %s",
            (older_long,),
        )
        await repo.insert_thread(thread_id=newer_short, kind="main")
        await conn.execute(
            "UPDATE pai_chat_threads SET message_count = 5, "
            "last_message_at = NOW() WHERE thread_id = %s",
            (newer_short,),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        latest = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert latest == newer_short


@pytest.mark.asyncio
async def test_latest_main_skips_archived(pool, user_ids):
    user_a, _ = user_ids
    archived = _main_thread_id(user_a)
    active = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=archived, kind="main")
        await repo.insert_thread(thread_id=active, kind="main")
        await conn.execute(
            "UPDATE pai_chat_threads SET archived = TRUE, message_count = 999 "
            "WHERE thread_id = %s",
            (archived,),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        latest = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert latest == active


@pytest.mark.asyncio
async def test_latest_main_ignores_card_threads(pool, user_ids):
    """Card threads must never satisfy a "latest main" lookup."""
    user_a, _ = user_ids
    card_tid = _card_thread_id("only_card")

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=card_tid, kind="card", card_id="only_card",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        latest = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert latest is None


# ── list_threads ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_threads_filters_by_kind(pool, user_ids):
    user_a, _ = user_ids
    main_tid = _main_thread_id(user_a)
    card_tid = _card_thread_id("c123")

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=main_tid, kind="main")
        await repo.insert_thread(thread_id=card_tid, kind="card", card_id="c123")

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        all_rows = await repo.list_threads()
        only_main = await repo.list_threads(kind="main")
        only_card = await repo.list_threads(kind="card")
    assert {r.thread_id for r in all_rows} == {main_tid, card_tid}
    assert [r.thread_id for r in only_main] == [main_tid]
    assert [r.thread_id for r in only_card] == [card_tid]


@pytest.mark.asyncio
async def test_list_threads_skips_archived_by_default(pool, user_ids):
    user_a, _ = user_ids
    visible = _main_thread_id(user_a)
    hidden = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=visible, kind="main")
        await repo.insert_thread(thread_id=hidden, kind="main")
        await conn.execute(
            "UPDATE pai_chat_threads SET archived = TRUE WHERE thread_id = %s",
            (hidden,),
        )

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        default_view = await repo.list_threads()
        full_view = await repo.list_threads(include_archived=True)
    assert {r.thread_id for r in default_view} == {visible}
    assert {r.thread_id for r in full_view} == {visible, hidden}


# ── bump_after_send ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bump_after_send_increments_count_and_timestamp(pool, user_ids):
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=tid, kind="main")
        # Force an old last_message_at so the bump is observable.
        await conn.execute(
            "UPDATE pai_chat_threads SET last_message_at = NOW() - INTERVAL '1 hour' "
            "WHERE thread_id = %s",
            (tid,),
        )
        await repo.bump_after_send(thread_id=tid)
        await repo.bump_after_send(thread_id=tid)

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatThreadsRepository(user_a, conn).list_threads()
    assert rows[0].message_count == 2
    # last_message_at should now be very recent (within last 60s).
    delta = (rows[0].last_message_at - rows[0].created_at).total_seconds()
    assert delta >= 0  # bumped to NOW()


@pytest.mark.asyncio
async def test_bump_after_send_silent_on_missing_row(pool, user_ids):
    """No-op when the thread isn't in the metadata table — chat already
    streamed and wrote LangGraph state, the metadata can be reconciled
    later. Don't 500 the response."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).bump_after_send(
            thread_id=f"main-{user_a}-nonexistent",
        )
    # No exception raised = pass.


# ── archive ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_archive_thread_soft_deletes(pool, user_ids):
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=tid, kind="main")
        archived_first = await repo.archive_thread(thread_id=tid)
        archived_second = await repo.archive_thread(thread_id=tid)

    assert archived_first is True
    assert archived_second is False  # already archived

    async with user_scoped_tx(pool, user_a) as conn:
        with_archived = await ChatThreadsRepository(
            user_a, conn,
        ).list_threads(include_archived=True)
    assert len(with_archived) == 1
    assert with_archived[0].archived is True


# ── update_title ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_update_title_sets_human_label(pool, user_ids):
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=tid, kind="main")
        await repo.update_title(thread_id=tid, title="Refactor planning")

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await ChatThreadsRepository(user_a, conn).list_threads()
    assert rows[0].title == "Refactor planning"


# ── RLS isolation between users ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rls_isolates_users(pool, user_ids):
    """user_a's threads are invisible to user_b. The whole point of RLS:
    even if app code accidentally borrows wrong user's repo, the policy
    prevents cross-tenant reads / writes."""
    user_a, user_b = user_ids
    a_thread = _main_thread_id(user_a)
    b_thread = _main_thread_id(user_b)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=a_thread, kind="main",
        )
    async with user_scoped_tx(pool, user_b) as conn:
        await ChatThreadsRepository(user_b, conn).insert_thread(
            thread_id=b_thread, kind="main",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        a_view = await ChatThreadsRepository(user_a, conn).list_threads()
    async with user_scoped_tx(pool, user_b) as conn:
        b_view = await ChatThreadsRepository(user_b, conn).list_threads()

    assert {r.thread_id for r in a_view} == {a_thread}
    assert {r.thread_id for r in b_view} == {b_thread}


@pytest.mark.asyncio
async def test_rls_blocks_cross_user_get_latest(pool, user_ids):
    """Even if user_b somehow knows user_a's thread_id, the latest-main
    lookup as user_b returns user_b's own state (or None), never user_a's."""
    user_a, user_b = user_ids
    a_thread = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=a_thread, kind="main",
        )

    async with user_scoped_tx(pool, user_b) as conn:
        b_latest = await ChatThreadsRepository(user_b, conn).get_latest_main_thread_id()
    assert b_latest is None
