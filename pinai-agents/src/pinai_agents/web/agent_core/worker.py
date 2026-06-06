"""AgentRunWorker — the single drain loop behind every conversational agent.

Generalizes proactive_loop's per-thread lease + drain + cross-instance cancel
to all sessions (plan §十). Runs inside the web process lifespan (no third
process — plan §十一). For each session it: acquires the drain lease, merges
all pending mailbox messages into one turn, creates a Run, drives the chat
worker via ChatRunClient, fans frames out (FrameBus) + records them
(ChatTurnRecorder → pai_chat_messages), then releases the lease.

Correctness rests on the interval poll (scan_actionable_sessions); the bus
wake is only a latency optimization (plan §十一 "worker 正确性靠轮询"). A
crashed drain leaves its messages pending (replayed) and its run row reaped.

Executes via chat's /agent/chat: merged mailbox messages go as separate
role=user turns (CORE-0, no concatenation); a HITL interrupt pauses the run
(awaiting_input) and a tool decision resumes it via Command(resume=) on the
same thread (CORE-4). A dedicated /agent/run with per-kind routing is RC-4.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..db.repositories.chat_messages import ChatMessagesRepository, Role, Trigger
from ..db.rls import service_tx, user_scoped_tx
from ..services.chat_turn_recorder import ChatTurnRecorder
from .bus import AgentBus, notify_run_status
from .client import ChatRunClient, ChatRunError
from .framebus import Frame, FrameBus
from .mailbox import MailboxRepository, Message
from .runs import Run, RunRepository, reap_stale_runs
from .sessions import (
    SessionRepository,
    lookup_session,
    scan_actionable_sessions,
)

logger = logging.getLogger(__name__)

# Lease must outlast one agent turn (chat read timeout 600s) plus margin; the
# relay refreshes it periodically (fencing) so a long turn never lets a second
# worker in.
_LEASE_TTL = 900
_POLL_INTERVAL = 5  # interval-fallback scan cadence (correctness backstop)
_REAPER_INTERVAL = 60
_RUN_STALE_TTL = 1200  # a `running` run untouched this long → reaped (crash)
_REFRESH_EVERY = 50  # frames between fencing lease refreshes during relay

# CORE-4: chat translates langgraph __interrupt__ into this frame type. Until
# then chat never emits it, so the awaiting branch below stays dormant.
_EV_REQUIRES_ACTION = "chat:requires_action"

# source priority for the run's recorded trigger when a merge mixes sources.
_TRIGGER_PRIORITY = (
    "user",
    "tool_decision",
    "cron",
    "system_event",
    "heartbeat",
)


@dataclass(slots=True)
class _Inflight:
    """A running drain task, registered so a cancel signal can find and abort
    exactly this turn. Per-process: a cancel that lands on another instance
    no-ops (the holder gets it via the cross-instance NOTIFY)."""

    task: asyncio.Task[None]
    cancelled_by_user: bool = field(default=False)


def _pick_trigger(msgs: list[Message]) -> str:
    sources = {m.source for m in msgs}
    for src in _TRIGGER_PRIORITY:
        if src in sources:
            return src
    return msgs[0].source if msgs else "user"


def _find_decision_message(msgs: list[Message], awaiting: Run) -> Message | None:
    """The tool_decision message matching this awaiting run's interrupt, if
    any (matched on interrupt_id; idempotency_key already dedupes re-taps).
    A missing interrupt_id (CC18, shouldn't happen) matches NOTHING — matching
    an arbitrary decision would resume against the wrong tool."""
    pending = awaiting.pending_action or {}
    interrupt_id = pending.get("interrupt_id")
    if not interrupt_id:
        return None
    for m in msgs:
        if m.source != "tool_decision":
            continue
        if (m.meta or {}).get("tool_use_id") == interrupt_id:
            return m
    return None


def _decisions_from(decision_msg: Message) -> list[dict[str, Any]]:
    """Build HumanInTheLoopMiddleware resume decisions from a decision message
    (CORE-4: single action → one decision). reject carries the user's message
    back to the model; approve / edit / respond pass through their type."""
    meta = decision_msg.meta or {}
    decision = str(meta.get("decision") or "reject")
    out: dict[str, Any] = {"type": decision}
    if decision == "reject" and decision_msg.content:
        out["message"] = decision_msg.content
    return [out]


def _input_rows(msgs: list[Message]) -> list[tuple[Role, str]]:
    """Persisted input rows for a turn, split by source so a heartbeat tick lands
    as a debug-only role='heartbeat' row and a real user message as role='user'.
    Skips empty content (e.g. a bare resume signal). Shared by the clean-finish
    and HITL-pause paths so a heartbeat input gets the SAME role no matter which
    path records it (otherwise a proactive tick that paused on a side-effect tool
    would land as role='user' and leak past the include_debug filter)."""
    rows: list[tuple[Role, str]] = []
    for m in msgs:
        if not m.content:
            continue
        rows.append(("heartbeat" if m.source == "heartbeat" else "user", m.content))
    return rows


class AgentRunWorker:
    def __init__(
        self,
        pool: AsyncConnectionPool,
        framebus: FrameBus,
        bus: AgentBus,
        chat_client: ChatRunClient,
    ) -> None:
        self._pool = pool
        self._framebus = framebus
        self._bus = bus
        self._chat = chat_client
        self._interval_task: asyncio.Task[None] | None = None
        self._reaper_task: asyncio.Task[None] | None = None
        self._inflight: dict[str, _Inflight] = {}

    # ── lifecycle ────────────────────────────────────────────────────
    async def start(self) -> None:
        await self._bus.start(self._pool, on_wake=self._on_wake, on_cancel=self._on_cancel)
        self._interval_task = asyncio.create_task(
            self._interval_loop(), name="agent-worker-interval"
        )
        self._reaper_task = asyncio.create_task(self._reaper_loop(), name="agent-worker-reaper")

    async def stop(self) -> None:
        for t in (self._interval_task, self._reaper_task):
            if t is not None:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await t
        for inf in list(self._inflight.values()):
            inf.task.cancel()
        await self._bus.stop()

    # ── signal handlers (called from the bus LISTEN loop) ─────────────
    def _on_wake(self, session_id: str) -> None:
        self._schedule_drain(session_id)

    def _on_cancel(self, session_id: str) -> None:
        inf = self._inflight.get(session_id)
        if inf is not None:
            inf.cancelled_by_user = True
            inf.task.cancel()

    def _schedule_drain(self, session_id: str) -> None:
        """Fire-and-forget a drain. Deduped per session: an in-flight drain
        loops over newly-arrived messages itself, so a duplicate wake is a
        no-op (and the lease would reject it anyway). A wake that races the
        drain's exit is caught by the next interval scan."""
        if session_id in self._inflight:
            return
        task = asyncio.create_task(
            self._drain_session(session_id), name=f"agent-drain-{session_id}"
        )
        self._inflight[session_id] = _Inflight(task=task)
        task.add_done_callback(lambda _: self._inflight.pop(session_id, None))

    # ── interval fallback + reaper ────────────────────────────────────
    async def _interval_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(_POLL_INTERVAL)
                async with service_tx(self._pool) as conn:
                    actionable = await scan_actionable_sessions(conn, limit=50)
                for session_id, _user_id in actionable:
                    self._schedule_drain(session_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("agent worker interval scan failed")

    async def _reaper_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(_REAPER_INTERVAL)
                async with service_tx(self._pool) as conn:
                    n = await reap_stale_runs(conn, ttl_seconds=_RUN_STALE_TTL, limit=100)
                if n:
                    logger.info("agent worker reaped %d stale run(s)", n)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("agent worker reaper failed")

    # ── drain ─────────────────────────────────────────────────────────
    async def _drain_session(self, session_id: str) -> None:
        async with service_tx(self._pool) as conn:
            found = await lookup_session(conn, session_id=session_id)
        if found is None:
            return
        user_id, agent_kind = found
        owner = uuid.uuid4().hex
        async with user_scoped_tx(self._pool, user_id) as conn:
            won = await SessionRepository(user_id, conn).acquire_lease(
                session_id=session_id, owner=owner, ttl_seconds=_LEASE_TTL
            )
        if not won:
            return  # another worker holds this session's lease
        try:
            await self._drain_loop(session_id, user_id, agent_kind, owner)
        finally:
            async with user_scoped_tx(self._pool, user_id) as conn:
                await SessionRepository(user_id, conn).release_lease(
                    session_id=session_id, owner=owner
                )

    async def _drain_loop(self, session_id: str, user_id: int, agent_kind: str, owner: str) -> None:
        while True:
            async with user_scoped_tx(self._pool, user_id) as conn:
                if not await SessionRepository(user_id, conn).refresh_lease(
                    session_id=session_id, owner=owner, ttl_seconds=_LEASE_TTL
                ):
                    logger.warning("lease stolen mid-drain session=%s", session_id)
                    return
                awaiting = await RunRepository(user_id, conn).get_awaiting(session_id=session_id)
                msgs = await MailboxRepository(user_id, conn).claim_pending(session_id=session_id)
            if awaiting is not None:
                # HITL: the run is paused on a tool decision. Resume if a
                # matching decision message arrived; else keep paused —
                # non-decision messages stay queued (serial: no new run while
                # awaiting approval), lease releases in finally.
                decision_msg = _find_decision_message(msgs, awaiting)
                if decision_msg is None:
                    return
                await self._resume_run(
                    session_id, user_id, agent_kind, owner, awaiting, decision_msg
                )
                continue  # drain anything that arrived during the resume
            # No awaiting run: a tool_decision here is stale (its run already
            # resolved / was cancelled). Consume + drop it (CC14) — never feed
            # a decision as a user turn.
            stale = [m for m in msgs if m.source == "tool_decision"]
            if stale:
                async with user_scoped_tx(self._pool, user_id) as conn:
                    await MailboxRepository(user_id, conn).mark_consumed(
                        message_ids=[m.id for m in stale], run_id=None
                    )
                msgs = [m for m in msgs if m.source != "tool_decision"]
            if not msgs:
                async with user_scoped_tx(self._pool, user_id) as conn:
                    if await SessionRepository(user_id, conn).release_lease_if_empty(
                        session_id=session_id, owner=owner
                    ):
                        return
                continue  # a message arrived between the check and release
            await self._run_once(session_id, user_id, agent_kind, owner, msgs)

    async def _run_once(
        self,
        session_id: str,
        user_id: int,
        agent_kind: str,
        owner: str,
        msgs: list[Message],
    ) -> None:
        # merge: each pending user message stays its OWN message — forwarded as
        # separate role=user turns (CORE-0 verified the LLM accepts consecutive
        # user messages), NOT concatenated.
        user_texts = [m.content for m in msgs if m.content]
        trigger = _pick_trigger(msgs)
        msg_ids = [m.id for m in msgs]
        # card_execution / feedback turns carry the card JSON in message meta
        # (set by the route). chat injects it as a <card_context> SystemMessage
        # on the turn — take the first one in the merged batch.
        card_context = next(
            (m.meta["card_context"] for m in msgs if m.meta and m.meta.get("card_context")),
            None,
        )
        # regenerate (Retry / Edit): a lone message flagged in meta re-runs the
        # last turn — chat pops the trailing AI/Tool from the checkpoint + reruns,
        # and _finalize_turn mirrors that on pai_chat_messages (pop + rewrite).
        # Only honored for a single message; a merged batch is a normal turn.
        regenerate = len(msgs) == 1 and bool((msgs[0].meta or {}).get("regenerate"))

        async with user_scoped_tx(self._pool, user_id) as conn:
            run_id = await RunRepository(user_id, conn).create(
                session_id=session_id, agent_kind=agent_kind, trigger=trigger
            )
        # proactive: surface each heartbeat input to the FE (it has no copy —
        # the user's own messages it already shows). plan §十七.
        if agent_kind == "proactive":
            await self._publish_proactive_ticks(session_id, run_id, msgs)
        vk, bbctx = await self._user_keys(user_id)
        frames = self._chat.run(
            kind=agent_kind,
            session_id=session_id,
            user_id=user_id,
            messages=user_texts,
            virtual_key=vk,
            browserbase_context_id=bbctx,
            card_context=card_context,
            regenerate=regenerate,
            run_id=run_id,
        )
        try:
            recorder, outcome = await self._relay_frames(
                session_id=session_id, user_id=user_id, owner=owner, run_id=run_id, frames=frames
            )
        except asyncio.CancelledError:
            await self._mark_cancelled(session_id, user_id, run_id, msg_ids)
            raise
        except ChatRunError as e:
            await self._fail(session_id, user_id, run_id, msg_ids, str(e))
            return
        if outcome == "stolen":
            return  # reaper fails the orphaned run
        if outcome == "awaiting":
            # The input turn(s) were already fed to the now-paused agent — record
            # them + consume the batch. The assistant turn lands on resume; the
            # run row stays awaiting_input (set inside _relay_frames). Pass msgs
            # (not user_texts) so a paused proactive tick records its heartbeat
            # input as role='heartbeat', same as the clean-finish path.
            await self._persist_user_turns(session_id, user_id, run_id, msg_ids, msgs)
            return
        if agent_kind == "proactive":
            await self._proactive_finalize(session_id, user_id, run_id, msg_ids, msgs, recorder)
        else:
            await self._finalize_turn(
                session_id, user_id, run_id, msg_ids, user_texts, recorder, regenerate=regenerate
            )

    async def _resume_run(
        self,
        session_id: str,
        user_id: int,
        agent_kind: str,
        owner: str,
        awaiting: Run,
        decision_msg: Message,
    ) -> None:
        """HITL resume: re-enter the paused run with the human's decision
        (Command(resume=) on the same thread). The user turn was recorded when
        the run first paused, so a clean finish records only the assistant turn.
        Consumes the decision message."""
        decisions = _decisions_from(decision_msg)
        dmsg_ids = [decision_msg.id]
        async with user_scoped_tx(self._pool, user_id) as conn:
            await RunRepository(user_id, conn).resume_running(run_id=awaiting.id)
        vk, bbctx = await self._user_keys(user_id)
        frames = self._chat.resume(
            kind=agent_kind,
            session_id=session_id,
            user_id=user_id,
            decisions=decisions,
            virtual_key=vk,
            browserbase_context_id=bbctx,
            run_id=awaiting.id,
        )
        try:
            recorder, outcome = await self._relay_frames(
                session_id=session_id,
                user_id=user_id,
                owner=owner,
                run_id=awaiting.id,
                frames=frames,
            )
        except asyncio.CancelledError:
            await self._mark_cancelled(session_id, user_id, awaiting.id, dmsg_ids)
            raise
        except ChatRunError as e:
            await self._fail(session_id, user_id, awaiting.id, dmsg_ids, str(e))
            return
        if outcome == "stolen":
            return
        if outcome == "awaiting":
            # Multi-step approval: another interrupt fired. Consume this
            # decision; the new pending_action is already set; stay paused.
            async with user_scoped_tx(self._pool, user_id) as conn:
                await MailboxRepository(user_id, conn).mark_consumed(
                    message_ids=dmsg_ids, run_id=awaiting.id
                )
            return
        # done: record the assistant turn — prepend the pre-pause parts (CC1)
        # to what resume streamed; the user turn was recorded at pause. Consume
        # the decision, complete the run.
        partial = (awaiting.pending_action or {}).get("partial_parts") or []
        await self._finalize_turn(
            session_id, user_id, awaiting.id, dmsg_ids, [], recorder, partial_parts=partial
        )

    async def _relay_frames(
        self,
        *,
        session_id: str,
        user_id: int,
        owner: str,
        run_id: str,
        frames: AsyncIterator[Frame],
    ) -> tuple[ChatTurnRecorder, str]:
        """Relay one execution's frame stream: publish (FrameBus) + record
        (history) + periodic fencing refresh + detect a HITL pause. Returns
        (recorder, outcome) where outcome is 'done' | 'awaiting' | 'stolen' —
        the caller writes terminal DB state. On requires_action it captures the
        run's pending_action here (so the frame isn't lost) + returns
        'awaiting'."""
        recorder = ChatTurnRecorder()
        count = 0
        async for frame in frames:
            await self._framebus.publish(session_id, frame)
            recorder.consume_event(frame)
            count += 1
            if count % _REFRESH_EVERY == 0:
                async with user_scoped_tx(self._pool, user_id) as conn:
                    if not await SessionRepository(user_id, conn).refresh_lease(
                        session_id=session_id, owner=owner, ttl_seconds=_LEASE_TTL
                    ):
                        logger.warning("lease stolen during relay session=%s; aborting", session_id)
                        return recorder, "stolen"
            if frame.get("type") == _EV_REQUIRES_ACTION:
                # Capture what the agent streamed BEFORE the pause (reasoning /
                # text) onto the run so resume can prepend it to the assistant
                # turn — otherwise pre-interrupt parts are lost (CC1).
                await self._set_awaiting(
                    session_id, user_id, run_id, frame, partial_parts=recorder.parts()
                )
                return recorder, "awaiting"
        return recorder, "done"

    async def _persist_user_turns(
        self,
        session_id: str,
        user_id: int,
        run_id: str,
        msg_ids: list[int],
        msgs: list[Message],
    ) -> None:
        """Run paused on a HITL interrupt: the input message(s) were already fed
        to the (now-paused) agent, so record them + consume the batch now. The
        assistant turn is recorded when the decision resumes; the run row stays
        awaiting_input (set by _set_awaiting). Inputs are split by source (same
        as the clean-finish path) so a proactive tick that paused on a side-effect
        tool records its heartbeat input as a debug-only role='heartbeat' row,
        not role='user'."""
        async with user_scoped_tx(self._pool, user_id) as conn:
            await MailboxRepository(user_id, conn).mark_consumed(message_ids=msg_ids, run_id=run_id)
            chat_msgs = ChatMessagesRepository(user_id=user_id, conn=conn)
            for role, text in _input_rows(msgs):
                await chat_msgs.append_turn(
                    thread_id=session_id,
                    role=role,
                    parts=[{"type": "text", "text": text}],
                    trigger="tick" if role == "heartbeat" else "user",
                )

    # ── proactive hooks (RC-1) ───────────────────────────────────────
    async def _publish_proactive_ticks(
        self, session_id: str, run_id: str, msgs: list[Message]
    ) -> None:
        """Publish a proactive:tick frame per heartbeat message so the FE
        renders the heartbeat input (content was built at enqueue time; the
        agent's reasoning/say follow as chat:* frames)."""
        for m in msgs:
            if m.source != "heartbeat":
                continue
            meta = m.meta or {}
            await self._framebus.publish(
                session_id,
                {
                    "type": "proactive:tick",
                    "ts": int(time.time() * 1000),
                    "traceId": run_id,
                    "data": {
                        "text": m.content or "",
                        "windowStart": meta.get("windowStart"),
                        "windowEnd": meta.get("windowEnd"),
                    },
                },
            )

    async def _proactive_finalize(
        self,
        session_id: str,
        user_id: int,
        run_id: str,
        msg_ids: list[int],
        msgs: list[Message],
        recorder: ChatTurnRecorder,
    ) -> None:
        """proactive clean finish — persisted to pai_chat_messages like any turn
        so a reconnect / Debug-toggle rebuilds the transcript from the table:
        heartbeat inputs become role='heartbeat' rows and a pure-heartbeat
        assistant turn is tagged trigger='tick'. The frontend marks
        tick-triggered turns debug-only (hidden unless Debug is on); a tick turn
        that reached out surfaces via its notify_user tool-call part (see
        ChatMessagesRepository.get_page include_debug). A batch that also merged
        a real user message is a normal visible turn (trigger='user')."""
        all_heartbeat = all(m.source == "heartbeat" for m in msgs)
        await self._finalize_turn(
            session_id,
            user_id,
            run_id,
            msg_ids,
            [],  # proactive inputs ride input_rows (source-aware); user_texts unused
            recorder,
            input_rows=_input_rows(msgs),
            assistant_trigger="tick" if all_heartbeat else "user",
        )

    # ── terminal transitions ─────────────────────────────────────────
    async def _finalize_turn(
        self,
        session_id: str,
        user_id: int,
        run_id: str,
        msg_ids: list[int],
        user_texts: list[str],
        recorder: ChatTurnRecorder,
        *,
        partial_parts: list[dict[str, Any]] | None = None,
        regenerate: bool = False,
        input_rows: list[tuple[Role, str]] | None = None,
        assistant_trigger: Trigger = "user",
    ) -> None:
        """Clean finish: complete the run, consume the batch, record history.
        `user_texts` is the user turns to write — empty for a HITL resume (user
        turn recorded at pause). `partial_parts` is what the agent streamed
        before a HITL pause (CC1), prepended to the assistant parts.

        `input_rows` overrides `user_texts` when the inputs aren't all plain user
        turns: proactive passes (role, text) pairs so a heartbeat tick lands as a
        role='heartbeat' row. `assistant_trigger` tags the assistant turn ('tick'
        for a heartbeat-triggered proactive turn) so a reload matches the live
        Debug classification."""
        assistant_parts = [*(partial_parts or []), *recorder.parts()]
        assistant_msg_id: int | None = None
        async with user_scoped_tx(self._pool, user_id) as conn:
            await RunRepository(user_id, conn).complete(
                run_id=run_id, result={"recorded_parts": len(assistant_parts)}
            )
            await MailboxRepository(user_id, conn).mark_consumed(message_ids=msg_ids, run_id=run_id)
            chat_msgs = ChatMessagesRepository(user_id=user_id, conn=conn)
            if regenerate:
                # Retry / Edit: mirror chat's pop-tail-and-rerun on
                # pai_chat_messages (same logic as ui/chat.py _persist_turn).
                # An edit (user text changed) replaces user+assistant; a pure
                # regenerate replaces only the assistant. Empty table (thread
                # predates the table) → skip surgery, just append the new
                # assistant below.
                new_text = user_texts[0] if user_texts else ""
                if await chat_msgs.latest_id(thread_id=session_id) is not None:
                    last_user = (await chat_msgs.last_user_text(thread_id=session_id)) or ""
                    if new_text and new_text != last_user.strip():
                        await chat_msgs.delete_tail(thread_id=session_id, count=2)
                        await chat_msgs.append_turn(
                            thread_id=session_id,
                            role="user",
                            parts=[{"type": "text", "text": new_text}],
                        )
                    else:
                        await chat_msgs.delete_tail(thread_id=session_id, count=1)
            else:
                # history truth (plan §四.4): one row PER merged input message
                # (mirrors how the model saw them — distinct turns). Default is
                # all-user; proactive supplies input_rows to split heartbeat
                # inputs into role='heartbeat' rows.
                rows: list[tuple[Role, str]] = (
                    input_rows if input_rows is not None else [("user", t) for t in user_texts]
                )
                for role, text in rows:
                    await chat_msgs.append_turn(
                        thread_id=session_id,
                        role=role,
                        parts=[{"type": "text", "text": text}],
                        trigger="tick" if role == "heartbeat" else "user",
                    )
            if assistant_parts:
                assistant_msg_id = await chat_msgs.append_turn(
                    thread_id=session_id,
                    role="assistant",
                    parts=assistant_parts,
                    trigger=assistant_trigger,
                )
        # After commit: surface the persisted assistant message id so a *live*
        # turn's entry can adopt the real pai_chat_messages id (thumbs / feedback
        # join on it; history turns already load with it). Sent after chat:done
        # (which rides the agent stream, ahead of this finalize), so the frontend
        # patches the entry it just finalized.
        if assistant_msg_id is not None:
            await self._framebus.publish(
                session_id,
                {
                    "type": "chat:persisted",
                    "ts": int(time.time() * 1000),
                    "traceId": run_id,
                    "data": {"messageId": str(assistant_msg_id)},
                },
            )
        await notify_run_status(
            self._pool, session_id=session_id, run_id=run_id, status="succeeded"
        )

    async def _fail(
        self,
        session_id: str,
        user_id: int,
        run_id: str,
        msg_ids: list[int],
        error: str,
    ) -> None:
        # chat returned an explicit error → consume the messages (a retry would
        # likely fail the same way). A worker *crash* (no _fail reached) leaves
        # them pending for replay instead — that's the at-least-once path.
        async with user_scoped_tx(self._pool, user_id) as conn:
            await RunRepository(user_id, conn).fail(run_id=run_id, error=error)
            await MailboxRepository(user_id, conn).mark_consumed(message_ids=msg_ids, run_id=run_id)
        await notify_run_status(self._pool, session_id=session_id, run_id=run_id, status="failed")

    async def _mark_cancelled(
        self, session_id: str, user_id: int, run_id: str, msg_ids: list[int]
    ) -> None:
        """Terminal transition when the relay task is cancelled. Two sources:

        * user-initiated — service.cancel already stamped the run cancelled
          with the authoritative reason (user_cancel / user_interrupt). Keep
          that reason (don't overwrite it here); consume the messages (the
          user stopped this turn on purpose — don't replay it) + notify.
        * shutdown — worker.stop cancelled the task; no service.cancel ran, so
          the run is still 'running'. Stamp it cancelled(shutdown) and LEAVE
          the messages pending so they replay on next boot (§4.3).
        """
        inf = self._inflight.get(session_id)
        user_initiated = inf is not None and inf.cancelled_by_user
        async with user_scoped_tx(self._pool, user_id) as conn:
            if user_initiated:
                await MailboxRepository(user_id, conn).mark_consumed(
                    message_ids=msg_ids, run_id=run_id
                )
            else:
                await RunRepository(user_id, conn).cancel(run_id=run_id, reason="shutdown")
        if user_initiated:
            await notify_run_status(
                self._pool, session_id=session_id, run_id=run_id, status="cancelled"
            )

    async def _set_awaiting(
        self,
        session_id: str,
        user_id: int,
        run_id: str,
        frame: dict,
        *,
        partial_parts: list[dict[str, Any]] | None = None,
    ) -> None:
        # Parse the requires_action frame (chat_requires_action emit shape).
        data = frame.get("data") or {}
        interrupt_id = data.get("interruptId")
        if not interrupt_id:
            # Defensive (CC18): without an id no decision can match back.
            # Shouldn't happen — langgraph always stamps Interrupt.id.
            logger.warning("requires_action missing interruptId session=%s", session_id)
        pending_action = {
            "interrupt_id": interrupt_id,
            "tool_name": data.get("toolName"),
            "args": data.get("args"),
            "args_preview": data.get("argsPreview"),
            "allowed_decisions": data.get("allowedDecisions") or [],
            # parts streamed before the pause (CC1) — prepended on resume.
            "partial_parts": partial_parts or [],
        }
        async with user_scoped_tx(self._pool, user_id) as conn:
            await RunRepository(user_id, conn).set_awaiting(
                run_id=run_id, pending_action=pending_action
            )
        await notify_run_status(
            self._pool, session_id=session_id, run_id=run_id, status="awaiting_input"
        )

    async def _user_keys(self, user_id: int) -> tuple[str | None, str | None]:
        """Cross-user lookup of the user's LiteLLM virtual_key + Browserbase
        context (web holds credentials — plan §十一). They ride in the chat
        JWT so chat needs no DB access."""
        async with service_tx(self._pool) as conn, conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                "SELECT litellm_virtual_key, browserbase_context_id FROM users WHERE id = %s",
                (user_id,),
            )
            row = await cur.fetchone()
        if row is None:
            return None, None
        return row["litellm_virtual_key"], row["browserbase_context_id"]
