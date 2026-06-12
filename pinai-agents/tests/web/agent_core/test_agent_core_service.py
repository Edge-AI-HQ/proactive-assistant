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
