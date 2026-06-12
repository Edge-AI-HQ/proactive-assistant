"""/api/runs/* + /api/cards + /api/health + /api/status — frontend pipeline view.

Response shapes are tailored to the existing TypeScript consumers in
proactive-ai-frontend (`hooks/usePipeline.ts`, `useCards.ts`,
`useGenerationStatus.ts`). They expect:

- /runs/active → { ok, run } where run is the row in camelCase or null
- /runs/{id}   → { ok, run } where run carries finalCards / batchFeedback
- /cards       → { cards: [{ card, runId, runCompletedAt, score, latestOutcome,
                  outcomeAt, runStatus }] }
- /status      → { pipelineRunning, latestRun, lastResult, asOf }

Direct SQL (no Repository) intentionally — the table's other readers /
writers also use raw SQL, and a Repo for four read endpoints would add
indirection without saving lines.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import User, current_user, get_pool
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api", tags=["runs"])

# pai_agent_runs.status values (083_pai_agent_core.sql CHECK constraint).
# /cards re-validates against this set so a future enum addition can't leak
# an unknown literal to the TS contract unnoticed.
_AGENT_RUN_STATUSES = frozenset(
    {"pending", "running", "awaiting_input", "succeeded", "failed", "cancelled"}
)


# ── helpers ──

_SNAKE_TO_CAMEL_OVERRIDES: dict[str, str] = {
    # The TS contract names this `runStartedAt` only on the /cards entry
    # shape; on a run row it's `startedAt`. _row_to_camel handles the
    # row-level case via the standard transform.
}


def _to_camel(snake: str) -> str:
    parts = snake.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _row_to_camel(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """psycopg returns rows with snake_case keys; the TS contract is
    camelCase. Keep datetime → ISO 8601 string conversion here so callers
    don't sprinkle it everywhere."""
    if row is None:
        return None
    out: dict[str, Any] = {}
    for k, v in row.items():
        key = _SNAKE_TO_CAMEL_OVERRIDES.get(k, _to_camel(k))
        if isinstance(v, datetime):
            out[key] = v.isoformat()
        else:
            out[key] = v
    return out


# ── routes ──


@router.get("/health")
async def api_health(
    user: User = Depends(current_user),
):
    """Authenticated health probe — confirms Supabase JWT verifies."""
    return {"status": "ok", "userId": user.id}


@router.get("/status")
async def api_status(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Pipeline status snapshot. Two SQL hits:

      - latest in-flight run (for the spinner)
      - latest completed run (for refresh recovery — usePipeline reads
        `lastResult.finalCards` to repopulate the NOW view after a tab
        reload).

    Returning both lets the frontend pick the right one without polling
    /runs/active and /runs separately on mount.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        cur_active = await conn.execute(
            """
            SELECT id, run_id, status, started_at, completed_at, total_iterations
            FROM pai_pipeline_runs
            WHERE user_id = %s AND status IN ('running', 'reconciling')
            ORDER BY started_at DESC LIMIT 1
            """,
            (user.id,),
        )
        active_row = await cur_active.fetchone()

        cur_latest = await conn.execute(
            """
            SELECT id, run_id, status, started_at, completed_at,
                   total_iterations, final_cards, error
            FROM pai_pipeline_runs
            WHERE user_id = %s
            ORDER BY started_at DESC LIMIT 1
            """,
            (user.id,),
        )
        latest_row = await cur_latest.fetchone()

    pipeline_running = active_row is not None
    latest = _row_to_camel(latest_row)

    last_result: dict[str, Any] | None = None
    if (
        latest_row is not None
        and latest_row.get("status") == "completed"
        and latest_row.get("final_cards") is not None
    ):
        # Frontend reads lastResult.{finalCards, batchFeedback, completedAt, id}.
        # batchFeedback isn't persisted today (no column); leave null and
        # the UI degrades gracefully.
        last_result = {
            "id": latest_row["id"],
            "runId": latest_row["run_id"],
            "finalCards": latest_row["final_cards"],
            "batchFeedback": None,
            "completedAt": (
                latest_row["completed_at"].isoformat() if latest_row.get("completed_at") else None
            ),
        }

    return {
        "pipelineRunning": pipeline_running,
        "activeRun": _row_to_camel(active_row),
        "latestRun": latest,
        "lastResult": last_result,
        "asOf": datetime.now(UTC).isoformat(),
    }


@router.get("/runs")
async def list_runs(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    limit: int = Query(20, ge=1, le=100),
):
    """Latest completed runs. Read-mostly; UI uses this for history view."""
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            """
            SELECT id, run_id, status, started_at, completed_at, total_iterations
            FROM pai_pipeline_runs
            WHERE user_id = %s
            ORDER BY started_at DESC LIMIT %s
            """,
            (user.id, limit),
        )
        rows = await cur.fetchall()
    return {"runs": [_row_to_camel(r) for r in rows]}


