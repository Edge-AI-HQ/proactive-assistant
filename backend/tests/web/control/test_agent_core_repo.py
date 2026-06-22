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
from pinai_api.control.mailbox import MailboxRepository
from pinai_api.control.runs import RunRepository, reap_stale_runs
from pinai_api.control.sessions import (
    SessionRepository,
    scan_actionable_sessions,
)
from pinai_db.rls import service_tx, user_scoped_tx


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
async def test_mailbox_updates_and_deletes_only_unclaimed_user_messages(pool, user_ids):
    user_a, _ = user_ids
    sid = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        s = SessionRepository(user_a, conn)
        m = MailboxRepository(user_a, conn)
        await s.ensure_session(session_id=sid, agent_kind="main_chat")
        unlocked_id = await m.enqueue(
            session_id=sid,
            source="user",
            content="original",
            idempotency_key="queued-1",
        )
        assert unlocked_id is not None

        assert await m.update_pending_user_message(
            session_id=sid,
            client_msg_id="queued-1",
            content="edited",
        )
        edited = await m.claim_pending(session_id=sid)
        assert [x.content for x in edited] == ["edited"]

        deletable_id = await m.enqueue(
            session_id=sid,
            source="user",
            content="delete me",
            idempotency_key="queued-2",
        )
        assert deletable_id is not None
        assert await m.delete_pending_user_message(
            session_id=sid,
            client_msg_id="queued-2",
        )
        remaining = await m.claim_pending(session_id=sid)
        assert [x.idempotency_key for x in remaining] == ["queued-1"]

        locked_id = await m.enqueue(
            session_id=sid,
            source="user",
            content="already processing",
            idempotency_key="locked-1",
        )
        assert locked_id is not None
        await m.mark_claimed(message_ids=[locked_id], run_id=str(uuid.uuid4()))

        assert not await m.update_pending_user_message(
            session_id=sid,
            client_msg_id="locked-1",
            content="too late",
        )
        assert not await m.delete_pending_user_message(
            session_id=sid,
            client_msg_id="locked-1",
        )
        locked = [m for m in await m.claim_pending(session_id=sid) if m.id == locked_id][0]
        assert locked.content == "already processing"


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
        # Backdate started_at past any reap TTL: resume must reset it, or a
        # long human pause would get the resumed LIVE run reaped within a tick.
        await conn.execute(
            "UPDATE pai_agent_runs SET started_at = NOW() - INTERVAL '1 hour' WHERE id = %s",
            (rid,),
        )
        # resume → complete
        await r.resume_running(run_id=rid)
        cur = await conn.execute(
            "SELECT started_at > NOW() - INTERVAL '1 minute' AS fresh "
            "FROM pai_agent_runs WHERE id = %s",
            (rid,),
        )
        row = await cur.fetchone()
        assert row is not None and row["fresh"] is True
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
    # Returns (run_id, session_id, is_latest) triples so the reaper can
    # publish terminal frames; ttl=-1 may sweep other tests' runs too, so
    # check membership. This run is its session's only run → is_latest.
    assert (rid, sid, True) in reaped
    async with user_scoped_tx(pool, user_a) as conn:
        run = await RunRepository(user_a, conn).get(run_id=rid)
    assert run is not None and run.status == "failed"
    # A run whose session lease is HELD is alive (the relay keeps refreshing
    # it) — the reaper must skip it, or it would fail a live run and publish
    # phantom terminal frames into its stream.
    sid_live = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        s2 = SessionRepository(user_a, conn)
        await s2.ensure_session(session_id=sid_live, agent_kind="main_chat")
        assert await s2.acquire_lease(session_id=sid_live, owner="w1", ttl_seconds=600)
        rid_live = await RunRepository(user_a, conn).create(
            session_id=sid_live, agent_kind="main_chat", trigger="user"
        )
    async with service_tx(pool) as conn:
        reaped2 = await reap_stale_runs(conn, ttl_seconds=-1, limit=100)
    assert all(r_id != rid_live for r_id, _, _ in reaped2)
    async with user_scoped_tx(pool, user_a) as conn:
        live = await RunRepository(user_a, conn).get(run_id=rid_live)
    assert live is not None and live.status == "running"


@pytest.mark.asyncio
async def test_reap_marks_superseded_run_not_latest(pool, user_ids):
    """A crashed run whose messages were already replayed by a newer run on
    the same session must come back is_latest=False — the reaper still fails
    the row (DB truth) but must NOT publish terminal frames, or the live
    stream gets a ghost '_Error: run lease expired_' bubble minutes after the
    replay's real answer."""
    user_a, _ = user_ids
    sid = _sid()
    async with user_scoped_tx(pool, user_a) as conn:
        await SessionRepository(user_a, conn).ensure_session(session_id=sid, agent_kind="main_chat")
        rid_crashed = await RunRepository(user_a, conn).create(
            session_id=sid, agent_kind="main_chat", trigger="user"
        )
    # The replay: a newer run on the same session that finished cleanly.
    # Separate transaction — created_at defaults to the tx timestamp, and the
    # is_latest comparison needs the replay to be strictly newer.
    async with user_scoped_tx(pool, user_a) as conn:
        r = RunRepository(user_a, conn)
        rid_replay = await r.create(session_id=sid, agent_kind="main_chat", trigger="user")
        await r.complete(run_id=rid_replay)
    async with service_tx(pool) as conn:
        reaped = await reap_stale_runs(conn, ttl_seconds=-1, limit=100)
    assert (rid_crashed, sid, False) in reaped
    async with user_scoped_tx(pool, user_a) as conn:
        crashed = await RunRepository(user_a, conn).get(run_id=rid_crashed)
        replay = await RunRepository(user_a, conn).get(run_id=rid_replay)
    assert crashed is not None and crashed.status == "failed"
    assert replay is not None and replay.status == "succeeded"


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
