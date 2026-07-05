"""Pipeline-run persistence — write completed runs to pai_pipeline_runs.

Two entry points:
  * :func:`persist_pipeline_run_strict` — the kernel; raises on failure
    (reminder.card relies on the raise to trigger scheduler retry).
  * :func:`persist_generator_run` — best-effort wrapper; generator cards
    already returned to the client, so persistence failure must not fail
    the run.

Card decisions → L1 (design §4.3): each generated card also appends one
`agent_decision` event in the SAME transaction — the generation side's ONLY
L1 write. Silent runs (0 cards) write nothing anywhere. Reminder cards
(zero-LLM scheduled nudges) are not AI proposals, so they skip the decision
write (`record_decisions=False`).

Pattern hits persistence is retired with the pattern matcher (design §六
后续迭代); `pai_card_evaluations` keeps its write path for wire compat but
the agentic generator sends no evaluations, so it no-ops.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any

from pinai_db.rls import user_scoped_tx

from ..memory.events import AppendEventInput, EventsRepository, gen_event_id

logger = logging.getLogger(__name__)

# Card citations are `{toolkit} event id={event id}, title=…` — pull the
# event ids back out so the decision event can anchor to its evidence.
_EVENT_ID_RE = re.compile(r"id=(evt_[a-z0-9_-]+)", re.IGNORECASE)


async def persist_pipeline_run_strict(
    pool,
    *,
    user_id: int,
    payload: dict,
    trigger: str,
    record_decisions: bool = True,
) -> None:
    """落库内核:失败抛异常(reminder.card 靠它触发 retry)。

    Writes the completed run to pai_pipeline_runs (+ pai_card_evaluations
    when the payload carries evaluations) and appends one L1 agent_decision
    event per card in the same transaction (`record_decisions=True`).

    Note on `id` vs `run_id`: the legacy schema kept these separate to
    let one pipeline span multiple LangGraph runs. The generator is a
    single agent invocation, so we set both columns to the same value
    — the run_id the client got from /api/generate is also what they
    send to /api/runs/{id} for polling.
    """
    run_id = payload.get("runId") or payload.get("run_id")
    if not run_id:
        raise ValueError("pipeline run payload missing runId")
    cards = payload.get("cards") or []
    iterations = payload.get("iterations")
    evaluations = payload.get("evaluations") or []
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
            ON CONFLICT (user_id, id) DO UPDATE SET
              run_id = EXCLUDED.run_id,
              status = 'completed',
              trigger = EXCLUDED.trigger,
              final_cards = EXCLUDED.final_cards,
              iterations = COALESCE(EXCLUDED.iterations, pai_pipeline_runs.iterations),
              completed_at = NOW(),
              updated_at = NOW()
            """,
            (
                user_id,
                run_id,
                run_id,
                trigger,
                json.dumps(cards),
                json.dumps(iterations) if iterations is not None else None,
            ),
        )
        await _persist_evaluations(
            conn,
            user_id=user_id,
            run_id=run_id,
            cards=cards,
            evaluations=evaluations,
        )
        if record_decisions:
            await _append_card_decisions(
                conn,
                user_id=user_id,
                run_id=run_id,
                cards=cards,
            )


async def persist_generator_run(
    pool,
    *,
    user_id: int,
    payload: dict,
    trigger: str,
) -> None:
    """Best-effort 包装:generator 卡片已经返回给客户端,落库失败只 log
    不阻塞。"""
    try:
        await persist_pipeline_run_strict(
            pool,
            user_id=user_id,
            payload=payload,
            trigger=trigger,
        )
    except Exception:
        logger.exception(
            "persist generate run failed user=%d run=%s",
            user_id,
            payload.get("runId") or payload.get("run_id"),
        )


async def _append_card_decisions(
    conn,
    *,
    user_id: int,
    run_id: str,
    cards: list[dict[str, Any]],
) -> None:
    """One L1 `agent_decision` event per generated card — the generation
    side's only L1 write (design §4.3: 出卡才进 L1,静默零写入).

    `structured.kind="proactive_proposal"` keeps these distinguishable from
    memory_edit's portrait-change events (same source/event_type).
    `dedupe_key` is derived from the card id, so re-persisting the same run
    (ON CONFLICT upsert above) no-ops here too. `curated=True` — an agent
    proposal needs no evolve judgement (same stance as the memory_edit
    double-write)."""
    now = datetime.now(UTC)
    repo = EventsRepository(user_id, conn)
    for card in cards:
        if not isinstance(card, dict):
            continue
        card_id = card.get("id")
        title = card.get("title")
        if not isinstance(card_id, str) or not card_id or not title:
            continue
        sources = [s for s in (card.get("sources") or []) if isinstance(s, str)]
        related_event_ids = sorted({m.group(1) for s in sources for m in _EVENT_ID_RE.finditer(s)})
        await repo.append(
            AppendEventInput(
                id=gen_event_id(),
                source="agent_action",
                event_type="agent_decision",
                occurred_at=now,
                title=f"Card proposed: {title}"[:200],
                body=card.get("whyNow"),
                structured={
                    "kind": "proactive_proposal",
                    "card_id": card_id,
                    "run_id": run_id,
                    "related_event_ids": related_event_ids,
                },
                dedupe_key=f"card_decision:{card_id}",
                curated=True,
            )
        )
    if cards:
        logger.info(
            "appended %d card-decision events user=%d run=%s",
            len(cards),
            user_id,
            run_id,
        )


async def _persist_evaluations(
    conn,
    *,
    user_id: int,
    run_id: str,
    cards: list[dict[str, Any]],
    evaluations: list[dict[str, Any]],
) -> None:
    """Insert one pai_card_evaluations row per evaluation entry.

    The agentic generator sends no evaluations (the evaluator stage is
    retired), so this is a no-op on the main path — kept because the table
    still exists (expand-contract) and legacy payload replays remain valid.

    Best-effort within the same RLS-scoped transaction; if the rows are
    malformed we log and skip the bad ones rather than rolling the whole
    transaction back — the pipeline_runs row + final_cards JSONB above
    is the canonical record, evaluations are scoring metadata.
    """
    if not evaluations:
        return
    basket_by_card: dict[str, str | None] = {
        cid: c.get("goalBasket")
        for c in cards
        if isinstance(c, dict) and isinstance(cid := c.get("id"), str)
    }
    inserted = 0
    for ev in evaluations:
        if not isinstance(ev, dict):
            continue
        card_id = ev.get("cardId") or ev.get("card_id")
        if not isinstance(card_id, str) or not card_id:
            continue
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
                    user_id,
                    card_id,
                    run_id,
                    basket_by_card.get(card_id),
                    ev.get("relevance"),
                    ev.get("actionability"),
                    ev.get("whyNowClarity"),
                    ev.get("novelty"),
                    ev.get("decisionCompression"),
                    ev.get("overall"),
                    bool(ev.get("pass")),
                    ev.get("feedback"),
                ),
            )
            inserted += 1
        except Exception:
            logger.exception(
                "persist evaluation failed user=%d run=%s card=%s",
                user_id,
                run_id,
                card_id,
            )
    logger.info(
        "persisted %d/%d evaluations user=%d run=%s",
        inserted,
        len(evaluations),
        user_id,
        run_id,
    )
