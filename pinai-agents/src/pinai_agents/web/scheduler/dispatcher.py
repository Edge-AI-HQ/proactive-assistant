"""Task dispatcher — bridges scheduler claims to actual work.

Per-kind routing:
  auto.dreaming      → HTTP POST chat-worker /agent/run/dream
  connector.evolve   → HTTP POST chat-worker /agent/run/evolve
  connector.init     → in-process Composio ingest (services/connector_ingest)
  connector.sync     → in-process Composio incremental ingest (same handler,
                        routes by task.kind internally)
  crystallize        → not scheduled (chat worker fires inline)
  user.prompt        → HTTP POST chat-worker /agent/chat (synthetic message)

Once-shot task lifecycle (after migration 031):
  tick_loop._persist_next archives once tasks immediately on claim
  (next_run_at = NULL, status = archived) so they're not re-claimed
  while the dispatcher is running. The dispatcher then reverses or
  finalizes:
    * success → archive_after_success (already archived; just stamps
      last_run_status='success' over 'dispatched').
    * failure with retries left → record_failure_and_decide flips
      status back to 'active' + sets next_run_at = NOW() + backoff,
      so the next tick re-claims.
    * failure with no retries → record_failure_and_decide keeps
      archived + records last_error.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

import httpx
from psycopg_pool import AsyncConnectionPool

from ...shared.agent_run import AgentKind
from ..agent_core.service import AgentRunService
from ..auth.agent_jwt import sign_agent_run_jwt
from ..db.repositories.evolution import EvolutionRepository
from ..db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    archive_after_success,
    backoff_seconds_for_attempt,
    complete_run,
    insert_run,
    record_failure_and_decide,
    record_recurring_success,
)
from ..db.rls import service_tx, user_scoped_tx

logger = logging.getLogger(__name__)

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    raw = value.strip()
    normalized = raw.replace("\\n", "\n")
    candidates = [raw, normalized]
    fenced = _JSON_FENCE_RE.search(normalized)
    if fenced:
        candidates.insert(0, fenced.group(1).strip())
    elif raw.startswith("```"):
        candidates.insert(
            0,
            raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip(),
        )
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _dream_result_fields(result: dict[str, Any]) -> dict[str, Any]:
    raw_summary = result.get("summary")
    parsed = _json_obj(raw_summary)
    if not parsed:
        parsed = _json_obj(result)

    summary = parsed.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        summary = raw_summary if isinstance(raw_summary, str) else ""

    profile_fields = (
        parsed.get("profileFieldsUpdated") or parsed.get("profile_fields_updated") or []
    )
    if not isinstance(profile_fields, list):
        profile_fields = []
    profile_fields = [str(v) for v in profile_fields if str(v).strip()]

    return {
        "context_summary": summary.strip()[:2000] if summary.strip() else None,
        "profile_updated": bool(profile_fields),
        "profile_changed_keys": profile_fields,
        "agent_report": parsed or result,
    }


class _DispatcherProtocol(Protocol):
    async def dispatch(self, task: ScheduledTaskRow) -> None: ...


def _chat_internal_url() -> str:
    return os.environ.get("CHAT_INTERNAL_URL", "http://pinai-chat:8001")


# Kinds that fan out to chat-worker /agent/run/* run a full DeepAgents loop
# (LLM rounds + Daytona sandbox + tool calls), routinely pushing past the
# default 60s lease. The reaper would otherwise mark such runs "lease expired"
# while the agent is still making progress.
#
# Generator is user-facing: if no cards land within 10 minutes, the run
# must fail instead of holding the UI in an active state.
# init / sync are pure HTTP-then-INSERT and stay at the default.
_LONG_RUNNING_KINDS: frozenset[str] = frozenset(
    {
        "auto.dreaming",
        "connector.evolve",
        "user.prompt",
    }
)
_GENERATOR_KINDS: frozenset[str] = frozenset(
    {"generator.manual", "generator.auto", "generator.scheduled"}
)


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _generation_context_since(
    *,
    now: datetime,
    last_success_at: datetime | None,
) -> datetime:
    min_since = _aware_utc(now) - timedelta(hours=24)
    if last_success_at is not None:
        last = _aware_utc(last_success_at)
        if last < min_since:
            return last
    return min_since


def _generation_request_from_task(task: ScheduledTaskRow) -> dict[str, Any] | None:
    if task.kind != "generator.scheduled":
        return None
    payload = task.payload or {}
    confirmed_brief = (
        payload.get("confirmed_brief") if isinstance(payload.get("confirmed_brief"), dict) else {}
    )
    parsed_intent = (
        payload.get("parsed_intent") if isinstance(payload.get("parsed_intent"), dict) else {}
    )
    title = (
        confirmed_brief.get("title")
        or confirmed_brief.get("topic")
        or parsed_intent.get("topic")
    )
    return {
        "source_kind": "scheduled",
        "source_label": str(title or "Scheduled"),
        "scheduled_task_id": task.id,
        "confirmed_brief": confirmed_brief,
        "parsed_intent": parsed_intent,
    }


_LONG_LEASE_SECONDS = 600
_GENERATOR_LEASE_SECONDS = 600

# Scheduler task.kind → unified pai_agent_runs agent_kind (RC-3). Batch agents
# get a ledger row alongside conversational agents so every agent run lives in
# one table. Excluded: connector.init/sync (not agents — plan §299) and
# proactive.tick (RC-1 routes it through the actor mailbox, where the worker
# creates the run).
_AGENT_RUN_KIND: dict[str, AgentKind] = {
    "auto.dreaming": "dream",
    "connector.evolve": "evolve",
    "crystallize": "crystallize",
    "generator.manual": "generator",
    "generator.auto": "generator",
    "generator.scheduled": "generator",
    "user.prompt": "dream",
}

# Producer kinds: scheduled tasks that only PRODUCE work (enqueue onto the actor
# mailbox) instead of executing it inline. They take the lightweight dispatch
# path (see dispatch / _dispatch_producer) — no per-run ledger row, no
# pai_agent_runs mirror — because the real execution (the proactive agent) runs
# in AgentRunWorker with its own pai_agent_runs row. Multi-instance dedup still
# comes from tick_loop's SKIP LOCKED claim + next_run_at advance, so dropping the
# insert_run UNIQUE guard here is safe.
_PRODUCER_KINDS: frozenset[str] = frozenset({"proactive.tick"})


class DefaultDispatcher:
    """Routes a scheduled task to its handler by task.kind.

    Handler methods import their service deps lazily (function-body imports,
    flagged PLC0415) on purpose: it breaks the scheduler↔services import cycle
    and keeps heavy modules (generator, card_fanout, …) off the dispatcher's
    import path until the matching task actually fires.
    """

    def __init__(
        self,
        pool: AsyncConnectionPool,
        *,
        lease_seconds: int,
        owner: str | None = None,
        service: AgentRunService | None = None,
    ) -> None:
        self._pool = pool
        self._lease_seconds = lease_seconds
        self._owner = owner or f"web-{uuid.uuid4().hex[:8]}"
        # RC-3: when set, batch agent runs are mirrored into the unified
        # pai_agent_runs ledger via start_run/finish_run. Optional so tests can
        # build a dispatcher without the full actor service.
        self._service = service

    def _lease_for(self, kind: str) -> int:
        if kind in _GENERATOR_KINDS:
            return max(self._lease_seconds, _GENERATOR_LEASE_SECONDS)
        if kind in _LONG_RUNNING_KINDS:
            return max(self._lease_seconds, _LONG_LEASE_SECONDS)
        return self._lease_seconds

    async def dispatch(self, task: ScheduledTaskRow) -> None:
        # Each fire gets a fresh run_id so retriable tasks (reconnect,
        # cron, retry-with-backoff) can fire the same task multiple
        # times without colliding on pai_scheduled_task_runs.id PK.
        # We keep `task.id` as a prefix for grep-ability — a run_id
        # like "init.gmail.ca_xxx.f3a8b1c4" still tells you at a glance
        # which task it belongs to. The race-protection guarantee comes
        # from the (user_id, task_id, scheduled_for) UNIQUE in
        # pai_scheduled_task_runs, NOT from `id` collision — so giving
        # each fire its own id costs us nothing.
        #
        # /api/tasks/<task_id> already JOINs LATERAL ORDER BY fired_at
        # DESC LIMIT 1 to surface the latest run, so frontend polling
        # works unchanged. Domain tables (pai_pipeline_runs,
        # pai_evolution_runs) key on their own ids set by the chat
        # worker, not on this run_id, so they're unaffected too.
        run_id = f"{task.id}.{uuid.uuid4().hex[:8]}"
        scheduled_for = task.last_run_at
        if scheduled_for is None:
            logger.warning(
                "dispatch skipped: task=%s has no last_run_at",
                task.id,
            )
            return

        # Producer kinds (proactive.tick) only enqueue onto the actor mailbox,
        # so they skip the whole per-run ledger below — see _PRODUCER_KINDS.
        if task.kind in _PRODUCER_KINDS:
            await self._dispatch_producer(task, run_id)
            return

        # Idempotent run-row insert; race losers exit cleanly. Lease
        # length is per-kind: LLM-loop kinds get the longer window so
        # the reaper doesn't mistake "DeepAgents is mid-think" for a
        # crashed worker.
        lease_seconds = self._lease_for(task.kind)
        async with service_tx(self._pool) as conn:
            won = await insert_run(
                conn,
                user_id=task.user_id,
                run_id=run_id,
                task_id=task.id,
                scheduled_for=scheduled_for,
                lease_owner=self._owner,
                lease_seconds=lease_seconds,
            )
        if not won:
            logger.info(
                "dispatch lost race user=%d task=%s scheduled_for=%s",
                task.user_id,
                task.id,
                scheduled_for,
            )
            return

        # RC-3: mirror batch agent runs into the unified pai_agent_runs ledger.
        # Best-effort: a ledger hiccup must not block the actual run or its
        # scheduled_task_runs / domain bookkeeping (the authoritative records).
        agent_run_kind = _AGENT_RUN_KIND.get(task.kind)
        agent_run_id: str | None = None
        if agent_run_kind is not None and self._service is not None:
            with contextlib.suppress(Exception):
                agent_run_id = await self._service.start_run(
                    agent_run_kind, user_id=task.user_id, trigger=task.kind
                )

        try:
            await self._handle_kind(task, run_id)
        except Exception as e:
            logger.exception(
                "dispatch handler failed user=%d task=%s kind=%s run_id=%s",
                task.user_id,
                task.id,
                task.kind,
                run_id,
            )
            err = f"{type(e).__name__}: {e}"
            if agent_run_id is not None and self._service is not None:
                with contextlib.suppress(Exception):
                    await self._service.finish_run(
                        agent_run_id, user_id=task.user_id, status="failed", error=err[:1000]
                    )
            # The retry decision is uniform regardless of trigger_kind:
            # cron/interval tasks already had next_run_at advanced by
            # _persist_next, so record_failure_and_decide on a non-once
            # task may re-overwrite it — that's fine, it's the same
            # information ("try again later") with backoff respecting
            # the failure cadence over the cron cadence. For once
            # tasks (already archived by _persist_next), retry-with-
            # backoff atomically flips status back to active.
            backoff = backoff_seconds_for_attempt(task.attempts + 1)
            async with service_tx(self._pool) as conn:
                await complete_run(
                    conn,
                    user_id=task.user_id,
                    run_id=run_id,
                    status="failed",
                    error=err[:1000],
                )
                await record_failure_and_decide(
                    conn,
                    user_id=task.user_id,
                    task_id=task.id,
                    last_error=err,
                    retry_backoff_seconds=backoff,
                )
            return

        if agent_run_id is not None and self._service is not None:
            with contextlib.suppress(Exception):
                await self._service.finish_run(
                    agent_run_id, user_id=task.user_id, status="succeeded"
                )

        async with service_tx(self._pool) as conn:
            await complete_run(
                conn,
                user_id=task.user_id,
                run_id=run_id,
                status="success",
            )
            if task.trigger_kind == "once":
                # Stamp success on the already-archived row so /api/tasks
                # surfaces "succeeded" instead of "failed".
                await archive_after_success(
                    conn,
                    user_id=task.user_id,
                    task_id=task.id,
                )
            else:
                await record_recurring_success(
                    conn,
                    user_id=task.user_id,
                    task_id=task.id,
                )

    async def _dispatch_producer(self, task: ScheduledTaskRow, run_id: str) -> None:
        """Lightweight dispatch for producer kinds (see _PRODUCER_KINDS): run the
        handler (which enqueues onto the actor mailbox) + flip the task's
        recurring success/failure state for backoff + /api/tasks status. No
        per-run ledger row, no pai_agent_runs mirror — the worker owns the real
        run record. next_run_at was already advanced by tick_loop at claim time;
        multi-instance dedup is tick_loop's SKIP LOCKED claim."""
        try:
            await self._handle_kind(task, run_id)
        except Exception as e:
            logger.exception(
                "producer dispatch failed user=%d task=%s kind=%s",
                task.user_id,
                task.id,
                task.kind,
            )
            backoff = backoff_seconds_for_attempt(task.attempts + 1)
            async with service_tx(self._pool) as conn:
                await record_failure_and_decide(
                    conn,
                    user_id=task.user_id,
                    task_id=task.id,
                    last_error=f"{type(e).__name__}: {e}"[:1000],
                    retry_backoff_seconds=backoff,
                )
            return
        async with service_tx(self._pool) as conn:
            await record_recurring_success(
                conn,
                user_id=task.user_id,
                task_id=task.id,
            )

    async def _handle_kind(self, task: ScheduledTaskRow, run_id: str) -> None:
        kind = task.kind
        if kind == "auto.dreaming":
            await self._dispatch_dream(task, run_id)
        elif kind == "connector.evolve":
            await self._call_chat(
                "/agent/run/evolve",
                task,
                run_id,
                extra={"connector": (task.payload or {}).get("connector", "unknown")},
            )
        elif kind == "user.prompt":
            await self._call_chat(
                "/agent/run/dream",
                task,
                run_id,  # reuse dream as a generic synthetic-prompt path
            )
        elif kind == "crystallize":
            await self._call_chat(
                "/agent/run/crystallize",
                task,
                run_id,
                extra={"session_key": (task.payload or {}).get("session_key", "")},
            )
        elif kind in _GENERATOR_KINDS:
            # manual / auto / scheduled → same handler. The kind name is
            # the only place the source distinction lives; _run_generator
            # remains trigger-kind-agnostic and only adds request-scoped
            # generator input for scheduled payloads.
            await self._run_generator(task, run_id)
        elif kind in ("connector.init", "connector.sync"):
            # In-process Composio ingest. The handler updates progress
            # between fetch / raw / evolve stages so the frontend chip
            # surfaces them. On success:
            #   - init enqueues a one-shot connector.evolve (so the LLM
            #     agent distills the bootstrap pull) AND ensures a
            #     recurring connector.sync schedule for this (toolkit, cid).
            #   - sync writes the cursor forward and only enqueues evolve
            #     when raw rows were actually inserted (empty syncs skip).
            # The handler routes init vs. sync by task.kind internally so
            # we don't duplicate the entry-point plumbing here.
            from ..services import connector_ingest  # noqa: PLC0415

            await connector_ingest.run(self._pool, task, run_id)
        elif kind == "proactive.tick":
            # RC-1 (plan §十七): build the heartbeat content NOW (timeline window
            # since the cursor) and post it as one source=heartbeat message onto
            # the user's proactive session; the unified AgentRunWorker drains it.
            # The cursor advances here (enqueue time) so a delayed drain never
            # loses or repeats events. idempotency_key on run_id makes a
            # scheduler retry a no-op (no duplicate heartbeat / double advance).
            from ..agent_core.bus import notify_message  # noqa: PLC0415
            from ..agent_core.mailbox import MailboxRepository  # noqa: PLC0415
            from ..agent_core.sessions import SessionRepository  # noqa: PLC0415
            from ..db.repositories.proactive import ProactiveRepository  # noqa: PLC0415
            from ..db.repositories.profile import ProfileRepository  # noqa: PLC0415
            from ..db.rls import user_scoped_tx  # noqa: PLC0415
            from ..services.proactive_window import build_heartbeat_message  # noqa: PLC0415

            # Runtime gate: proactive_enabled (pai_user_settings) is the source
            # of truth for whether the heartbeat runs. claim_due_tasks filters
            # only on task status, so a proactive.tick left 'active' while the
            # user disabled proactive — flag flipped directly in the DB, or a
            # legacy row predating _sync_proactive_schedule — would emit
            # heartbeats forever (the runaway that grew a multi-GB checkpoint).
            # Re-check here and self-heal: archive the task so the next tick
            # stops claiming it, then skip this tick without enqueuing.
            async with user_scoped_tx(self._pool, task.user_id) as conn:
                proactive_enabled = (
                    await ProfileRepository(task.user_id, conn).get_settings()
                ).proactive_enabled
                if not proactive_enabled:
                    await conn.execute(
                        "UPDATE pai_scheduled_tasks "
                        "SET status='archived', next_run_at=NULL, updated_at=NOW() "
                        "WHERE user_id=%s AND id=%s",
                        (task.user_id, task.id),
                    )
                    logger.info(
                        "proactive.tick gated: user=%d has proactive_enabled=false; "
                        "archived stale task",
                        task.user_id,
                    )
                    return

            session_id = f"proactive-{task.user_id}"
            window = await build_heartbeat_message(self._pool, task.user_id, session_id=session_id)
            async with user_scoped_tx(self._pool, task.user_id) as conn:
                await SessionRepository(task.user_id, conn).ensure_session(
                    session_id=session_id, agent_kind="proactive"
                )
                enqueued = await MailboxRepository(task.user_id, conn).enqueue(
                    session_id=session_id,
                    source="heartbeat",
                    content=window.text,
                    meta={
                        "windowStart": window.window_start.isoformat(),
                        "windowEnd": window.window_end.isoformat(),
                    },
                    idempotency_key=f"tick-{run_id}",
                )
                # Advance the cursor in the SAME tx as the enqueue so a crash
                # between the two can't replay or duplicate the window — they
                # commit together or not at all. Only when we actually enqueued
                # (idempotency_key dedupe returns None on a scheduler retry).
                if enqueued is not None:
                    await ProactiveRepository(task.user_id, conn).advance_last_tick_at(
                        window.advance_to, thread_id=session_id
                    )
            if enqueued is not None:
                await notify_message(self._pool, session_id)
        else:
            logger.warning("unknown task.kind=%s — no-op", kind)

    async def _dispatch_dream(
        self,
        task: ScheduledTaskRow,
        run_id: str,
    ) -> None:
        """auto.dreaming dispatch + pai_evolution_runs lifecycle wrap.

        Why this lives here (web side) and not in chat/agents/dream.py:
          * Same process / pool as the DB — no HTTP roundtrip, no JWT
            timeout risk on long dreams (10-15 min agent loops).
          * Survives chat-worker crashes: if the chat container is OOM-
            killed mid-run, the outer try/except still flips the row
            from 'running' → 'failed' so the panel doesn't show a
            forever-running ghost.
          * Single source of truth for the run's id: the row's id is
            the same `run_id` (task.id + fire suffix) that LangSmith
            traces and pai_scheduled_task_runs already key on, so all
            three surfaces join cleanly.

        Bookkeeping failures are best-effort — the dream's primary side
        effects (memory.add / profile.upsert from inside the sandbox)
        write directly to their tables and don't depend on this row
        existing.
        """
        payload_trigger = (task.payload or {}).get("trigger")
        # Dream-history panel filter: trigger_kind in
        # ('daily_dream', 'manual'). Other values write the row but
        # won't surface in the panel.
        trigger_kind = "manual" if payload_trigger == "manual" else "daily_dream"
        started = time.monotonic()

        evol_id: str | None = None
        try:
            async with user_scoped_tx(self._pool, task.user_id) as conn:
                repo = EvolutionRepository(task.user_id, conn)
                row = await repo.create(
                    trigger_kind=trigger_kind,
                    context_summary=f"Dream run {run_id}",
                    run_id=run_id,
                )
                evol_id = row.id
        except Exception:
            logger.exception(
                "evolution.create failed user=%d run_id=%s — dream history will miss this row",
                task.user_id,
                run_id,
            )

        try:
            chat_result = await self._call_chat("/agent/run/dream", task, run_id)
        except Exception as e:
            if evol_id is not None:
                try:
                    async with user_scoped_tx(self._pool, task.user_id) as conn:
                        await EvolutionRepository(task.user_id, conn).fail(
                            evol_id,
                            error_message=f"{type(e).__name__}: {e}"[:1000],
                        )
                except Exception:
                    logger.exception(
                        "evolution.fail bookkeeping failed evol_id=%s — row stuck 'running'",
                        evol_id,
                    )
            raise

        if evol_id is not None:
            try:
                async with user_scoped_tx(self._pool, task.user_id) as conn:
                    repo = EvolutionRepository(task.user_id, conn)
                    output_summary = await repo.summarize_outputs(run_id)
                    result_fields = _dream_result_fields(chat_result)
                    await repo.complete(
                        evol_id,
                        **output_summary,
                        context_summary=result_fields["context_summary"],
                        profile_updated=result_fields["profile_updated"],
                        profile_changed_keys=result_fields["profile_changed_keys"],
                        duration_ms=int((time.monotonic() - started) * 1000),
                        details={
                            "agentReport": result_fields["agent_report"],
                            "outputSummary": output_summary,
                        },
                    )
            except Exception:
                logger.exception(
                    "evolution.complete bookkeeping failed evol_id=%s — row stuck 'running'",
                    evol_id,
                )

    async def _run_generator(
        self,
        task: ScheduledTaskRow,
        run_id: str,
    ) -> None:
        """Generator dispatch path: call chat /agent/generate and persist
        the cards JSON to pai_pipeline_runs (+ pai_card_evaluations).

        Differs from /agent/run/* kinds in that the chat endpoint returns
        a structured payload instead of side-effects-only — we own the
        persistence here so the FE only needs to read pai_pipeline_runs
        keyed by `run_id == task.id`.
        """
        from ..auth.user_service import User  # noqa: PLC0415
        from ..db.repositories.patterns import PatternsRepository  # noqa: PLC0415
        from ..db.repositories.user_fingerprint import (  # noqa: PLC0415
            UserFingerprintRepository,
        )
        from ..db.rls import user_scoped_tx  # noqa: PLC0415
        from ..routes.ui.generate import persist_generator_run  # noqa: PLC0415
        from ..services.chat_proxy import call_generate  # noqa: PLC0415
        from ..services.litellm_provisioning import (  # noqa: PLC0415
            ensure_user_litellm_key,
        )
        from ..services.pattern_matcher import match_patterns  # noqa: PLC0415
        from ..services.phase1_seed import build_phase1_seed  # noqa: PLC0415

        # Lazy-provision the LiteLLM key. The manual /generate path uses
        # `_ensure_virtual_key` for this — without mirroring it here,
        # scheduler-driven runs for users who never pressed Generate
        # (e.g. fresh accounts after auto_generate=TRUE became default)
        # would silently no-op every interval. We fetch the full row so
        # ensure_user_litellm_key has a User dataclass to work with.
        async with service_tx(self._pool) as conn:
            cur = await conn.execute(
                "SELECT id, supabase_user_id, email, litellm_virtual_key, "
                "browserbase_context_id FROM users WHERE id = %s",
                (task.user_id,),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"_run_generator: user={task.user_id} not found"
            raise RuntimeError(msg)
        user = User(
            id=row["id"],
            supabase_user_id=row["supabase_user_id"],
            email=row.get("email"),
            litellm_virtual_key=row.get("litellm_virtual_key"),
            browserbase_context_id=row.get("browserbase_context_id"),
        )
        # ensure_user_litellm_key raises on LiteLLM failure → dispatcher's
        # outer try/except catches it, marks the run failed, applies
        # backoff. No silent success path.
        user = await ensure_user_litellm_key(self._pool, user)
        virtual_key = user.litellm_virtual_key or ""
        if not virtual_key:
            msg = f"_run_generator: ensure_user_litellm_key returned empty for user={task.user_id}"
            raise RuntimeError(msg)

        payload = task.payload or {}
        cards_to_generate = min(int(payload.get("cards_to_generate") or 8), 8)
        output_language = str(payload.get("output_language") or "en")

        # Phase 2: pattern matcher runs in the web process so the chat
        # process never has to query the pattern DB. The web-side phase1
        # collector pulls a coarse snapshot of the user's signals before
        # chat fires its full data-collector subagent — enough for the
        # matcher to surface cold-start hits even though the deep phase1
        # only exists inside the chat sandbox.
        # docs/plans/2026-05-15-pattern-driven-card-generation.mdx.
        matched_payload: list[dict[str, Any]] = []
        try:
            payload_phase1 = (
                payload.get("phase1") if isinstance(payload.get("phase1"), dict) else None
            )
            async with user_scoped_tx(self._pool, task.user_id) as conn:
                phase1_seed = payload_phase1 or await build_phase1_seed(conn, task.user_id)
                repo = PatternsRepository(task.user_id, conn)
                fp = UserFingerprintRepository(task.user_id, conn)
                match_result = await match_patterns(
                    repo,
                    phase1_seed or {},
                    fingerprint=fp,
                )
            matched_payload = [m.to_payload() for m in match_result.matched]
        except Exception:  # noqa: BLE001
            # Pattern matching is best-effort in Phase 2 — never block
            # generation if the matcher trips on a malformed DSL row.
            logger.exception(
                "pattern matcher failed user=%d run=%s (continuing with empty match list)",
                task.user_id,
                run_id,
            )

        context_until = datetime.now(UTC)
        context_since = context_until - timedelta(hours=24)
        try:
            async with user_scoped_tx(self._pool, task.user_id) as conn:
                cur = await conn.execute(
                    """
                    SELECT completed_at
                    FROM pai_pipeline_runs
                    WHERE user_id = %s
                      AND status = 'completed'
                      AND completed_at IS NOT NULL
                    ORDER BY completed_at DESC
                    LIMIT 1
                    """,
                    (task.user_id,),
                )
                last_success = await cur.fetchone()
            context_since = _generation_context_since(
                now=context_until,
                last_success_at=last_success.get("completed_at") if last_success else None,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "generator context window lookup failed user=%d run=%s; falling back to 24h",
                task.user_id,
                run_id,
            )

        result = await call_generate(
            user_id=task.user_id,
            cards_to_generate=cards_to_generate,
            output_language=output_language,
            virtual_key=virtual_key,
            run_id=run_id,
            matched_patterns=matched_payload or None,
            context_since=context_since,
            context_until=context_until,
            generation_request=_generation_request_from_task(task),
        )
        # Persist into pai_pipeline_runs / pai_card_evaluations using the
        # same id the task / FE polled with — `run_id` here equals
        # `task.id` thanks to the dispatch-level alignment above.
        # matched_payload is forwarded so pai_card_pattern_hits gets the
        # original matcher evidence per pattern (chat-side cannot read
        # the pattern DB — see trust boundary).
        await persist_generator_run(
            self._pool,
            user_id=task.user_id,
            payload=result,
            trigger=str(payload.get("trigger") or "manual"),
            matched_patterns=matched_payload or None,
        )

        # Fan out one card-thread bootstrap turn per card so the card-
        # execution agent runs ahead of the user opening the card. The
        # agent calls `propose_action` and ends its turn; the FE reads
        # the resulting chat history later for both the home drawer
        # pre-review and the chat detail's chip+input panel. Fire-and-
        # forget — each card's bootstrap runs as its own background
        # task and a failure on one card doesn't block the others.
        try:
            from ..services.card_fanout import (  # noqa: PLC0415
                dispatch_card_bootstrap,
            )

            cards = result.get("cards") or []
            await dispatch_card_bootstrap(
                pool=self._pool,
                user_id=task.user_id,
                final_cards=cards if isinstance(cards, list) else [],
            )
        except Exception:
            logger.exception(
                "card fanout dispatch failed user=%d run=%s — cards "
                "persisted; FE Confirm path will bootstrap on demand",
                task.user_id,
                run_id,
            )

        # Dispatch "new cards" push notification. Multi-card collapse:
        # one notification per generator run regardless of how many cards
        # the run produced (push_notifier renders the count into the
        # body string). notify_new_cards is internally exception-safe so
        # a push failure never propagates back into the task lifecycle.
        from ..services.push_notifier import notify_new_cards  # noqa: PLC0415

        card_count = len(result.get("cards") or [])
        if card_count > 0:
            await notify_new_cards(
                self._pool,
                user_id=task.user_id,
                card_count=card_count,
            )

    async def _call_chat(
        self,
        path: str,
        task: ScheduledTaskRow,
        run_id: str,
        *,
        extra: dict | None = None,
    ) -> dict[str, Any]:
        # Need user's litellm_virtual_key — fetch from users table.
        async with service_tx(self._pool) as conn:
            cur = await conn.execute(
                "SELECT litellm_virtual_key FROM users WHERE id = %s",
                (task.user_id,),
            )
            row = await cur.fetchone()
        virtual_key = (row or {}).get("litellm_virtual_key") or ""
        if not virtual_key:
            logger.warning(
                "skip dispatch: user=%d has no litellm_virtual_key (apis-managed)",
                task.user_id,
            )
            return {}

        # JWT carries `vk` so chat-worker can call /api/agent/sandbox/phantom/mint
        # — that endpoint gates on "is this a chat-driving JWT?", which is
        # what the vk claim means. Scheduler-driven evolve / dream are
        # chat-driving in every meaningful sense (LLM loop + sandbox tools);
        # they need the same auth profile.
        token, _ = sign_agent_run_jwt(
            user_id=task.user_id,
            run_id=run_id,
            virtual_key=virtual_key,
        )
        body = {
            "user_id": task.user_id,
            "run_id": run_id,
            "virtual_key": virtual_key,
            **(extra or {}),
        }
        url = f"{_chat_internal_url()}{path}"
        timeout = httpx.Timeout(connect=5.0, read=600.0, write=10.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.post(
                    url,
                    json=body,
                    headers={"Authorization": f"Bearer {token}"},
                )
            except httpx.RequestError as e:
                # Network blip → bubble up so the dispatcher's failure
                # path retries with backoff. Returning silently here
                # would let the dispatcher claim success.
                msg = f"chat worker unreachable for {path}: {e}"
                raise RuntimeError(msg) from e
        if resp.status_code >= 400:
            # 4xx/5xx is a real failure — let the dispatcher retry.
            # Previously this only logged a warning, which made the
            # dispatcher mark the task succeeded despite the chat worker
            # exploding (e.g. phantom mint 403 leaked through silently).
            msg = f"chat worker {path} returned {resp.status_code} body={resp.text[:300]}"
            raise RuntimeError(msg)
        if not resp.content:
            return {}
        try:
            data = resp.json()
        except ValueError:
            return {"summary": resp.text[:2000]}
        return data if isinstance(data, dict) else {"result": data}
