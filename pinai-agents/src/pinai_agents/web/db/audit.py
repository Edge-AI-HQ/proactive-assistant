"""pai_agent_audit_log writer.

Called by /api/agent/* middleware after each request lands. Best-effort —
audit failure must NOT fail the actual API call (caller catches and
logs to stderr but continues). args_summary is a small JSONB blob —
caller is responsible for omitting sensitive fields.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from psycopg_pool import AsyncConnectionPool

from .rls import service_tx

logger = logging.getLogger(__name__)


async def log_request(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    run_id: str | None,
    endpoint: str,
    method: str,
    status: int | None,
    latency_ms: int | None,
    error_code: str | None = None,
    args_summary: dict[str, Any] | None = None,
) -> None:
    """Write one audit row. Swallows exceptions — logging is best-effort,
    audit log failure must not break the request path."""
    try:
        async with service_tx(pool) as conn:
            await conn.execute(
                """
                INSERT INTO pai_agent_audit_log
                  (user_id, run_id, endpoint, method, status,
                   latency_ms, error_code, args_summary)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    user_id,
                    run_id,
                    endpoint,
                    method,
                    status,
                    latency_ms,
                    error_code,
                    json.dumps(args_summary) if args_summary is not None else None,
                ),
            )
    except Exception:
        logger.exception(
            "audit log write failed user=%s endpoint=%s — continuing",
            user_id,
            endpoint,
        )
