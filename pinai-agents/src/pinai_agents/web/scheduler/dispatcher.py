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

import logging
import os
import time
import uuid
from typing import Any, Protocol

import httpx
from psycopg_pool import AsyncConnectionPool

from ..auth.agent_jwt import sign_agent_run_jwt
from ..db.repositories.evolution import EvolutionRepository
from ..db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    archive_after_success,
    backoff_seconds_for_attempt,
    complete_run,
    insert_run,
    record_failure_and_decide,
)
from ..db.rls import service_tx, user_scoped_tx

logger = logging.getLogger(__name__)


class _DispatcherProtocol(Protocol):
    async def dispatch(self, task: ScheduledTaskRow) -> None: ...


def _chat_internal_url() -> str:
    return os.environ.get("CHAT_INTERNAL_URL", "http://pinai-chat:8001")


# kinds that fan out to chat-worker /agent/run/* — those run a full
# DeepAgents loop (LLM rounds + Daytona sandbox + tool calls), routinely
# pushing past the default 60s lease. The reaper would happily mark such
# runs 'lease expired (worker crashed)' even though the agent is making
# progress. Bump them to 10min, matching what the OpenClaw plugin's
# auto-dreaming handler used to renew its lease to via `ctx.heartbeat`.
# init / sync are pure HTTP-then-INSERT and stay at the default.
_LONG_RUNNING_KINDS: frozenset[str] = frozenset({
    "auto.dreaming", "connector.evolve", "generator.manual",
    "generator.auto", "user.prompt",
})
_LONG_LEASE_SECONDS = 600


