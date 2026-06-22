"""/api/agent/generate — chat-agent-triggered card generation.

The main chat agent's `generate_card` tool calls this so the user can
ask, in conversation, for a card about something they care about. We
enqueue a `generator.chat` task (kind sibling of `generator.manual` /
`generator.auto`) and return immediately — the scheduler dispatcher
runs the LLM pipeline and persists to pai_pipeline_runs, exactly like
the home "Generate" button. The new card then surfaces on the Now page
(GET /api/cards).

Why a distinct `generator.chat` kind:
  * The home button (`/api/generate`) dedups against in-flight
    `generator.manual` tasks so a double-click can't spawn two batches.
    A chat request is intentional and may carry a different `focus`
    each time, so we do NOT coalesce by focus — but we DO bound how many
    chat-triggered generations can run at once per user (see
    `_MAX_INFLIGHT_CHAT_GENERATIONS`) so a tool-call loop or rapid asks
    can't fan out unbounded parallel pipelines.
  * Using its own kind keeps the button's dedup semantics clean: a
    chat-triggered run never masks a button press and vice versa.

`focus` is optional: present → planner biases candidates toward that
topic (still grounding-strict); absent → normal signal-driven batch.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Body, Depends, status
from pinai_db.rls import user_scoped_tx
from pydantic import BaseModel, Field, StrictInt

from ...platform.auth.deps import AgentRun, current_agent_run, get_pool
from .generator_tasks import enqueue_generator_task

router = APIRouter(prefix="/api/agent/generate", tags=["agent-generate"])

# Per-user ceiling on concurrently-active chat-triggered generations. Bounds
# the cost/load of a tool-call loop or a user spamming "make me a card" — each
# task is a full generator pipeline (LLM stages + sandbox + pattern match).
_MAX_INFLIGHT_CHAT_GENERATIONS = 3


class AgentGenerateRequest(BaseModel):
    # Optional topic. When set, the generator planner prioritizes
    # candidates serving this focus. Omit for a normal batch.
    focus: str | None = Field(default=None, max_length=400)
    # Chat-triggered generation defaults small (a focused ask wants 1-3
    # cards, not a full batch); model can raise it up to the batch cap.
    cards_to_generate: StrictInt = Field(default=3, ge=1, le=8)
    output_language: str | None = Field(default=None, max_length=20)


async def _count_active_chat_generations(conn, user_id: int) -> int:
    cur = await conn.execute(
        """
        SELECT count(*) AS n FROM pai_scheduled_tasks
        WHERE user_id = %s AND kind = 'generator.chat' AND status = 'active'
        """,
        (user_id,),
    )
    row = await cur.fetchone()
    return int(row["n"]) if row else 0


@router.post("", status_code=status.HTTP_202_ACCEPTED)
async def agent_generate(
    body: AgentGenerateRequest = Body(default_factory=AgentGenerateRequest),
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Enqueue a chat-triggered generator task. Returns the task/run id;
    the scheduler does the LLM run + persistence. The card appears on the
    Now page once the task completes (frontend polls /api/cards).

    Returns `{ok: false, status: "busy"}` (still HTTP 202) when the user
    already has the max number of chat generations in flight — the caller
    surfaces this to the user instead of silently fanning out more."""
    # Trust boundary: chat-supplied focus is normalized here (untrusted →
    # web). Downstream layers trust the stored value.
    focus = body.focus.strip() if body.focus and body.focus.strip() else None
    async with user_scoped_tx(pool, run.user_id) as conn:
        if (
            await _count_active_chat_generations(conn, run.user_id)
            >= _MAX_INFLIGHT_CHAT_GENERATIONS
        ):
            return {
                "ok": False,
                "status": "busy",
                "reason": "too_many_in_flight",
                "limit": _MAX_INFLIGHT_CHAT_GENERATIONS,
                "asOf": datetime.now(UTC).isoformat(),
            }
        task_id = await enqueue_generator_task(
            conn,
            user_id=run.user_id,
            kind="generator.chat",
            cards_to_generate=body.cards_to_generate,
            output_language=body.output_language,
            trigger="chat",
            focus=focus,
        )
    return {
        "ok": True,
        "taskId": task_id,
        "runId": task_id,
        "status": "queued",
        "focus": focus,
        "asOf": datetime.now(UTC).isoformat(),
    }
