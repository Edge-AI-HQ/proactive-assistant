"""FastAPI entrypoint for pinai-agents.

Step 1.1 scope: service starts, /health responds. Real agent endpoints
(/agent/generate, /agent/chat) land in Step 1.5 and 1.6.
"""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .checkpoint import close_checkpointer, init_checkpointer
from .config import settings
from .routes.chat import router as chat_router
from .routes.generate import router as generate_router
from .routes.sandbox_spike import router as sandbox_spike_router
from .routes.spike import router as spike_router
from .routes.thread_spike import router as thread_spike_router
from .sandbox import gc_idle_threads, metrics_snapshot, registry_size, shutdown_all_sandboxes

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
logger = logging.getLogger("pinai_agents")


async def _sandbox_gc_loop() -> None:
    """Background task: every 5 min, sweep idle thread sandboxes."""
    while True:
        try:
            await asyncio.sleep(5 * 60)
            n = await gc_idle_threads()
            if n > 0:
                logger.info("sandbox gc evicted %d entries", n)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("sandbox gc tick failed")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    logger.info("pinai-agents starting (deploy_env=%s)", settings.deploy_env)
    if settings.database_url:
        await init_checkpointer()
    else:
        logger.warning("DATABASE_URL not set — LangGraph checkpointer disabled")
    gc_task = asyncio.create_task(_sandbox_gc_loop())
    try:
        yield
    finally:
        logger.info("pinai-agents shutting down (sandboxes cached=%d)", registry_size())
        gc_task.cancel()
        try:
            await gc_task
        except asyncio.CancelledError:
            pass
        await shutdown_all_sandboxes()
        await close_checkpointer()


app = FastAPI(
    title="pinai-agents",
    version="0.1.0",
    description="LangChain + DeepAgents service for proactive-ai. See docs/plans/2026-05-04-step1-deepagents-skeleton.mdx.",
    lifespan=lifespan,
)

app.include_router(spike_router)
app.include_router(sandbox_spike_router)
app.include_router(thread_spike_router)
app.include_router(generate_router)
app.include_router(chat_router)


@app.get("/agent/sandbox/registry")
async def sandbox_registry_info() -> dict[str, int]:
    """Diagnostic snapshot: current registry size + lifecycle counters.

    Counters are cumulative since process start. Use to verify cache hit
    rate, resume rate, LRU eviction rate, etc. — Step 1 stand-in until
    proper Prometheus / LangSmith integration lands.
    """
    return metrics_snapshot()


@app.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe. Returns 200 if the process is up.

    Used by docker-compose healthcheck and by APIs as a quick readiness check
    before forwarding traffic. Does NOT check downstream dependencies
    (LiteLLM / Postgres / Modal) — those are validated lazily on first agent
    call.
    """
    return {"status": "ok", "service": settings.service_name}
