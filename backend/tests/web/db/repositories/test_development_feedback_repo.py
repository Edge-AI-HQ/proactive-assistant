from __future__ import annotations

import pytest
from pinai_api.domains.feedback.dev_repository import (
    AddDevelopmentFeedbackInput,
    DevelopmentFeedbackRepository,
)
from pinai_db.rls import user_scoped_tx

pytestmark = pytest.mark.asyncio


async def test_add_then_list_development_feedback(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevelopmentFeedbackRepository(user_a, conn)
        row = await repo.add(
            AddDevelopmentFeedbackInput(
                text="Can you add an export button to these cards?",
                summary="User wants an export button on cards.",
                category="ui",
                surface="main_chat",
                source="user",
                conversation_id="thread_main",
                message_id="msg_123",
                metadata={"requested_control": "export_button"},
            )
        )

        rows = await repo.list(status="new")

    assert row.id.startswith("df_")
    assert row.user_id == user_a
    assert row.supabase_user_id
    assert row.text == "Can you add an export button to these cards?"
    assert row.summary == "User wants an export button on cards."
    assert row.category == "ui"
    assert row.surface == "main_chat"
    assert row.status == "new"
    assert row.source == "user"
    assert row.conversation_id == "thread_main"
    assert row.message_id == "msg_123"
    assert row.metadata == {"requested_control": "export_button"}
    assert [r.id for r in rows] == [row.id]


async def test_update_status(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevelopmentFeedbackRepository(user_a, conn)
        row = await repo.add(
            AddDevelopmentFeedbackInput(
                text="Please support exporting cards.",
                category="feature",
                surface="main_chat",
                source="user",
            )
        )

        updated = await repo.update_status(row.id, "reviewed")
        rows = await repo.list(status="reviewed")

    assert updated is not None
    assert updated.id == row.id
    assert updated.status == "reviewed"
    assert [r.id for r in rows] == [row.id]


async def test_add_dedupes_same_development_feedback(pool, user_ids):
    user_a, _ = user_ids
    input = AddDevelopmentFeedbackInput(
        text="Can you add an export button to these cards?",
        category="ui",
        surface="main_chat",
        source="user",
        conversation_id="thread_main",
        message_id="msg_123",
    )
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevelopmentFeedbackRepository(user_a, conn)
        first = await repo.add(input)
        second = await repo.add(input)
        rows = await repo.list(status="new")

    assert second.id == first.id
    assert [r.id for r in rows] == [first.id]


async def test_rls_isolation_between_users(pool, user_ids):
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await DevelopmentFeedbackRepository(user_a, conn).add(
            AddDevelopmentFeedbackInput(
                text="Add a larger settings button.",
                category="ui",
                surface="settings",
                source="user",
            )
        )

    async with user_scoped_tx(pool, user_b) as conn:
        rows = await DevelopmentFeedbackRepository(user_b, conn).list(status="new")

    assert rows == []
