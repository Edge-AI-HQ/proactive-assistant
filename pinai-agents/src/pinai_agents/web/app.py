"""Web FastAPI app factory.

Trust boundary: this process holds master credentials. Frontend → here
with Supabase JWT; sandbox / chat process → here with an EdDSA agent-run JWT.

Lifespan owns:
    * DB pool (psycopg AsyncConnectionPool, service_role)
    * Agent Core actor kernel (AgentRunService + AgentRunWorker + AgentBus
      + Redis-Streams FrameBus — resumable, multi-instance safe)
    * Scheduler tick_loop + world-ingest background tasks

Mounts:
    * /api/* (UI)       — Supabase JWT
    * /api/agent/*      — EdDSA JWT
    * /api/sys/*        — HMAC service-to-service
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from psycopg_pool import AsyncConnectionPool
from redis.asyncio import Redis

from ..config import get_web_settings
from .agent_core import (
    AgentRunService,
    AgentRunWorker,
    ChatRunClient,
    RedisFrameBus,
    agent_bus,
)
from .db.pool import close_pool, open_pool
from .middleware.audit import AgentAuditMiddleware
from .payment.routes import router as ui_payment_router
from .routes.agent.cards import router as agent_cards_router
from .routes.agent.composio import router as agent_composio_router
from .routes.agent.development_feedback import router as agent_development_feedback_router
from .routes.agent.evolution import router as agent_evolution_router
from .routes.agent.feedback import router as agent_feedback_router
from .routes.agent.generate import router as agent_generate_router
from .routes.agent.memory import router as agent_memory_router
from .routes.agent.pipeline import router as agent_pipeline_router
from .routes.agent.preferences import router as agent_preferences_router
from .routes.agent.proactive import router as agent_proactive_router
from .routes.agent.profile import router as agent_profile_router
from .routes.agent.raw import router as agent_raw_router
from .routes.agent.sandbox_phantom import router as agent_sandbox_phantom_router
from .routes.agent.signals import router as agent_signals_router
from .routes.agent.skills import router as agent_skills_router
from .routes.agent.timeline import router as agent_timeline_router
from .routes.agent.world import router as agent_world_router
from .routes.ui.account import router as ui_account_router
from .routes.ui.agent_runs import router as ui_agent_runs_router
from .routes.ui.ambient import router as ui_ambient_router
from .routes.ui.browser import router as ui_browser_router
from .routes.ui.composio import router as ui_composio_router
from .routes.ui.conversation import router as ui_conversation_router
from .routes.ui.development_feedback import router as ui_development_feedback_router
from .routes.ui.devices import router as ui_devices_router
from .routes.ui.dreaming import router as ui_dreaming_router_real
from .routes.ui.feedback import router as ui_feedback_router
from .routes.ui.generate import router as ui_generate_router
from .routes.ui.impersonation import router as ui_impersonation_router
from .routes.ui.jwt_revoke import router as ui_jwt_revoke_router
from .routes.ui.memory import router as ui_memory_router
from .routes.ui.profile import router as ui_profile_router
from .routes.ui.profile import settings_router as ui_settings_router
from .routes.ui.raw import router as ui_raw_router
from .routes.ui.reward_dashboard import router as ui_reward_dashboard_router
from .routes.ui.runs_and_cards import router as ui_runs_router
from .routes.ui.scheduled_generators import router as ui_scheduled_generators_router
from .routes.ui.signals import router as ui_signals_router
from .routes.ui.skills import router as ui_skills_router
from .routes.ui.stubs import (
    crystallize_router as ui_crystallize_router,
)
from .routes.ui.sync import router as ui_sync_router
from .routes.ui.tasks import router as ui_tasks_router
from .routes.ui.voice import router as ui_voice_router
from .scheduler.tick_loop import tick_loop

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_web_settings()
    logger.info("pinai-agents WEB starting (deploy_env=%s)", settings.deploy_env)

    pool: AsyncConnectionPool | None = None
    if settings.database_url:
        pool = await open_pool()
        app.state.pool = pool
    else:
        # Useful in pure-unit-test runs that don't need a DB. Logs loudly
        # so you notice if a real env forgot to set the URL.
        logger.warning("DATABASE_URL not set — DB pool + scheduler disabled")
        app.state.pool = None

    scheduler_task: asyncio.Task[None] | None = None
    world_ingest_task: asyncio.Task[None] | None = None
    agent_worker: AgentRunWorker | None = None
    redis_client: Redis | None = None
    if pool is not None:
        # World signals ingest is a GLOBAL loop (one RSS pull serves every
        # user) — it can't ride on pai_scheduled_tasks (that table requires
        # user_id) and doesn't depend on Redis, so it runs whenever the DB is
        # up. Multi-replica safety comes from the ingest_world UPSERT:
        # idempotent on normalized_url.
        from .services.world_ingest import loop as world_ingest_loop  # noqa: PLC0415

        world_ingest_task = asyncio.create_task(world_ingest_loop(pool), name="pinai-world-ingest")
        # Agent Core actor kernel (plan 2026-06-04): AgentRunService is the
        # produce-side API the routes call; the worker (below) drains every
        # conversational session via a per-session lease and fans frames out
        # over the Redis-Streams FrameBus (resumable + multi-instance safe).
        # Redis is REQUIRED — without it conversation/* and scheduler-driven
        # proactive turns have nowhere to stream, so disable the kernel loudly
        # rather than silently dropping every frame.
        if not settings.redis_url:
            logger.error(
                "REDIS_URL not set — Agent Core kernel + scheduler disabled "
                "(conversation/* unavailable). Set REDIS_URL (docker-compose "
                "redis service locally; `fly redis` on dev/prod)."
            )
        else:
            redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
            framebus = RedisFrameBus(redis_client)
            app.state.agent_service = AgentRunService(pool, framebus)
            scheduler_task = asyncio.create_task(
                tick_loop(
                    pool,
                    interval_seconds=settings.scheduler_tick_seconds,
                    lease_seconds=settings.scheduler_lease_seconds,
                    service=app.state.agent_service,
                ),
                name="pinai-scheduler-tick",
            )
            agent_worker = AgentRunWorker(pool, framebus, agent_bus, ChatRunClient())
            await agent_worker.start()

    try:
        yield
    finally:
        logger.info("pinai-agents WEB shutting down")
        # RC-1: proactive now runs on the actor kernel — its cancel/live-stream
        # go through agent_bus / FrameBus (worker.stop tears those down). The
        # old proactive_loop / proactive_bus are retired (no longer started).
        if agent_worker is not None:
            await agent_worker.stop()
        for t in (scheduler_task, world_ingest_task):
            if t is not None:
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await t
        if redis_client is not None:
            await redis_client.aclose()
        if pool is not None:
            await close_pool(pool)


def create_app() -> FastAPI:
    app = FastAPI(
        title="pinai-agents-web",
        version="0.2.0",
        description=(
            "Trust-bearing web process: holds master credentials, exposes "
            "/api/* and /api/agent/*. See "
            "docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx."
        ),
        lifespan=_lifespan,
    )

    # ── CORS ──
    # Frontend lives on a different origin (own nginx host) so the
    # browser preflights every cross-origin /api/* call. Allowlist comes
    # from CORS_ALLOWED_ORIGINS env (comma-separated). Defense rationale:
    # we serve user-bound data behind Supabase JWT auth — pinning origins
    # blocks cross-site fetch attempts even if a token leaks into a hostile
    # tab. allow_credentials=True lets the frontend send Authorization
    # headers; combined with explicit origins (no `*`) this matches the
    # browser security model.
    settings = get_web_settings()
    origins = [o.strip() for o in (settings.cors_allowed_origins or "").split(",") if o.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
            expose_headers=["X-Run-Id"],
        )

    # ── audit middleware on /api/agent/* (no-op on other paths) ──
    app.add_middleware(AgentAuditMiddleware)

    # ── /api/* (frontend, Supabase JWT) ──
    app.include_router(ui_memory_router)
    app.include_router(ui_signals_router)
    app.include_router(ui_profile_router)
    app.include_router(ui_settings_router)
    app.include_router(ui_runs_router)
    app.include_router(ui_conversation_router)
    app.include_router(ui_sync_router)
    app.include_router(ui_generate_router)
    app.include_router(ui_skills_router)
    app.include_router(ui_feedback_router)
    app.include_router(ui_crystallize_router)
    app.include_router(ui_dreaming_router_real)
    app.include_router(ui_composio_router)
    app.include_router(ui_tasks_router)
    app.include_router(ui_scheduled_generators_router)
    app.include_router(ui_raw_router)
    app.include_router(ui_reward_dashboard_router)
    app.include_router(ui_impersonation_router)
    app.include_router(ui_agent_runs_router)
    app.include_router(ui_devices_router)
    app.include_router(ui_payment_router)
    app.include_router(ui_jwt_revoke_router)
    app.include_router(ui_browser_router)
    app.include_router(ui_voice_router)
    app.include_router(ui_ambient_router)
    app.include_router(ui_account_router)
    app.include_router(ui_development_feedback_router)

    # ── /api/agent/* (sandbox / chat, EdDSA JWT) ──
    app.include_router(agent_memory_router)
    app.include_router(agent_signals_router)
    app.include_router(agent_world_router)
    app.include_router(agent_profile_router)
    app.include_router(agent_preferences_router)
    app.include_router(agent_skills_router)
    app.include_router(agent_composio_router)
    app.include_router(agent_raw_router)
    app.include_router(agent_cards_router)
    app.include_router(agent_generate_router)
    app.include_router(agent_feedback_router)
    app.include_router(agent_evolution_router)
    app.include_router(agent_pipeline_router)
    app.include_router(agent_proactive_router)
    app.include_router(agent_sandbox_phantom_router)
    app.include_router(agent_development_feedback_router)
    app.include_router(agent_timeline_router)

    @app.get("/health")
    async def health() -> dict[str, object]:
        """Liveness probe. 200 if the process is up.

        Includes a cheap DB ping — if DATABASE_URL is configured but
        the pool is in a bad state, /health surfaces that as `db: error`
        without flipping the overall response code (so K8s / Fly health
        checks don't yank the pod for a transient pg blip; rely on
        readiness probes for stricter gating).
        """
        out: dict[str, object] = {"status": "ok", "service": "pinai-agents-web"}
        # Local-dev only: which git branch this web process is running, so a
        # phone tunneled to :8000 can show (in the frontend DebugPanel) which
        # worktree it's hitting. Injected by the Makefile via the local
        # docker-compose.override.yml; unset in prod/CI → omitted here.
        dev_label = os.environ.get("PINAI_DEV_LABEL")
        if dev_label:
            out["dev_label"] = dev_label
        pool: AsyncConnectionPool | None = getattr(app.state, "pool", None)
        if pool is None:
            out["db"] = "disabled"
        else:
            try:
                async with pool.connection() as conn:
                    await conn.execute("SELECT 1")
                out["db"] = "ok"
            except Exception as e:
                out["db"] = f"error: {type(e).__name__}"
        return out

    return app
