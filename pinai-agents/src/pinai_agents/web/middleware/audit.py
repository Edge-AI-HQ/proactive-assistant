"""HTTP middleware that audit-logs every /api/agent/* request.

Hooks the Starlette ASGI middleware layer so every agent request — even
those that fail before the route handler runs (rate-limit, auth) — gets
a row in pai_agent_audit_log. We extract user_id + run_id from the
verified JWT (already attached by current_agent_run dep), but if auth
failed we just record the endpoint without user/run.

Audit failure NEVER fails the request — see audit.log_request which
swallows exceptions internally.
"""

from __future__ import annotations

import logging
import time

from psycopg_pool import AsyncConnectionPool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from ..auth.agent_jwt import AgentJWTError, verify_agent_run_jwt
from ..db.audit import log_request

logger = logging.getLogger(__name__)


class AgentAuditMiddleware(BaseHTTPMiddleware):
    """Records every /api/agent/* request to pai_agent_audit_log.

    Skips /health, /docs, /openapi.json — those don't deserve a row each.
    """

    AGENT_PREFIX = "/api/agent/"

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith(self.AGENT_PREFIX):
            return await call_next(request)

        # Best-effort extract user_id + run_id from the bearer token.
        # If parse fails (no token / bad token), we still record the
        # attempt — but with user_id=0 marker so we can grep for them.
        user_id = 0
        run_id: str | None = None
        auth = request.headers.get("authorization")
        if auth and auth.lower().startswith("bearer "):
            try:
                claims = verify_agent_run_jwt(auth[len("bearer "):].strip())
                user_id = claims.user_id
                run_id = claims.run_id
            except AgentJWTError:
                pass  # leave as 0 / None — auth dep will 401 next

        t0 = time.perf_counter()
        response: Response = await call_next(request)
        latency_ms = int((time.perf_counter() - t0) * 1000)

        pool: AsyncConnectionPool | None = getattr(request.app.state, "pool", None)
        if pool is None or user_id == 0:
            # Pool not up (test env / boot hiccup) or unauthenticated —
            # skip persistence. Log to stderr for grep.
            logger.info(
                "audit: %s %s status=%s lat=%dms user=%s run=%s (pool=%s)",
                request.method, path, response.status_code, latency_ms,
                user_id or "?", run_id or "?", "yes" if pool else "no",
            )
            return response

        await log_request(
            pool,
            user_id=user_id, run_id=run_id,
            endpoint=path, method=request.method,
            status=response.status_code, latency_ms=latency_ms,
            error_code=None if response.status_code < 400 else f"http_{response.status_code}",
        )
        return response
