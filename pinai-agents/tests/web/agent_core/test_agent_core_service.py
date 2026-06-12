"""AgentRunService.cancel terminal-frame semantics.

A run parked on awaiting_input (HITL pause) has NO in-flight relay on any
instance — the usual emitter (worker._mark_cancelled) never runs, so the
service must publish the terminal frame itself or another device tailing the
session's SSE keeps its approval card until a poll. A 'running' run stays the
relay holder's job — the service must NOT publish for it (double-frame).
"""

from __future__ import annotations

import uuid

import pytest

from pinai_agents.web.agent_core.framebus import Frame
from pinai_agents.web.agent_core.runs import RunRepository
from pinai_agents.web.agent_core.service import AgentRunService
from pinai_agents.web.agent_core.sessions import SessionRepository
from pinai_agents.web.db.rls import user_scoped_tx


class _FakeFrameBus:
    def __init__(self) -> None:
        self.published: list[tuple[str, Frame]] = []

    async def publish(self, session_id: str, frame: Frame) -> None:
        self.published.append((session_id, frame))


def _sid() -> str:
    return f"card-thread-svc-{uuid.uuid4().hex[:8]}"


@pytest.mark.asyncio
async def test_cancel_awaiting_run_publishes_terminal_frame(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    bus = _FakeFrameBus()
    service = AgentRunService(pool, bus)  # type: ignore[arg-type]
    async with user_scoped_tx(pool, user_a) as conn:
        await SessionRepository(user_a, conn).ensure_session(
            session_id=sid, agent_kind="card_execution"
        )
        r = RunRepository(user_a, conn)
        rid = await r.create(session_id=sid, agent_kind="card_execution", trigger="user")
        await r.set_awaiting(run_id=rid, pending_action={"interrupt_id": "i1"})

    await service.cancel(sid, user_id=user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        run = await RunRepository(user_a, conn).get(run_id=rid)
    assert run is not None and run.status == "cancelled"
    # Cancel is a clean close for the consumer — chat:done only, no chat:error.
    assert [(s, f["type"]) for s, f in bus.published] == [(sid, "chat:done")]
    assert bus.published[0][1]["traceId"] == rid


@pytest.mark.asyncio
async def test_cancel_running_run_leaves_frames_to_the_relay_holder(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    bus = _FakeFrameBus()
    service = AgentRunService(pool, bus)  # type: ignore[arg-type]
    async with user_scoped_tx(pool, user_a) as conn:
        await SessionRepository(user_a, conn).ensure_session(
            session_id=sid, agent_kind="card_execution"
        )
        rid = await RunRepository(user_a, conn).create(
            session_id=sid, agent_kind="card_execution", trigger="user"
        )

    await service.cancel(sid, user_id=user_a)

    async with user_scoped_tx(pool, user_a) as conn:
        run = await RunRepository(user_a, conn).get(run_id=rid)
    # DB mark happens either way; the in-flight relay's _mark_cancelled owns
    # the frame (here nobody holds it, but the service can't tell a live
    # holder from a crashed one — only parked statuses are provably orphan).
    assert run is not None and run.status == "cancelled"
    assert bus.published == []


@pytest.mark.asyncio
async def test_cancel_before_run_row_consumes_pending_messages(pool, user_ids):
    """Stop 赶在 run 行创建前(消息已 enqueue、worker 未 drain):取消必须
    消费 pending 消息,否则 worker 之后照常起跑、用户的取消被静默吞掉。
    user_interrupt(双发)保持旧语义——旧 pending 并入新消息的 turn。"""
    from pinai_agents.web.agent_core.mailbox import MailboxRepository

    user_a, _ = user_ids
    bus = _FakeFrameBus()
    service = AgentRunService(pool, bus)  # type: ignore[arg-type]

    # user_cancel:pending 被消费,worker 无可跑。
    sid = _sid()
    await service.post_message(
        sid, user_id=user_a, agent_kind="main_chat", source="user", content="hello"
    )
    await service.cancel(sid, user_id=user_a)
    async with user_scoped_tx(pool, user_a) as conn:
        assert await MailboxRepository(user_a, conn).claim_pending(session_id=sid) == []
    assert bus.published == []  # 没有 run,无帧可发

    # user_interrupt:pending 保留(将与新消息合并成一个 turn)。
    sid2 = _sid()
    await service.post_message(
        sid2, user_id=user_a, agent_kind="main_chat", source="user", content="first"
    )
    await service.cancel(sid2, user_id=user_a, reason="user_interrupt")
    async with user_scoped_tx(pool, user_a) as conn:
        remaining = await MailboxRepository(user_a, conn).claim_pending(session_id=sid2)
    assert [m.content for m in remaining] == ["first"]


@pytest.mark.asyncio
async def test_interrupt_cancels_active_run_and_enqueues_new_message_identity(pool, user_ids):
    """Force-send: cancel the active run and put the user's chosen queued
    message at the front door with its clientMsgId so retries stay idempotent."""

    from pinai_agents.web.agent_core.mailbox import MailboxRepository

    user_a, _ = user_ids
    sid = _sid()
    bus = _FakeFrameBus()
    service = AgentRunService(pool, bus)  # type: ignore[arg-type]
    async with user_scoped_tx(pool, user_a) as conn:
        await SessionRepository(user_a, conn).ensure_session(session_id=sid, agent_kind="main_chat")
        rid = await RunRepository(user_a, conn).create(
            session_id=sid, agent_kind="main_chat", trigger="user"
        )

    await service.interrupt(
        sid,
        user_id=user_a,
        agent_kind="main_chat",
        new_message="urgent follow-up",
        idempotency_key="queued-urgent",
    )

    async with user_scoped_tx(pool, user_a) as conn:
        run = await RunRepository(user_a, conn).get(run_id=rid)
        pending = await MailboxRepository(user_a, conn).claim_pending(session_id=sid)

    assert run is not None and run.status == "cancelled"
    assert [(m.content, m.idempotency_key) for m in pending] == [
        ("urgent follow-up", "queued-urgent")
    ]
