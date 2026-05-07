"""/api/agent/state/{ns}/{key} — generic per-user KV.

Used for crystallize state, agent run scratch state, custom UI prefs.
PinCLI: pin state get/set --ns ... --key ...
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.app_state import AppStateRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/state", tags=["agent-state"])


@router.get("/{namespace}/{key}")
async def get_state(
    namespace: str, key: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = AppStateRepository(run.user_id, conn)
        v = await repo.get(namespace, key)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not set")
    return {"namespace": namespace, "key": key, "value": v}


@router.put("/{namespace}/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def put_state(
    namespace: str, key: str,
    body: Any = Body(...),
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = AppStateRepository(run.user_id, conn)
        await repo.set(namespace, key, body)
    return None


@router.delete("/{namespace}/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_state(
    namespace: str, key: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = AppStateRepository(run.user_id, conn)
        await repo.delete(namespace, key)
    return None
