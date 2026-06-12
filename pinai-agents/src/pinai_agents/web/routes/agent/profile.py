"""/api/agent/profile/* — agent reads + writes user profile + goals.

PinCLI: pin profile get / set, pin goals upsert
"""

from __future__ import annotations

import uuid
from dataclasses import asdict
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, status

from ....shared.api_models import (
    GenerationLanguageSetRequest,
    GoalUpsertRequest,
    ProfilePreferenceMergeRequest,
    ProfileUpsertRequest,
)
from ...auth.deps import AgentRun, current_agent_run, get_pool
from ...db.repositories.profile import ProfileRepository
from ...db.rls import user_scoped_tx
from ...services.scheduled_generators import retime_user_cron_tasks

# Reuse the UI settings route's schedule re-stamp (don't copy the impl). No
# import cycle: ui.profile imports nothing from routes/agent/*.
from ..ui.profile import _sync_auto_generate_schedule

router = APIRouter(prefix="/api/agent/profile", tags=["agent-profile"])


@router.get("/get")
async def agent_get_profile(
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        profile = await repo.get_profile()
        goals = await repo.list_goals(status="active")
    return {
        "profile": asdict(profile) if profile else None,
        "goals": [asdict(g) for g in goals],
    }


@router.post("/upsert")
async def agent_upsert_profile(
    body: ProfileUpsertRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    # timezone 是会被 next_fire/ZoneInfo 直接消费的值:非法字符串这里就挡
    # 回去(400 → agent 拿到工具错误自行纠正),不能写进库里等下游炸。
    if body.timezone is not None:
        try:
            ZoneInfo(body.timezone)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"invalid IANA timezone: {body.timezone!r}",
            ) from e
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        before = await repo.get_profile()
        row = await repo.upsert_profile(
            display_name=body.display_name,
            locale=body.locale,
            timezone=body.timezone,
            summary=body.summary,
            facts=body.facts,
            preferences=body.preferences,
            constraints=body.constraints,
            metadata=body.metadata,
        )
        # 与设备头通道(_sync_device_timezone)同语义:时区真的变了就把
        # 周期任务的"每天 X 点"重排到新时区——否则 agent 改时区后既有
        # 任务仍按旧时区触发。注意:agent 写的时区仍会被下一次设备头同步
        # 覆盖(手机是事实源),这是设计内行为。
        if body.timezone is not None and (before is None or before.timezone != body.timezone):
            await retime_user_cron_tasks(conn, user_id=run.user_id, timezone=body.timezone)
    return asdict(row)


@router.post("/preferences/merge")
async def agent_merge_profile_preference(
    body: ProfilePreferenceMergeRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Merge one durable preference into pai_profile.preferences.

    Profile JSONB buckets are replaced wholesale by the generic upsert
    endpoint, so this one-key merge route is the safer native-tool path
    for main chat.
    """
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        row = await repo.merge_profile_preference(key=body.key, value=body.value)
    return asdict(row)


@router.post("/goals/upsert", status_code=status.HTTP_201_CREATED)
async def agent_upsert_goal(
    body: GoalUpsertRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Insert a new goal or update an existing one. Mirror of the UI
    /api/profile/goals route, scoped to agent JWT so chat / dream / evolve
    agents can persist user-stated goals from conversation."""
    goal_id = body.id or f"goal_{uuid.uuid4().hex[:12]}"
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        row = await repo.upsert_goal(
            id=goal_id,
            key=body.key,
            title=body.title,
            priority=body.priority,
            status=body.status,
            summary=body.summary,
        )
    return asdict(row)


@router.post("/settings/generation-language")
async def agent_set_generation_language(
    body: GenerationLanguageSetRequest,
    run: AgentRun = Depends(current_agent_run),
    pool=Depends(get_pool),
):
    """Flip the user's `generation_language` from chat (the user said
    "use English from now on"). Language must take effect deterministically
    — so this re-stamps the auto-generate schedule payload's
    `output_language` via the exact same helper the UI settings route uses
    (`_sync_auto_generate_schedule`), not by hoping the next planner reads
    a preference row. Returns the updated settings row.
    """
    async with user_scoped_tx(pool, run.user_id) as conn:
        repo = ProfileRepository(run.user_id, conn)
        row = await repo.upsert_settings(
            generation_language=body.generation_language,
        )
        await _sync_auto_generate_schedule(conn, user_id=run.user_id, settings=row)
    return asdict(row)
