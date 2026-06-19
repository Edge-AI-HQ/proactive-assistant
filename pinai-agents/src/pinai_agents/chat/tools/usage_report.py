"""Best-effort compute-usage reporting (chat → web).

Browser sessions and sandbox execs cost money but bypass LiteLLM token
accounting. Each active use times itself and reports the duration to web's
`/api/agent/usage/record`, which prices it (duration × rate) and records it on
the user's credit ledger — same path as ByteDance ASR.

Fire-and-forget: never block or fail the tool on a reporting hiccup. The task
is created inside the run context, so it captures the per-run JWT (used by
http_client to authenticate) even if it runs slightly after the tool returns.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from ..harness.ctx import current_run_jwt
from . import http_client

logger = logging.getLogger(__name__)

# Hold strong refs to in-flight reports so the event loop doesn't GC them
# mid-flight (asyncio only keeps weak refs to tasks).
_pending: set[asyncio.Task[Any]] = set()


async def _post(body: dict[str, Any], jwt: str) -> None:
    try:
        await http_client.post_with_jwt(
            "/api/agent/usage/record",
            body,
            jwt=jwt,
        )
    except Exception:
        logger.debug("compute usage report failed (best-effort)", exc_info=True)


def report_compute_usage(
    *,
    provider: str,
    duration_seconds: float,
    source: str,
    metadata: dict[str, Any] | None = None,
    run_jwt: str | None = None,
) -> None:
    """Fire-and-forget a usage report. Pass `run_jwt` explicitly on paths that
    hold it but run outside `run_context()` (background one-shot sandbox jobs);
    interactive tool calls omit it and fall back to the run-context JWT. No-op
    when there's nothing to bill or no JWT is resolvable."""
    jwt = run_jwt or current_run_jwt.get()
    if duration_seconds <= 0 or not jwt:
        return
    _schedule(
        {
            "provider": provider,
            "durationSeconds": round(duration_seconds, 3),
            "source": source,
            "metadata": metadata or {},
        },
        jwt,
    )


def report_metered_usage(
    *,
    provider: str,
    product: str,
    api_credits: float,
    source: str,
    metadata: dict[str, Any] | None = None,
    run_jwt: str | None = None,
) -> None:
    jwt = run_jwt or current_run_jwt.get()
    if api_credits <= 0 or not jwt:
        return
    _schedule(
        {
            "provider": provider,
            "product": product,
            "apiCredits": round(api_credits, 3),
            "source": source,
            "metadata": metadata or {},
        },
        jwt,
    )


def _schedule(body: dict[str, Any], jwt: str) -> None:
    try:
        task = asyncio.create_task(_post(body, jwt))
    except RuntimeError:
        logger.debug("usage report skipped outside running event loop")
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)
