"""/api/profile — combined profile + goals + settings snapshot for the UI."""

from __future__ import annotations

import uuid
from dataclasses import asdict

from fastapi import APIRouter, Depends, status

from ....shared.api_models import (
    GoalUpsertRequest,
    ProfileResponse,
    SettingsUpdateRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.profile import ProfileRepository
from ...db.rls import user_scoped_tx

router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("", response_model=ProfileResponse)
async def get_profile_snapshot(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        profile = await repo.get_profile()
        goals = await repo.list_goals()
        settings = await repo.get_settings()
    return ProfileResponse(
        profile=asdict(profile) if profile else None,
        goals=[asdict(g) for g in goals],
        settings=asdict(settings) if settings else None,
    )


@router.get("/goals")
async def list_goals(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        goals = await repo.list_goals()
    return {"items": [asdict(g) for g in goals]}


@router.post("/goals", status_code=status.HTTP_201_CREATED)
async def upsert_goal(
    body: GoalUpsertRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    goal_id = body.id or f"goal_{uuid.uuid4().hex[:12]}"
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        row = await repo.upsert_goal(
            id=goal_id, key=body.key, title=body.title,
            priority=body.priority, status=body.status,
            summary=body.summary,
        )
    return asdict(row)


@router.post("/goals/close", status_code=status.HTTP_204_NO_CONTENT)
async def close_goal(
    body: dict[str, str],
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    goal_id = body.get("id") or body.get("goalId") or ""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        await repo.close_goal(goal_id)
    return None


# ── settings (mounted at /api/settings/*) — separate router below ──
settings_router = APIRouter(prefix="/api/settings", tags=["settings"])


@settings_router.get("")
async def get_settings(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        s = await repo.get_settings()
    return asdict(s) if s else {}


@settings_router.post("")
async def update_settings(
    body: SettingsUpdateRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        row = await repo.upsert_settings(
            generation_language=body.generation_language,
            auto_generate=body.auto_generate,
            auto_dreaming=body.auto_dreaming,
            auto_crystallize=body.auto_crystallize,
            metadata=body.metadata,
        )
    return asdict(row)


@settings_router.get("/auto-generate")
async def get_auto_generate(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        s = await repo.get_settings()
    return {"autoGenerate": bool(s.auto_generate) if s else False}


@settings_router.post("/auto-generate")
async def set_auto_generate(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    val = bool(body.get("autoGenerate") or body.get("auto_generate"))
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        await repo.upsert_settings(auto_generate=val)
    return {"autoGenerate": val}


@settings_router.get("/generation-language")
async def get_generation_language(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        s = await repo.get_settings()
    return {
        "generationLanguage": (s.generation_language if s else "zh-Hans"),
        "options": ["en", "zh-Hans"],
    }


@settings_router.post("/generation-language")
async def set_generation_language(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    lang = body.get("generationLanguage") or body.get("generation_language") or "zh-Hans"
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        await repo.upsert_settings(generation_language=lang)
    return {"generationLanguage": lang}


# Auto-dreaming runs every 24h via scheduler; the schedule itself is
# fixed (06:00 UTC) so the wire shape is mostly the boolean toggle.
# Frontend AutoDreamingSettings reads `{ok, enabled, schedule}`.
_DREAMING_SCHEDULE = {
    "type": "daily", "hour": 6, "minute": 0, "timezone": "UTC",
}


@settings_router.get("/auto-dreaming")
async def get_auto_dreaming(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        s = await repo.get_settings()
    return {
        "ok": True,
        "enabled": bool(s.auto_dreaming) if s else False,
        "schedule": _DREAMING_SCHEDULE,
    }


@settings_router.post("/auto-dreaming")
async def set_auto_dreaming(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    val = bool(body.get("enabled") or body.get("autoDreaming") or body.get("auto_dreaming"))
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        await repo.upsert_settings(auto_dreaming=val)
    return {"ok": True, "enabled": val, "schedule": _DREAMING_SCHEDULE}
