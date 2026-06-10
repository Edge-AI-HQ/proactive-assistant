"""/api/generate — frontend generation entry.

Phase 1 model:
  POST /api/generate enqueues a `generator` task into pai_scheduled_tasks
  and returns the task_id. Scheduler dispatcher claims it (~50ms via
  PG NOTIFY), calls chat /agent/generate, persists results to
  pai_pipeline_runs. Frontend polls /api/agent-runs/active for status
  and refetches /api/cards once the task transitions to succeeded.

  Idempotency: while a generator task for this user is still active
  (queued or running), POST /api/generate returns the existing taskId
  instead of enqueuing a duplicate — same pattern Vercel uses to dedupe
  Deploy clicks.

Lazy-recovers user.litellm_virtual_key when first-touch provisioning
failed (LiteLLM unreachable at signup time). The retry hits the same
provisioning path the user_service uses on INSERT.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Body, Depends, HTTPException, status

from ....shared.api_models import GenerateRequest
from ...auth.deps import User, current_user, get_pool
from ...db.rls import user_scoped_tx
from ...services.generator_tasks import enqueue_generator_task

# Persistence moved to services/pipeline_persistence (shared with
# reminder_cards); re-exported here so existing callers keep importing
# from this module.
from ...services.pipeline_persistence import persist_generator_run

__all__ = ["persist_generator_run", "router"]

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["generate"])


async def _ensure_virtual_key(user: User, pool) -> User:
    from ...services.litellm_provisioning import (  # noqa: PLC0415
        ensure_user_litellm_key,
    )

    try:
        return await ensure_user_litellm_key(pool, user)
    except Exception as e:
        logger.exception("lazy LiteLLM provisioning failed user=%d", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"unable to provision LiteLLM key: {type(e).__name__}: {e}",
        ) from e


async def _find_active_generator_task(conn, user_id: int) -> str | None:
    """Idempotency probe — return the task_id of any in-flight manual
    generator click, or None.

    `kind='generator.manual'` is the only thing we dedupe against;
    auto-fires (`generator.auto`) are a sibling kind and don't mask the
    user's button. `status='active'` covers queued, running (archive
    happens on success), and failed-with-retries-left.
    """
    cur = await conn.execute(
        """
        SELECT id FROM pai_scheduled_tasks
        WHERE user_id = %s AND kind = 'generator.manual' AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
        """,
        (user_id,),
    )
    row = await cur.fetchone()
    return row.get("id") if row else None


@router.post("/generate", status_code=status.HTTP_202_ACCEPTED)
async def generate(
    body: GenerateRequest = Body(default_factory=GenerateRequest),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    trigger: str = "manual",
):
    """Enqueue a generator task. Returns immediately with the task_id;
    the scheduler dispatcher does the actual LLM run.

    Wire shape `{ok, taskId, runId, status}` — runId == taskId for the
    aligned-id world (one id end-to-end). Frontend polls
    /api/agent-runs/active to know when this transitions to succeeded
    and reads the cards from /api/cards.
    """
    user = await _ensure_virtual_key(user, pool)
    assert user.litellm_virtual_key is not None  # guaranteed by _ensure
    async with user_scoped_tx(pool, user.id) as conn:
        existing = await _find_active_generator_task(conn, user.id)
        if existing:
            return {
                "ok": True,
                "taskId": existing,
                "runId": existing,
                "status": "queued",
                "asOf": datetime.now(UTC).isoformat(),
                "deduped": True,
            }
        # Resolve output_language + enqueue via the shared helper so the
        # button (generator.manual) and chat trigger (generator.chat) keep
        # one payload schema / id format. Explicit body value wins (admin /
        # A-B debug); otherwise the helper reads the user's persisted
        # `generation_language`.
        task_id = await enqueue_generator_task(
            conn,
            user_id=user.id,
            kind="generator.manual",
            cards_to_generate=body.cards_to_generate,
            output_language=body.output_language,
            trigger=trigger,
        )
    return {
        "ok": True,
        "taskId": task_id,
        "runId": task_id,
        "status": "queued",
        "asOf": datetime.now(UTC).isoformat(),
        "deduped": False,
    }


@router.post("/auto-run", status_code=status.HTTP_202_ACCEPTED)
async def auto_run(
    body: GenerateRequest = Body(default_factory=GenerateRequest),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Auto-trigger variant — same enqueue path, just a different
    `trigger` tag for downstream filtering / dashboards."""
    return await generate(body, user, pool, trigger="auto")
