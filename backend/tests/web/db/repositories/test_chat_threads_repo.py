"""ChatThreadsRepository — pai_chat_threads CRUD + RLS.

The metadata table that links a user to their LangGraph threads.
End-to-end correctness here is what makes "open Main Chat → resume
my latest conversation" work after localStorage gets cleared, or
on a fresh device.

v3 is main-chat-singleton: 053 migration enforces at most one *non-archived*
main thread per user (partial UNIQUE index idx_..._one_active_main_per_user).
Multi-thread management (list_threads / archive_thread / update_title /
per-thread title) was intentionally removed in 504ea6d9 along with its routes
tests; this surface is now insert + latest-main lookup + bump-after-send +
CHECK constraints + RLS. Assertions read rows with a direct SELECT
(_fetch_thread) since there's no list method anymore.

NOTE on RLS: the cross-user isolation test below is xfail — under the test
(and prod) connection role `postgres` (superuser), PostgreSQL bypasses RLS
entirely, so the policy can't be verified here. See
docs/plans/2026-06-08-rls-role-model. Isolation today relies on repos'
explicit WHERE user_id, which the other tests exercise.
"""

from __future__ import annotations

import uuid

import psycopg.errors
import pytest
from pinai_api.platform.db.repositories.chat_threads import ChatThreadsRepository
from pinai_db.rls import user_scoped_tx
from psycopg.rows import dict_row


def _main_thread_id(user_id: int) -> str:
    return f"main-{user_id}-{uuid.uuid4().hex[:12]}"


def _card_thread_id(card_id: str) -> str:
    return f"card-thread-{card_id}"


async def _fetch_thread(conn, thread_id: str):
    """Direct row read — replaces the removed list_threads() for assertions.

    Runs inside the caller's user_scoped_tx. Note: under a superuser
    connection RLS is bypassed, so this does NOT enforce cross-user
    isolation on its own (see module docstring)."""
    async with conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "SELECT thread_id, kind, card_id, archived, message_count, "
            "last_message_at, created_at FROM pai_chat_threads WHERE thread_id = %s",
            (thread_id,),
        )
        return await cur.fetchone()


# ── insert + idempotency ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_insert_thread_persists_row(pool, user_ids):
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=tid,
            kind="main",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        row = await _fetch_thread(conn, tid)
    assert row is not None
    assert row["thread_id"] == tid
    assert row["kind"] == "main"
    assert row["archived"] is False
    assert row["message_count"] == 0


@pytest.mark.asyncio
async def test_insert_thread_idempotent_on_conflict(pool, user_ids):
    """ON CONFLICT DO NOTHING: re-firing init for the same sessionKey
    is a no-op, doesn't 500."""
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=tid, kind="main")
        await repo.insert_thread(thread_id=tid, kind="main")  # second is a no-op

    async with user_scoped_tx(pool, user_a) as conn, conn.cursor(row_factory=dict_row) as cur:
        await cur.execute(
            "SELECT count(*) AS n FROM pai_chat_threads WHERE thread_id = %s",
            (tid,),
        )
        count_row = await cur.fetchone()
    assert count_row["n"] == 1


# ── card threads + CHECK constraint ────────────────────────────────────────


@pytest.mark.asyncio
async def test_insert_card_thread_with_card_id(pool, user_ids):
    user_a, _ = user_ids
    card_id = "gen.run123.cardA_card_00"
    tid = _card_thread_id(card_id)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=tid,
            kind="card",
            card_id=card_id,
        )

    async with user_scoped_tx(pool, user_a) as conn:
        row = await _fetch_thread(conn, tid)
    assert row is not None
    assert row["kind"] == "card"
    assert row["card_id"] == card_id


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
                thread_id=bad_tid,
                kind="main",
            )
        assert "check" in str(exc.value).lower() or "constraint" in str(exc.value).lower()