class DefaultDispatcher:
    """Routes by task.kind. Step F-3 wires real chat-worker handlers."""

    def __init__(
        self,
        pool: AsyncConnectionPool,
        *,
        lease_seconds: int,
        owner: str | None = None,
    ) -> None:
        self._pool = pool
        self._lease_seconds = lease_seconds
        self._owner = owner or f"web-{uuid.uuid4().hex[:8]}"

    def _lease_for(self, kind: str) -> int:
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
        scheduled_for = task.last_run_at  # type: ignore[assignment]
        if scheduled_for is None:
            logger.warning(
                "dispatch skipped: task=%s has no last_run_at", task.id,
            )
            return

        # Idempotent run-row insert; race losers exit cleanly. Lease
        # length is per-kind: LLM-loop kinds get the longer window so
        # the reaper doesn't mistake "DeepAgents is mid-think" for a
        # crashed worker.
        lease_seconds = self._lease_for(task.kind)
        async with service_tx(self._pool) as conn:
            won = await insert_run(
                conn,
                user_id=task.user_id, run_id=run_id, task_id=task.id,
                scheduled_for=scheduled_for,
                lease_owner=self._owner, lease_seconds=lease_seconds,
            )
        if not won:
            logger.info(
                "dispatch lost race user=%d task=%s scheduled_for=%s",
                task.user_id, task.id, scheduled_for,
            )
            return

        try:
            await self._handle_kind(task, run_id)
        except Exception as e:
            logger.exception(
                "dispatch handler failed user=%d task=%s kind=%s run_id=%s",
                task.user_id, task.id, task.kind, run_id,
            )
            err = f"{type(e).__name__}: {e}"
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
                    conn, user_id=task.user_id, run_id=run_id,
                    status="failed", error=err[:1000],
                )
                await record_failure_and_decide(
                    conn,
                    user_id=task.user_id, task_id=task.id,
                    last_error=err, retry_backoff_seconds=backoff,
                )
            return

        async with service_tx(self._pool) as conn:
            await complete_run(
                conn, user_id=task.user_id, run_id=run_id, status="success",
            )
            if task.trigger_kind == "once":
                # Stamp success on the already-archived row so /api/tasks
                # surfaces "succeeded" instead of "failed".
                await archive_after_success(
                    conn, user_id=task.user_id, task_id=task.id,
                )

    async def _handle_kind(self, task: ScheduledTaskRow, run_id: str) -> None:
        kind = task.kind
        if kind == "auto.dreaming":
            await self._dispatch_dream(task, run_id)
        elif kind == "connector.evolve":
            await self._call_chat(
                "/agent/run/evolve", task, run_id,
                extra={"connector": (task.payload or {}).get("connector", "unknown")},
            )
        elif kind == "user.prompt":
            await self._call_chat(
                "/agent/run/dream", task, run_id,  # reuse dream as a generic synthetic-prompt path
            )
        elif kind == "crystallize":
            await self._call_chat(
                "/agent/run/crystallize", task, run_id,
                extra={"session_key": (task.payload or {}).get("session_key", "")},
            )
        elif kind in ("generator.manual", "generator.auto"):
            # Both kinds → same handler. The kind name is the only place
            # the manual-vs-recurring distinction lives now (see migration
            # 039); _run_generator is correctly trigger-kind-agnostic.
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
        else:
            logger.warning("unknown task.kind=%s — no-op", kind)

    async def _dispatch_dream(
        self, task: ScheduledTaskRow, run_id: str,
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
                task.user_id, run_id,
            )

        try:
            await self._call_chat("/agent/run/dream", task, run_id)
        except Exception as e:
            if evol_id is not None:
                try:
                    async with user_scoped_tx(self._pool, task.user_id) as conn:
                        await EvolutionRepository(task.user_id, conn).fail(
                            evol_id, error_message=f"{type(e).__name__}: {e}"[:1000],
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
                    await EvolutionRepository(task.user_id, conn).complete(
                        evol_id,
                        duration_ms=int((time.monotonic() - started) * 1000),
                    )
            except Exception:
                logger.exception(
                    "evolution.complete bookkeeping failed evol_id=%s — row stuck 'running'",
                    evol_id,
                )

    async def _run_generator(
        self, task: ScheduledTaskRow, run_id: str,
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
        cards_to_generate = int(payload.get("cards_to_generate") or 4)
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
            payload_phase1 = payload.get("phase1") if isinstance(payload.get("phase1"), dict) else None
            async with user_scoped_tx(self._pool, task.user_id) as conn:
                phase1_seed = payload_phase1 or await build_phase1_seed(conn, task.user_id)
                repo = PatternsRepository(task.user_id, conn)
                fp = UserFingerprintRepository(task.user_id, conn)
                match_result = await match_patterns(
                    repo, phase1_seed or {}, fingerprint=fp,
                )
            matched_payload = [m.to_payload() for m in match_result.matched]
        except Exception:  # noqa: BLE001
            # Pattern matching is best-effort in Phase 2 — never block
            # generation if the matcher trips on a malformed DSL row.
            logger.exception(
                "pattern matcher failed user=%d run=%s (continuing with empty match list)",
                task.user_id, run_id,
            )

        result = await call_generate(
            user_id=task.user_id,
            cards_to_generate=cards_to_generate,
            output_language=output_language,
            virtual_key=virtual_key,
            run_id=run_id,
            matched_patterns=matched_payload or None,
        )
        # Persist into pai_pipeline_runs / pai_card_evaluations using the
        # same id the task / FE polled with — `run_id` here equals
        # `task.id` thanks to the dispatch-level alignment above.
        # matched_payload is forwarded so pai_card_pattern_hits gets the
        # original matcher evidence per pattern (chat-side cannot read
        # the pattern DB — see trust boundary).
        await persist_generator_run(
            self._pool, user_id=task.user_id, payload=result,
            trigger=str(payload.get("trigger") or "manual"),
            matched_patterns=matched_payload or None,
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
                self._pool, user_id=task.user_id, card_count=card_count,
            )

    async def _call_chat(
        self, path: str, task: ScheduledTaskRow, run_id: str,
        *, extra: dict | None = None,
    ) -> None:
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
            return

        # JWT carries `vk` so chat-worker can call /api/agent/sandbox/phantom/mint
        # — that endpoint gates on "is this a chat-driving JWT?", which is
        # what the vk claim means. Scheduler-driven evolve / dream are
        # chat-driving in every meaningful sense (LLM loop + sandbox tools);
        # they need the same auth profile.
        token, _ = sign_agent_run_jwt(
            user_id=task.user_id, run_id=run_id, virtual_key=virtual_key,
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
                    url, json=body,
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
            msg = (
                f"chat worker {path} returned {resp.status_code} "
                f"body={resp.text[:300]}"
            )
            raise RuntimeError(msg)
