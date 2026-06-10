"""Pipeline-run persistence — write completed runs to pai_pipeline_runs.

Moved verbatim from routes/ui/generate.py so the service layer can share
it: generator persistence (dispatcher `_run_generator`) and reminder-card
persistence (services/reminder_cards) both land cards through here.

Two entry points:
  * :func:`persist_pipeline_run_strict` — the kernel; raises on failure
    (reminder.card relies on the raise to trigger scheduler retry).
  * :func:`persist_generator_run` — best-effort wrapper with the exact
    pre-split semantics (log + swallow); generator cards already returned
    to the client, so persistence failure must not fail the run.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..db.rls import user_scoped_tx

logger = logging.getLogger(__name__)


async def persist_pipeline_run_strict(
    pool,
    *,
    user_id: int,
    payload: dict,
    trigger: str,
    matched_patterns: list[dict[str, Any]] | None = None,
) -> None:
    """落库内核:失败抛异常(reminder.card 靠它触发 retry)。

    Writes the completed run to pai_pipeline_runs + pai_card_evaluations
    so /api/cards + UI recovery flows can find them. Also persists
    pai_card_pattern_hits when the agent emits pattern_id annotations on
    its evaluations (Phase 2).

    Note on `id` vs `run_id`: the legacy schema kept these separate to
    let one pipeline span multiple LangGraph runs. Step 1 generator is
    a single agent invocation, so we set both columns to the same value
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
        await _persist_pattern_hits(
            conn,
            user_id=user_id,
            run_id=run_id,
            cards=cards,
            evaluations=evaluations,
            matched_patterns=matched_patterns or [],
        )


async def persist_generator_run(
    pool,
    *,
    user_id: int,
    payload: dict,
    trigger: str,
    matched_patterns: list[dict[str, Any]] | None = None,
) -> None:
    """Best-effort 包装(行为与 PR65 前完全一致):generator 卡片已经
    返回给客户端,落库失败只 log 不阻塞。"""
    try:
        await persist_pipeline_run_strict(
            pool,
            user_id=user_id,
            payload=payload,
            trigger=trigger,
            matched_patterns=matched_patterns,
        )
    except Exception:
        logger.exception(
            "persist generate run failed user=%d run=%s",
            user_id,
            payload.get("runId") or payload.get("run_id"),
        )


async def _persist_pattern_hits(
    conn,
    *,
    user_id: int,
    run_id: str,
    cards: list[dict[str, Any]],
    evaluations: list[dict[str, Any]],
    matched_patterns: list[dict[str, Any]],
) -> None:
    """Record one pai_card_pattern_hits row per card that the agent
    annotated with a pattern_id.

    Phase 2 sourcing rule:
      * Prefer evaluation.patternId (the evaluator decided which pattern
        this card actually realizes after seeing sources[]).
      * Fall back to card.patternId if the card-generator stamped it.
      * If neither is set, no hit row.

    Hallucinated pattern_ids (LLM emits a pattern that doesn't exist in
    pai_card_patterns) are dropped *before* the INSERT: the FK constraint
    would otherwise abort the surrounding transaction and lose the
    evaluations / pipeline_runs rows that already committed.
    """
    if not cards:
        return
    by_pattern = {
        str(m.get("patternId")): m
        for m in matched_patterns
        if isinstance(m, dict) and isinstance(m.get("patternId"), str)
    }
    eval_pattern_by_card: dict[str, dict[str, Any]] = {}
    for ev in evaluations:
        if not isinstance(ev, dict):
            continue
        cid = ev.get("cardId") or ev.get("card_id")
        if isinstance(cid, str) and cid:
            eval_pattern_by_card[cid] = ev

    # First pass: collect candidate (card_id, pattern_id, eval, match) rows.
    candidates: list[tuple[str, str, dict[str, Any], dict[str, Any]]] = []
    for card in cards:
        if not isinstance(card, dict):
            continue
        card_id = card.get("id")
        if not isinstance(card_id, str) or not card_id:
            continue
        ev = eval_pattern_by_card.get(card_id, {})
        pattern_id = (
            ev.get("patternId")
            or ev.get("pattern_id")
            or card.get("patternId")
            or card.get("pattern_id")
        )
        if not isinstance(pattern_id, str) or not pattern_id:
            continue
        candidates.append((card_id, pattern_id, ev, by_pattern.get(pattern_id, {})))

    if not candidates:
        return

    # Filter out pattern_ids that don't exist in the library (LLM
    # hallucinations) before issuing INSERTs that would otherwise trip
    # the FK and abort the surrounding transaction.
    requested = {p for _, p, _, _ in candidates}
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT id FROM pai_card_patterns WHERE id = ANY(%s)",
            (list(requested),),
        )
        existing_rows = await cur.fetchall()
    existing = {r["id"] for r in existing_rows}
    dropped = requested - existing
    if dropped:
        logger.info(
            "persist pattern hits: dropping %d hallucinated pattern_ids user=%d run=%s ids=%s",
            len(dropped),
            user_id,
            run_id,
            sorted(dropped),
        )

    inserted = 0
    for card_id, pattern_id, ev, match in candidates:
        if pattern_id not in existing:
            continue
        evidence = match.get("evidence") or {}
        base_hit_rate = match.get("baseHitRate")
        combined_score = (
            match.get("combinedScore") if match.get("combinedScore") is not None else base_hit_rate
        )
        await conn.execute(
            """
            INSERT INTO pai_card_pattern_hits
              (user_id, run_id, card_id, pattern_id, subtype,
               evidence, user_fit_score, combined_score,
               pattern_grounding_ok)
            VALUES (%s, %s, %s, %s, %s,
                    %s::jsonb, %s, %s,
                    %s)
            ON CONFLICT (user_id, card_id, pattern_id) DO UPDATE SET
              run_id = EXCLUDED.run_id,
              subtype = EXCLUDED.subtype,
              evidence = EXCLUDED.evidence,
              user_fit_score = EXCLUDED.user_fit_score,
              combined_score = EXCLUDED.combined_score,
              pattern_grounding_ok = EXCLUDED.pattern_grounding_ok
            """,
            (
                user_id,
                run_id,
                card_id,
                pattern_id,
                match.get("subtype"),
                json.dumps(evidence),
                match.get("userFitScore"),
                combined_score,
                bool(ev.get("patternGroundingOk") or ev.get("pattern_grounding_ok")),
            ),
        )
        inserted += 1
    if inserted:
        logger.info(
            "persisted %d pattern hits user=%d run=%s",
            inserted,
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
                    user_id,
                    card_id,
                    run_id,
                    basket_by_card.get(card_id),
                    dims.get("relevance"),
                    dims.get("actionability"),
                    dims.get("whyNowClarity"),
                    dims.get("novelty"),
                    dims.get("decisionCompression"),
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