@pytest.mark.asyncio
async def test_insert_rejects_card_thread_without_card_id(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            await ChatThreadsRepository(user_a, conn).insert_thread(
                thread_id="card-thread-xyz",
                kind="card",
                card_id=None,
            )


@pytest.mark.asyncio
async def test_insert_rejects_card_thread_id_card_id_mismatch(pool, user_ids):
    """thread_id MUST equal 'card-thread-' || card_id; mismatched values
    are rejected by the CHECK."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            await ChatThreadsRepository(user_a, conn).insert_thread(
                thread_id="card-thread-foo",
                kind="card",
                card_id="bar",
            )


# ── get_latest_main_thread_id (singleton: one active main per user) ─────────


@pytest.mark.asyncio
async def test_latest_main_returns_none_when_user_has_nothing(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        result = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert result is None


@pytest.mark.asyncio
async def test_latest_main_returns_the_active_main(pool, user_ids):
    user_a, _ = user_ids
    tid = _main_thread_id(user_a)
    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(thread_id=tid, kind="main")

    async with user_scoped_tx(pool, user_a) as conn:
        latest = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert latest == tid


@pytest.mark.asyncio
async def test_latest_main_skips_archived(pool, user_ids):
    """get_latest filters archived = FALSE. 053 allows at most one *active*
    main, so archive the first before inserting the replacement."""
    user_a, _ = user_ids
    archived = _main_thread_id(user_a)
    active = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        repo = ChatThreadsRepository(user_a, conn)
        await repo.insert_thread(thread_id=archived, kind="main")
        # Archive BEFORE inserting the replacement — the partial UNIQUE index
        # only permits one non-archived main per user.
        await conn.execute(
            "UPDATE pai_chat_threads SET archived = TRUE, message_count = 999 WHERE thread_id = %s",
            (archived,),
        )
        await repo.insert_thread(thread_id=active, kind="main")

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
            thread_id=card_tid,
            kind="card",
            card_id="only_card",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        latest = await ChatThreadsRepository(user_a, conn).get_latest_main_thread_id()
    assert latest is None


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
        row = await _fetch_thread(conn, tid)
    assert row["message_count"] == 2
    # last_message_at should now be at/after created_at (bumped to NOW()).
    delta = (row["last_message_at"] - row["created_at"]).total_seconds()
    assert delta >= 0


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


# ── RLS isolation between users ────────────────────────────────────────────


@pytest.mark.xfail(
    reason="RLS not enforced under the postgres superuser connection used by "
    "tests/prod (user_scoped_tx doesn't SET ROLE; no FORCE RLS). Cross-user "
    "isolation can't be verified until the role model is fixed — see "
    "docs/plans/2026-06-08-rls-role-model. Isolation today relies on repos' "
    "explicit WHERE user_id (exercised by the other tests).",
    strict=False,
)
@pytest.mark.asyncio
async def test_rls_isolates_users(pool, user_ids):
    """user_a's threads should be invisible to user_b via RLS. This is the
    one test that depends on RLS (it reads without an explicit user_id
    filter), so it xfails while RLS is bypassed by superuser."""
    user_a, user_b = user_ids
    a_thread = _main_thread_id(user_a)
    b_thread = _main_thread_id(user_b)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=a_thread,
            kind="main",
        )
    async with user_scoped_tx(pool, user_b) as conn:
        await ChatThreadsRepository(user_b, conn).insert_thread(
            thread_id=b_thread,
            kind="main",
        )

    async with user_scoped_tx(pool, user_a) as conn:
        assert await _fetch_thread(conn, a_thread) is not None
        assert await _fetch_thread(conn, b_thread) is None
    async with user_scoped_tx(pool, user_b) as conn:
        assert await _fetch_thread(conn, b_thread) is not None
        assert await _fetch_thread(conn, a_thread) is None


@pytest.mark.asyncio
async def test_rls_blocks_cross_user_get_latest(pool, user_ids):
    """user_b's latest-main lookup never returns user_a's thread. This holds
    even with RLS bypassed because get_latest filters WHERE user_id = self."""
    user_a, user_b = user_ids
    a_thread = _main_thread_id(user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        await ChatThreadsRepository(user_a, conn).insert_thread(
            thread_id=a_thread,
            kind="main",
        )

    async with user_scoped_tx(pool, user_b) as conn:
        b_latest = await ChatThreadsRepository(user_b, conn).get_latest_main_thread_id()
    assert b_latest is None
