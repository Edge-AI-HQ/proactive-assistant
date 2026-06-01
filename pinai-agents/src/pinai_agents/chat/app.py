"""Chat FastAPI app factory.

This process must NOT hold master credentials — see
`chat/asgi.py` for the boot-time fail-fast assert that enforces it.

Currently mounts the Step 1 routes (/agent/chat SSE, /agent/generate)
verbatim — the wire path is preserved so APIs / plugin proxy targets
just need their URL pointed at the chat process port instead of the
old single port. Step F-1 will introduce a separate /run endpoint that
the web process proxies to with an HS256 JWT.

Lifespan owns LangGraph checkpointer + Daytona sandbox GC loop — same
as Step 1's main.py, just relocated to its real home.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..config import get_chat_settings
from .browser.manager import get_browser_manager
from .browser.routes import router as browser_router
from .routes.chat import router as chat_router
from .routes.generate import router as generate_router
from .routes.history import router as history_router
from .routes.run import router as run_router
from .runtime.checkpoint import close_checkpointer, init_checkpointer
from .tools.sandbox import (
    gc_idle_threads,
    metrics_snapshot,
    registry_size,
    shutdown_all_sandboxes,
)

logger = logging.getLogger(__name__)

# Daytona sandbox idle GC. Matches auto_delete TTL inside sandbox.py so
# the registry doesn't keep dead Python references after the cloud
# resource is gone.
_SANDBOX_GC_INTERVAL_SEC = 5 * 60


async def _sandbox_gc_loop() -> None:
    """Background task: every N seconds, sweep idle thread sandboxes."""
    while True:
        try:
            await asyncio.sleep(_SANDBOX_GC_INTERVAL_SEC)
            n = await gc_idle_threads()
            if n > 0:
                logger.info("sandbox gc evicted %d entries", n)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("sandbox gc tick failed")


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_chat_settings()
    logger.info("pinai-agents CHAT starting (deploy_env=%s)", settings.deploy_env)

    # LangSmith tracing — opt-in via settings.langsmith_tracing. The
    # LangChain client reads LANGCHAIN_* env at module import time, so
    # we re-export from settings before any LC import runs (the chat
    # router imports happen below; this block runs first via lifespan).
    if settings.langsmith_tracing and settings.langsmith_api_key:
        import os as _os  # noqa: PLC0415

        _os.environ["LANGCHAIN_TRACING_V2"] = "true"
        _os.environ["LANGCHAIN_API_KEY"] = settings.langsmith_api_key
        _os.environ["LANGCHAIN_PROJECT"] = settings.langsmith_project
        _os.environ["LANGCHAIN_ENDPOINT"] = settings.langsmith_endpoint
        logger.info(
            "langsmith tracing ENABLED project=%s endpoint=%s",
            settings.langsmith_project,
            settings.langsmith_endpoint,
        )
    else:
        logger.info(
            "langsmith tracing disabled (set LANGSMITH_TRACING=true + LANGSMITH_API_KEY to enable)",
        )

    if settings.database_url:
        await init_checkpointer()
    else:
        logger.warning("DATABASE_URL not set — LangGraph checkpointer disabled")

    gc_task = asyncio.create_task(_sandbox_gc_loop())
    try:
        yield
    finally:
        logger.info("pinai-agents CHAT shutting down (sandboxes cached=%d)", registry_size())
        gc_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await gc_task
        await shutdown_all_sandboxes()
        await get_browser_manager().shutdown_all()
        await close_checkpointer()


def create_app() -> FastAPI:
    app = FastAPI(
        title="pinai-agents-chat",
        version="0.2.0",
        description=(
            "LLM loop process: runs LangGraph / DeepAgents. No master "
            "credentials. See "
            "docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx."
        ),
        lifespan=_lifespan,
    )

    app.include_router(chat_router)
    app.include_router(generate_router)
    app.include_router(history_router)
    app.include_router(run_router)
    app.include_router(browser_router)

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Liveness probe. Internal only — chat process isn't on the public
        edge; only the web process forwards traffic to it.
        """
        return {"status": "ok", "service": "pinai-agents-chat"}

    @app.get("/agent/sandbox/registry")
    async def sandbox_registry_info() -> dict[str, int]:
        """Diagnostic snapshot: current registry size + lifecycle counters.

        Counters are cumulative since process start. Stand-in until proper
        Prometheus / LangSmith integration lands.
        """
        return metrics_snapshot()

    return app
