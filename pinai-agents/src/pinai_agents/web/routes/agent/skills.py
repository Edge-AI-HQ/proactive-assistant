"""/api/agent/skills/* — agent-side skills CRUD (HS256 JWT).

Same Repository as /api/skills, just swapped onto the agent run dep.
The skill index is the agent's writable knowledge base — dream / evolve
agents add or revise skills as they crystallize new patterns.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.skills import SkillRow, SkillsRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/agent/skills", tags=["agent-skills"])


def _to_dict(row: SkillRow) -> dict:
    d = asdict(row)
    for k in (
        "enabled_at", "disabled_at", "created_at", "updated_at",
        "last_referenced_at",
    ):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


@router.get("/list")
async def list_skills(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
    status_filter: str | None = Query(
        None, alias="status", pattern="^(enabled|disabled|archived)$"),
    limit: int = Query(50, ge=1, le=200),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = SkillsRepository(run.user_id, conn)
        rows = await repo.list(status=status_filter, limit=limit)
    return {"items": [_to_dict(r) for r in rows]}


@router.get("/get/{skill_id}")
async def get_skill(
    skill_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = SkillsRepository(run.user_id, conn)
        row = await repo.get(skill_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="skill not found",
        )
    return _to_dict(row)


@router.post("/add")
async def add_skill(
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    title = body.get("title")
    body_md = body.get("body") or ""
    if not isinstance(title, str) or not title.strip():
        raise HTTPException(status_code=400, detail="title required")
    if not isinstance(body_md, str):
        raise HTTPException(status_code=400, detail="body must be a string")
    triggers = body.get("triggers") or []
    if not isinstance(triggers, list):
        raise HTTPException(status_code=400, detail="triggers must be a list")
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = SkillsRepository(run.user_id, conn)
        row = await repo.add(
            title=title,
            body=body_md,
            description=body.get("description"),
            triggers=[str(t) for t in triggers],
            status=body.get("status", "enabled"),
            source=body.get("source", "agent"),
            created_run_id=run.run_id,
        )
    return _to_dict(row)


@router.patch("/{skill_id}")
async def patch_skill(
    skill_id: str,
    body: dict,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = SkillsRepository(run.user_id, conn)
        row = await repo.patch(
            skill_id,
            title=body.get("title"),
            description=body.get("description"),
            body=body.get("body"),
            triggers=body.get("triggers"),
            status=body.get("status"),
            last_updated_run_id=run.run_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return _to_dict(row)


@router.delete("/{skill_id}")
async def archive_skill(
    skill_id: str,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = SkillsRepository(run.user_id, conn)
        row = await repo.archive(skill_id)
    if row is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return _to_dict(row)
