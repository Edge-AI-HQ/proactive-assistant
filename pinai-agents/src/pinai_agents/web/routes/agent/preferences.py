"""/api/agent/preferences/* — agent reads + writes high-weight preferences.

The chat agent's `preference_add` native tool POSTs here. `source` is
decided HERE from the JWT principal, never from the request body:

  * actor == 'internal_operator'  → source='internal_operator',
                                     evidence.operator_id stamped server-side
  * otherwise (normal user run)    → source='user'

This is the trust-boundary contract for impersonation (Goal 4): an
internal reviewer driving a user's chat cannot disguise a write as the
user's own words, and a normal run cannot claim it came from an operator.
"""

from __future__ import annotations

import uuid
from dataclasses import asdict

from fastapi import APIRouter, Depends, Query, status

from ....shared.api_models import (
    PreferenceAddRequest,
    PreferenceSupersedeRequest,
)
from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.preferences import AddPreferenceInput, PreferenceRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/preferences", tags=["agent-preferences"])

# User-stated preferences are high-weight by design — the whole point of
# this layer is that the user's own words are a near-hard constraint on the
# next generation. The agent does not get to dial this down.
_DEFAULT_WEIGHT = 1.0


def _resolve_source(run: AgentRun) -> tuple[str, str | None]:
    """Map the run principal to (source, operator_id). Server-enforced —
    independent of any agent-reported value."""
    if run.actor == "internal_operator":
        return "internal_operator", run.operator_id
    return "user", None


@router.post("/add", status_code=status.HTTP_201_CREATED)
async def agent_add_preference(
    body: PreferenceAddRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    source, operator_id = _resolve_source(run)
    evidence = dict(body.evidence or {})
    if operator_id is not None:
        evidence["operator_id"] = operator_id
    pref_id = f"pref_{uuid.uuid4().hex[:12]}"
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PreferenceRepository(run.user_id, conn)
        row = await repo.add(
            AddPreferenceInput(
                id=pref_id,
                statement=body.statement,
                scope=body.scope,
                polarity=body.polarity,
                weight=body.weight if body.weight is not None else _DEFAULT_WEIGHT,
                confidence=body.confidence,
                source=source,
                evidence=evidence,
            ),
        )
    return asdict(row)


@router.get("/list")
async def agent_list_preferences(
    status_filter: str = Query("active", alias="status"),
    scope: str | None = None,
    limit: int = 50,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PreferenceRepository(run.user_id, conn)
        rows = await repo.list(status=status_filter, scope=scope, limit=limit)
    return {"items": [asdict(r) for r in rows]}


@router.post("/supersede")
async def agent_supersede_preference(
    body: PreferenceSupersedeRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Mark old_id superseded by new_id. new_id must already be an active
    preference of this user (the repository asserts it)."""
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = PreferenceRepository(run.user_id, conn)
        row = await repo.supersede(old_id=body.old_id, new_id=body.new_id)
    return asdict(row) if row else None
