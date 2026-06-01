"""/api/skills/* — frontend skills CRUD.

Response shape matches frontend lib/api.ts (Skill type):
  GET /api/skills        → { ok, skills: [...] } (no body)
  GET /api/skills/:id    → { ok, skill: {...,body} }
  POST /api/skills       → { ok, skill }
  PATCH /api/skills/:id  → { ok, skill }
  DELETE /api/skills/:id → { ok, skill (status='archived') }

Triggers JSONB; body markdown inline (Step 0b moves to Storage).
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.skills import SkillRow, SkillsRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/skills", tags=["skills"])


def _to_dict(row: SkillRow) -> dict:
    d = asdict(row)
    # Frontend expects ISO timestamps, not datetime objects (Pydantic
    # would handle this on response_model, but we're using dict here so
    # convert manually).
    for k in ("enabled_at", "disabled_at", "created_at", "updated_at", "last_referenced_at"):
        v = d.get(k)
        if v is not None and hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


@router.get("")
async def list_skills(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    status_filter: str | None = Query(
        None, alias="status", pattern="^(enabled|disabled|archived)$"
    ),
    limit: int = Query(50, ge=1, le=200),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = SkillsRepository(user.id, conn)
        rows = await repo.list(status=status_filter, limit=limit)
    return {"ok": True, "skills": [_to_dict(r) for r in rows]}


@router.get("/{skill_id}")
async def get_skill(
    skill_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = SkillsRepository(user.id, conn)
        row = await repo.get(skill_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="skill not found",
        )
    return {"ok": True, "skill": _to_dict(row)}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_skill(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    title = body.get("title")
    if not title or not isinstance(title, str):
        raise HTTPException(status_code=400, detail="title required")
    body_md = body.get("body") or ""
    if not isinstance(body_md, str):
        raise HTTPException(status_code=400, detail="body must be a string")
    triggers = body.get("triggers") or []
    if not isinstance(triggers, list):
        raise HTTPException(status_code=400, detail="triggers must be a list")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = SkillsRepository(user.id, conn)
        row = await repo.add(
            title=title,
            body=body_md,
            description=body.get("description"),
            triggers=[str(t) for t in triggers],
            status=body.get("status", "enabled"),
            source=body.get("source", "manual"),
        )
    return {"ok": True, "skill": _to_dict(row)}


@router.patch("/{skill_id}")
async def patch_skill(
    skill_id: str,
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = SkillsRepository(user.id, conn)
        row = await repo.patch(
            skill_id,
            title=body.get("title"),
            description=body.get("description"),
            body=body.get("body"),
            triggers=body.get("triggers"),
            status=body.get("status"),
        )
    if row is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return {"ok": True, "skill": _to_dict(row)}


@router.delete("/{skill_id}")
async def archive_skill(
    skill_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = SkillsRepository(user.id, conn)
        row = await repo.archive(skill_id)
    if row is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return {"ok": True, "skill": _to_dict(row)}
