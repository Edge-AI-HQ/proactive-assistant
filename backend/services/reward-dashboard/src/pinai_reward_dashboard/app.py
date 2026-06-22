"""Reward-dashboard FastAPI app factory.

Trust boundary: this is an *internal* review tool. It can read the product
`pai_*` schema and write its own reward/casebook/trace tables, but it holds
NO master credential and does not depend on `pinai-api`. The dependency
graph is the physical isolation: this package imports only `pinai-db` +
third-party libs.

Lifespan owns the DB pool only — no Redis FrameBus, no scheduler, no agent
kernel (those are the api process's concerns). Every route scopes its
queries to the resolved reviewer's `user.id` inside `user_scoped_tx`.

Mount:
    * /api/reward-dashboard/* — Supabase JWT (reviewer)
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pinai_db.pool import close_pool, open_pool
from psycopg_pool import AsyncConnectionPool

from pinai_reward_dashboard.config import get_settings

from .routes import router as reward_dashboard_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    logger.info("pinai-reward-dashboard starting (deploy_env=%s)", settings.deploy_env)

    pool: AsyncConnectionPool | None = None
    if settings.database_url:
        # pinai_db is service-agnostic — inject DSN + pool sizing here (the
        # lifespan owns the pool lifecycle).
        pool = await open_pool(
            dsn=settings.database_url,
            min_size=settings.db_pool_min,
            max_size=settings.db_pool_max,
        )
        app.state.pool = pool
    else:
        # Useful for pure-unit-test runs that don't need a DB. Logs loudly so
        # a real env that forgot DATABASE_URL is obvious.
        logger.warning("DATABASE_URL not set — DB pool disabled")
        app.state.pool = None

    try:
        yield
    finally:
        logger.info("pinai-reward-dashboard shutting down")
        if pool is not None:
            await close_pool(pool)


def create_app() -> FastAPI:
    app = FastAPI(
        title="pinai-reward-dashboard",
        version="0.1.0",
        description=(
            "Internal card-review tool. Reads the product DB; holds no master "
            "credential and does not depend on pinai-api. See "
            "docs/plans/2026-06-21-backend-rearchitecture.mdx."
        ),
        lifespan=_lifespan,
    )

    # ── CORS ──
    # The dashboard SPA lives on its own origin so the browser preflights
    # every cross-origin /api/* call. Allowlist comes from
    # CORS_ALLOWED_ORIGINS (comma-separated); explicit origins (no `*`) +
    # allow_credentials lets the SPA send its Supabase Authorization header.
    settings = get_settings()
    origins = [o.strip() for o in (settings.cors_allowed_origins or "").split(",") if o.strip()]
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["*"],
        )

    app.include_router(reward_dashboard_router)

    @app.get("/health")
    async def health() -> dict[str, object]:
        """Liveness probe. 200 if the process is up, with a cheap DB ping."""
        out: dict[str, object] = {"status": "ok", "service": "pinai-reward-dashboard"}
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
