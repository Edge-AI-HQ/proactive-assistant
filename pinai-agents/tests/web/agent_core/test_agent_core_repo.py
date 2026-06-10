"""Agent Core repos — the invariants the worker relies on.

Mirrors tests/web/db/repositories/test_proactive_repo.py. Pins:
  * per-session lease serializes one owner; fencing refresh detects steal.
  * release_lease_if_empty respects pending (enqueue-vs-release race).
  * claim_pending MERGES all pending (the multi-message-one-run model);
    idempotency_key dedupes re-delivery.
  * run lifecycle + awaiting_input/resume (HITL).
  * scan_actionable_sessions / reap_stale_runs (worker fallback + recovery).
"""

from __future__ import annotations

import uuid

import pytest

from pinai_agents.web.agent_core.mailbox import MailboxRepository
from pinai_agents.web.agent_core.runs import RunRepository, reap_stale_runs
from pinai_agents.web.agent_core.sessions import (
    SessionRepository,
    scan_actionable_sessions,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx


def _sid() -> str:
    return f"main-test-{uuid.uuid4().hex[:8]}"


@pytest.mark.asyncio
async def test_lease_serializes_per_session(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    o1, o2 = uuid.uuid4().hex, uuid.uuid4().hex
    async with user_scoped_tx(pool, user_a) as conn:
        s = SessionRepository(user_a, conn)
        await s.ensure_session(session_id=sid, agent_kind="main_chat")
        assert await s.acquire_lease(session_id=sid, owner=o1, ttl_seconds=60)
        # a second owner can't steal a live lease
        assert not await s.acquire_lease(session_id=sid, owner=o2, ttl_seconds=60)
        # fencing: owner can refresh; a non-owner refresh fails (steal detection)
        assert await s.refresh_lease(session_id=sid, owner=o1, ttl_seconds=60)
        assert not await s.refresh_lease(session_id=sid, owner=o2, ttl_seconds=60)


@pytest.mark.asyncio
async def test_release_if_empty_respects_pending(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    owner = uuid.uuid4().hex
    async with user_scoped_tx(pool, user_a) as conn:
        s = SessionRepository(user_a, conn)
        m = MailboxRepository(user_a, conn)
        await s.ensure_session(session_id=sid, agent_kind="main_chat")
        assert await s.acquire_lease(session_id=sid, owner=owner, ttl_seconds=60)
        await m.enqueue(session_id=sid, source="user", content="hi")
        # pending exists → cannot release
        assert not await s.release_lease_if_empty(session_id=sid, owner=owner)
        # consume, then release succeeds
        msgs = await m.claim_pending(session_id=sid)
        await m.mark_consumed(message_ids=[x.id for x in msgs], run_id=str(uuid.uuid4()))
        assert await s.release_lease_if_empty(session_id=sid, owner=owner)


@pytest.mark.asyncio
async def test_mailbox_merge_and_idempotency(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        s = SessionRepository(user_a, conn)
        m = MailboxRepository(user_a, conn)
        await s.ensure_session(session_id=sid, agent_kind="main_chat")
        await m.enqueue(session_id=sid, source="user", content="a")
        await m.enqueue(session_id=sid, source="user", content="b")
        # idempotency: same key dedupes (second returns None)
        assert (
            await m.enqueue(session_id=sid, source="user", content="c", idempotency_key="k1")
            is not None
        )
        assert (
            await m.enqueue(session_id=sid, source="user", content="c", idempotency_key="k1")
            is None
        )
        # claim_pending MERGES all pending, FIFO; each message carries its
        # idempotency_key (the FE's client message id) for history stamping.
        msgs = await m.claim_pending(session_id=sid)
        assert [x.content for x in msgs] == ["a", "b", "c"]
        assert [x.idempotency_key for x in msgs] == [None, None, "k1"]
        # after consume, nothing pending
        await m.mark_consumed(message_ids=[x.id for x in msgs], run_id=str(uuid.uuid4()))
        assert await m.claim_pending(session_id=sid) == []


@pytest.mark.asyncio
async def test_run_lifecycle_and_hitl(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        r = RunRepository(user_a, conn)
        rid = await r.create(session_id=sid, agent_kind="main_chat", trigger="user")
        run = await r.get(run_id=rid)
        assert run is not None and run.status == "running"
        # HITL pause
        await r.set_awaiting(
            run_id=rid, pending_action={"tool_use_id": "t1", "tool_name": "send_email"}
        )
        aw = await r.get_awaiting(session_id=sid)
        assert aw is not None and aw.id == rid and aw.stop_reason == "requires_action"
        assert aw.pending_action == {"tool_use_id": "t1", "tool_name": "send_email"}
        # resume → complete
        await r.resume_running(run_id=rid)
        await r.complete(run_id=rid, result={"ok": True})
        done = await r.get(run_id=rid)
        assert done is not None and done.status == "succeeded" and done.result == {"ok": True}


@pytest.mark.asyncio
async def test_scan_and_reap(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        s = SessionRepository(user_a, conn)
        m = MailboxRepository(user_a, conn)
        await s.ensure_session(session_id=sid, agent_kind="main_chat")
        await m.enqueue(session_id=sid, source="user", content="hi")
    # scan (service_tx, cross-user) surfaces the actionable session
    async with service_tx(pool) as conn:
        found = await scan_actionable_sessions(conn, limit=100)
    assert any(s_id == sid and u == user_a for s_id, u in found)
    # reap: a running run with ttl=-1 (any running counts as stale) → failed
    async with user_scoped_tx(pool, user_a) as conn:
        rid = await RunRepository(user_a, conn).create(
            session_id=sid, agent_kind="main_chat", trigger="user"
        )
    async with service_tx(pool) as conn:
        reaped = await reap_stale_runs(conn, ttl_seconds=-1, limit=100)
    assert reaped >= 1
    async with user_scoped_tx(pool, user_a) as conn:
        run = await RunRepository(user_a, conn).get(run_id=rid)
    assert run is not None and run.status == "failed"


@pytest.mark.asyncio
async def test_get_active_and_partial_parts(pool, user_ids):
    """get_active (cancel's target) returns the session's non-terminal run;
    None once terminal. pending_action round-trips partial_parts (CC1 — the
    pre-pause assistant parts a resume prepends)."""
    user_a, _ = user_ids
    sid = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        r = RunRepository(user_a, conn)
        rid = await r.create(session_id=sid, agent_kind="main_chat", trigger="user")
        active = await r.get_active(session_id=sid)
        assert active is not None and active.id == rid
        # awaiting with partial_parts round-trips through pending_action (CC1)
        await r.set_awaiting(
            run_id=rid,
            pending_action={
                "interrupt_id": "i1",
                "partial_parts": [{"type": "text", "text": "thinking..."}],
            },
        )
        active2 = await r.get_active(session_id=sid)
        assert active2 is not None and active2.pending_action is not None
        assert active2.pending_action["partial_parts"] == [{"type": "text", "text": "thinking..."}]
        # terminal → no active run
        await r.resume_running(run_id=rid)
        await r.complete(run_id=rid, result={"ok": True})
        assert await r.get_active(session_id=sid) is None