@router.get("/runs/active")
async def get_active_run(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Single in-flight run or null. Used by frontend generation indicator
    (`useGenerationStatus`), which reads `data.run`."""
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            """
            SELECT * FROM pai_pipeline_runs
            WHERE user_id = %s AND status IN ('running', 'reconciling')
            ORDER BY started_at DESC LIMIT 1
            """,
            (user.id,),
        )
        row = await cur.fetchone()
    return {"ok": True, "run": _row_to_camel(row)}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """One run by id. Frontend `usePipeline.pollRunOnce` reads
    `data.ok && data.run` then `run.finalCards` / `run.batchFeedback`.

    `id` and `run_id` are the same value for runs persisted by
    /api/generate (see web/routes/ui/generate.py:_persist_run); we query
    `id` because that's the table's primary key half. Older rows
    persisted via /api/agent/pipeline/create may have differing `id`
    (pl_<uuid>) vs `run_id` — those are reachable here only via their
    pl_<uuid> as documented in the agent pipeline route.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            "SELECT * FROM pai_pipeline_runs WHERE user_id = %s AND id = %s",
            (user.id, run_id),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="run not found",
        )
    return {"ok": True, "run": _row_to_camel(row)}


@router.get("/cards")
async def list_cards(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    limit: int = Query(200, ge=1, le=1000),
):
    """Flat card list across recent runs.

    Wire shape (TS contract `useCards.parseEntries`):
      { cards: [{ card, runId, runCompletedAt, score, latestOutcome,
                  outcomeAt, runStatus }] }
      score: { overall: number, pass: boolean } | null
      runStatus: pai_agent_runs.status | null

    Per-card score comes from pai_card_evaluations (1:1 with card_id).
    Latest user outcome comes from pai_feedback_events, so cold-started
    clients do not need to race /feedback/{dismissed,completed} against
    /cards before deciding whether a card is still actionable.

    `runStatus` is the latest pai_agent_runs row of the card's execution
    thread (session_id = 'card-thread-<card_id>'), so a relaunched client
    can tell running / awaiting_input / succeeded / failed apart instead of
    keeping that state in memory. null = the card's thread never ran. Note
    the generator fanout pre-runs top cards on the same path, so a terminal
    runStatus alone does NOT imply the user started the card — the FE gates
    on its own engagement signals (latestOutcome / local action state).
    """
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            """
            WITH latest_feedback AS (
              SELECT DISTINCT ON (intent_card_id)
                intent_card_id,
                CASE
                  WHEN action IS NOT NULL THEN action
                  WHEN kind IN ('dismiss', 'snooze') THEN kind
                  ELSE NULL
                END AS latest_outcome,
                created_at
              FROM pai_feedback_events
              WHERE user_id = %s
                AND intent_card_id IS NOT NULL
                AND (
                  action IN ('confirm', 'modify', 'dismiss', 'snooze', 'complete')
                  OR kind IN ('dismiss', 'snooze')
                )
              ORDER BY intent_card_id, created_at DESC
            ),
            feedback_map AS (
              SELECT COALESCE(
                jsonb_object_agg(
                  intent_card_id,
                  jsonb_build_object(
                    'latestOutcome', latest_outcome,
                    'outcomeAt', created_at
                  )
                ) FILTER (WHERE latest_outcome IS NOT NULL),
                '{}'::jsonb
              ) AS outcomes
              FROM latest_feedback
            ),
            -- Latest execution-run status per card thread. substr strips the
            -- 'card-thread-' prefix (12 chars) so the map is keyed by card_id,
            -- same as evals / outcomes.
            card_run_map AS (
              SELECT COALESCE(
                jsonb_object_agg(substr(session_id, 13), status),
                '{}'::jsonb
              ) AS run_statuses
              FROM (
                SELECT DISTINCT ON (session_id) session_id, status
                FROM pai_agent_runs
                WHERE user_id = %s AND session_id LIKE 'card-thread-%%'
                ORDER BY session_id, created_at DESC
              ) latest_runs
            )
            SELECT
              r.id,
              r.run_id,
              r.completed_at,
              r.final_cards,
              COALESCE(
                jsonb_object_agg(
                  e.card_id,
                  jsonb_build_object('overall', e.overall, 'pass', e.pass)
                ) FILTER (WHERE e.card_id IS NOT NULL),
                '{}'::jsonb
              ) AS evals,
              fm.outcomes,
              crm.run_statuses
            FROM pai_pipeline_runs r
            LEFT JOIN pai_card_evaluations e
              ON e.user_id = r.user_id AND e.run_id = r.run_id
            CROSS JOIN feedback_map fm
            CROSS JOIN card_run_map crm
            WHERE r.user_id = %s
              AND r.status = 'completed'
              AND r.final_cards IS NOT NULL
              AND r.completed_at IS NOT NULL
            GROUP BY r.id, r.run_id, r.completed_at, r.final_cards,
                     fm.outcomes, crm.run_statuses
            ORDER BY r.completed_at DESC
            LIMIT %s
            """,
            (user.id, user.id, user.id, limit),
        )
        rows = await cur.fetchall()

    out: list[dict[str, Any]] = []
    for r in rows:
        # SELECT filters completed_at IS NOT NULL, so this is non-null
        # whenever the row reached the loop.
        run_completed_at = r["completed_at"].isoformat()
        evals = r.get("evals") or {}
        outcomes = r.get("outcomes") or {}
        run_statuses = r.get("run_statuses") or {}
        for c in r.get("final_cards") or []:
            if not isinstance(c, dict):
                continue
            card_id = c.get("id")
            score_raw = evals.get(card_id) if isinstance(evals, dict) else None
            outcome_raw = (
                outcomes.get(card_id)
                if isinstance(card_id, str) and isinstance(outcomes, dict)
                else None
            )
            score: dict[str, Any] | None = None
            if isinstance(score_raw, dict) and "overall" in score_raw and "pass" in score_raw:
                score = {
                    "overall": float(score_raw["overall"])
                    if score_raw["overall"] is not None
                    else 0.0,
                    "pass": bool(score_raw["pass"]),
                }
            latest_outcome: str | None = None
            outcome_at: str | None = None
            if isinstance(outcome_raw, dict):
                raw_outcome = outcome_raw.get("latestOutcome")
                raw_at = outcome_raw.get("outcomeAt")
                latest_outcome = raw_outcome if isinstance(raw_outcome, str) else None
                outcome_at = raw_at if isinstance(raw_at, str) else None
            run_status_raw = (
                run_statuses.get(card_id)
                if isinstance(card_id, str) and isinstance(run_statuses, dict)
                else None
            )
            run_status = run_status_raw if run_status_raw in _AGENT_RUN_STATUSES else None
            out.append(
                {
                    "card": c,
                    "runId": r["run_id"],
                    "runCompletedAt": run_completed_at,
                    "score": score,
                    "latestOutcome": latest_outcome,
                    "outcomeAt": outcome_at,
                    "runStatus": run_status,
                }
            )
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break
    return {"cards": out}
