"""AgentRunService — the actor kernel's public API (plan §九).

Routes call this; it owns no loop (the worker does). It composes the repos
(DB) + bus (pg_notify control signals) + FrameBus (live frames). Everything
is session-keyed. The worker is the only consumer of the mailbox — this
service only produces (enqueue + notify) and exposes the live frame stream.

  post_message    enqueue + wake the worker (idempotency_key dedupes retries)
  subscribe       live frames for a session (FrameBus, no replay)
  submit_decision HITL: a tool decision is just a mailbox message
  cancel          mark the active run cancelled + signal the holder to abort
  interrupt       cancel(user_interrupt) + post_message, as one caller action
  start_run       batch one-shot (no Session/lease)
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Literal

from psycopg_pool import AsyncConnectionPool

from ...shared.agent_run import AgentKind, MessageSource
from ..db.rls import user_scoped_tx
from .bus import notify_cancel, notify_message
from .framebus import Frame, FrameBus
from .mailbox import MailboxRepository
from .runs import RunRepository
from .sessions import SessionRepository


class AgentRunService:
    def __init__(self, pool: AsyncConnectionPool, framebus: FrameBus) -> None:
        self._pool = pool
        self._framebus = framebus

    async def post_message(
        self,
        session_id: str,
        *,
        user_id: int,
        agent_kind: AgentKind,
        source: MessageSource,
        content: str | None = None,
        meta: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> None:
        """Open the session (idempotent) + append one mailbox message, then
        wake the worker. The notify is best-effort low-latency; the worker's
        interval poll is the correctness backstop (plan §十一)."""
        async with user_scoped_tx(self._pool, user_id) as conn:
            await SessionRepository(user_id, conn).ensure_session(
                session_id=session_id, agent_kind=agent_kind
            )
            await MailboxRepository(user_id, conn).enqueue(
                session_id=session_id,
                source=source,
                content=content,
                meta=meta,
                idempotency_key=idempotency_key,
            )
        await notify_message(self._pool, session_id)

    def subscribe(self, session_id: str) -> AsyncIterator[Frame]:
        """Live frames from now on — no replay. Reconnect uses run status +
        pai_chat_messages (plan §四.4 Claude-app model)."""
        return self._framebus.subscribe(session_id)

    async def submit_decision(
        self,
        session_id: str,
        *,
        user_id: int,
        agent_kind: AgentKind,
        tool_use_id: str,
        decision: Literal["approve", "reject", "edit", "respond"],
        message: str | None = None,
    ) -> None:
        """HITL: route a tool decision back through the same mailbox
        (source=tool_decision). The worker matches it to the awaiting run by
        tool_use_id (= the interrupt id) + resumes via Command(resume=) (plan
        §五.4). `decision` uses HumanInTheLoopMiddleware's vocabulary
        (approve / reject / edit / respond). idempotency_key dedupes a
        double-tap."""
        async with user_scoped_tx(self._pool, user_id) as conn:
            await SessionRepository(user_id, conn).ensure_session(
                session_id=session_id, agent_kind=agent_kind
            )
            await MailboxRepository(user_id, conn).enqueue(
                session_id=session_id,
                source="tool_decision",
                content=message,
                meta={"tool_use_id": tool_use_id, "decision": decision},
                idempotency_key=f"decision-{tool_use_id}",
            )
        await notify_message(self._pool, session_id)

    async def cancel(
        self,
        session_id: str,
        *,
        user_id: int,
        reason: str = "user_cancel",
    ) -> None:
        """Stop the session's active run for real: mark it cancelled in DB +
        signal whichever web instance holds the in-flight run to abort the
        chat HTTP (plan §十一 cancel 真停). A pending-but-unstarted turn has
        no in-flight task; the DB mark stops the worker from starting it."""
        async with user_scoped_tx(self._pool, user_id) as conn:
            run = await RunRepository(user_id, conn).get_active(session_id=session_id)
            if run is not None:
                await RunRepository(user_id, conn).cancel(run_id=run.id, reason=reason)
        await notify_cancel(self._pool, session_id)

    async def interrupt(
        self,
        session_id: str,
        *,
        user_id: int,
        agent_kind: AgentKind,
        new_message: str,
    ) -> None:
        """Double-text on a busy session: cancel the running turn (keeping its
        partial — reason=user_interrupt) then enqueue the new message, as one
        caller action."""
        await self.cancel(session_id, user_id=user_id, reason="user_interrupt")
        await self.post_message(
            session_id,
            user_id=user_id,
            agent_kind=agent_kind,
            source="user",
            content=new_message,
        )

    async def start_run(
        self,
        agent_kind: AgentKind,
        *,
        user_id: int,
        trigger: str,
        parent_run_id: str | None = None,
    ) -> str:
        """Batch one-shot (no Session / lease / mailbox): create the unified
        pai_agent_runs ledger row (status 'running') and return its id.

        RC-3: the scheduler dispatcher calls this to enter a batch agent
        (dream / evolve / crystallize / generator) into the same run ledger as
        conversational agents, then drives the executor (chat /agent/run/{kind}
        or /agent/generate) + domain bookkeeping itself, and calls finish_run
        with the outcome. The executor stays in the dispatcher (plan §十七.5:
        "batch 只统一 run 账本+入口"), so this method is create-only."""
        async with user_scoped_tx(self._pool, user_id) as conn:
            return await RunRepository(user_id, conn).create(
                session_id=None,
                agent_kind=agent_kind,
                trigger=trigger,
                parent_run_id=parent_run_id,
            )

    async def finish_run(
        self,
        run_id: str,
        *,
        user_id: int,
        status: Literal["succeeded", "failed"],
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        """Terminal transition for a batch run created via start_run. Flips the
        pai_agent_runs row to succeeded / failed; the dispatcher owns the
        executor + the domain ledgers (pai_evolution_runs / pai_pipeline_runs),
        so this only closes the unified ledger entry."""
        async with user_scoped_tx(self._pool, user_id) as conn:
            repo = RunRepository(user_id, conn)
            if status == "succeeded":
                await repo.complete(run_id=run_id, result=result)
            else:
                await repo.fail(run_id=run_id, error=error or "unknown error")
