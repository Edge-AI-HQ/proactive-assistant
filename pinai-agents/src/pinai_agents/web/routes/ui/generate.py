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

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, status

from ....shared.api_models import GenerateRequest
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.profile import ProfileRepository
from ...db.repositories.scheduled_tasks import enqueue_once
from ...db.rls import user_scoped_tx

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


async def persist_generator_run(
    pool, *, user_id: int, payload: dict, trigger: str,
) -> None:
    """Write the completed generator run to pai_pipeline_runs +
    pai_card_evaluations so /api/cards + UI recovery flows can find them.

    Best-effort: a persistence failure doesn't fail the request — the
    cards already returned to the client. We log and move on.

    Note on `id` vs `run_id`: the legacy schema kept these separate to
    let one pipeline span multiple LangGraph runs. Step 1 generator is
    a single agent invocation, so we set both columns to the same value
    — the run_id the client got from /api/generate is also what they
    send to /api/runs/{id} for polling.
    """
    run_id = payload.get("runId") or payload.get("run_id")
    if not run_id:
        logger.warning("generate response missing runId; skip persistence")
        return
    cards = payload.get("cards") or []
    iterations = payload.get("iterations")
    evaluations = payload.get("evaluations") or []
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            await conn.execute(
                """
                INSERT INTO pai_pipeline_runs
                  (user_id, id, run_id, status, trigger,
                   final_cards, iterations,
                   started_at, completed_at, updated_at)
                VALUES (%s, %s, %s, 'completed', %s,
                        %s::jsonb, %s::jsonb,
                        NOW(), NOW(), NOW())
                """,
                (
                    user_id, run_id, run_id, trigger,
                    json.dumps(cards),
                    json.dumps(iterations) if iterations is not None else None,
                ),
            )
            await _persist_evaluations(
                conn, user_id=user_id, run_id=run_id,
                cards=cards, evaluations=evaluations,
            )
    except Exception:
        logger.exception("persist generate run failed user=%d run=%s", user_id, run_id)


async def _persist_evaluations(
    conn,
    *,
    user_id: int,
    run_id: str,
    cards: list[dict[str, Any]],
    evaluations: list[dict[str, Any]],
) -> None:
    """Insert one pai_card_evaluations row per (cardId, dimensions) entry.

    Best-effort within the same RLS-scoped transaction; if the rows are
    malformed we log and skip the bad ones rather than rolling the whole
    transaction back — the pipeline_runs row + final_cards JSONB above
    is the canonical record, evaluations are scoring metadata.

    `cards` is used to derive `basket` per card (the goalBasket field).
    The agent rewrites evaluation.cardId to match cards[i].id before
    handing the payload back to web (see chat/routes/generate.py), so
    we trust that mapping here.
    """
    if not evaluations:
        return
    basket_by_card: dict[str, str | None] = {
        c.get("id"): c.get("goalBasket") for c in cards if isinstance(c, dict)
    }
    inserted = 0
    for ev in evaluations:
        if not isinstance(ev, dict):
            continue
        card_id = ev.get("cardId") or ev.get("card_id")
        if not isinstance(card_id, str) or not card_id:
            continue
        dims = ev.get("dimensions") or {}
        if not isinstance(dims, dict):
            dims = {}
        try:
            await conn.execute(
                """
                INSERT INTO pai_card_evaluations
                  (user_id, card_id, run_id, basket,
                   dim_relevance, dim_actionability, dim_why_now,
                   dim_novelty, dim_decision_compress,
                   overall, pass, evaluator, feedback_text, evaluated_at)
                VALUES (%s, %s, %s, %s,
                        %s, %s, %s,
                        %s, %s,
                        %s, %s, 'self', %s, NOW())
                ON CONFLICT (user_id, card_id) DO UPDATE SET
                  run_id = EXCLUDED.run_id,
                  basket = EXCLUDED.basket,
                  dim_relevance = EXCLUDED.dim_relevance,
                  dim_actionability = EXCLUDED.dim_actionability,
                  dim_why_now = EXCLUDED.dim_why_now,
                  dim_novelty = EXCLUDED.dim_novelty,
                  dim_decision_compress = EXCLUDED.dim_decision_compress,
                  overall = EXCLUDED.overall,
                  pass = EXCLUDED.pass,
                  feedback_text = EXCLUDED.feedback_text,
                  evaluated_at = NOW()
                """,
                (
                    user_id, card_id, run_id, basket_by_card.get(card_id),
                    dims.get("relevance"), dims.get("actionability"),
                    dims.get("whyNowClarity"),
                    dims.get("novelty"), dims.get("decisionCompression"),
                    ev.get("overall"),
                    bool(ev.get("pass")),
                    ev.get("feedback"),
                ),
            )
            inserted += 1
        except Exception:
            logger.exception(
                "persist evaluation failed user=%d run=%s card=%s",
                user_id, run_id, card_id,
            )
    logger.info(
        "persisted %d/%d evaluations user=%d run=%s",
        inserted, len(evaluations), user_id, run_id,
    )


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
                "ok": True, "taskId": existing, "runId": existing,
                "status": "queued",
                "asOf": datetime.now(UTC).isoformat(),
                "deduped": True,
            }
        # Resolve output_language: explicit body value wins (admin / A-B
        # debug); otherwise read user's persisted setting. Fixes the case
        # where the UI never sent the param and every run silently fell
        # back to "en" regardless of `generation_language`.
        output_language = body.output_language
        if output_language is None:
            settings = await ProfileRepository(user.id, conn).get_settings()
            output_language = settings.generation_language
        task_id = f"gen.{uuid.uuid4().hex[:12]}"
        await enqueue_once(
            conn,
            user_id=user.id, task_id=task_id, kind="generator.manual",
            payload={
                "cards_to_generate": body.cards_to_generate,
                "output_language": output_language,
                "trigger": trigger,
            },
            max_attempts=2,  # keep low — generator is expensive, retry once max
        )
    return {
        "ok": True, "taskId": task_id, "runId": task_id,
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
