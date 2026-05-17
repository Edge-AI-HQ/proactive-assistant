"""/api/profile — combined profile + goals + settings snapshot for the UI."""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, status
from psycopg import AsyncConnection

from ....shared.api_models import (
    GoalUpsertRequest,
    ProfileResponse,
    SettingsResponse,
    SettingsUpdateRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.profile import ProfileRepository, UserSettingsRow
from ...db.repositories.scheduled_tasks import ScheduledTasksRepository
from ...db.rls import user_scoped_tx


def _auto_generate_task_id(user_id: int) -> str:
    return f"gen.auto.{user_id}"


async def _sync_auto_generate_schedule(
    conn: AsyncConnection, *, user_id: int, settings: UserSettingsRow,
) -> None:
    """Reflect (auto_generate, interval, generation_language) into the
    recurring `generator` schedule task. One row per user, idempotent.
    Disabled = status='archived' so the tick loop skips it but we don't
    lose the row's history. Called unconditionally on settings updates —
    cheap, and it's the only place that owns the schedule's payload
    (output_language) so any settings change must re-stamp it.
    """
    task_id = _auto_generate_task_id(user_id)
    if settings.auto_generate:
        interval_seconds = settings.auto_generate_interval_minutes * 60
        await ScheduledTasksRepository(user_id, conn).upsert(
            id=task_id, kind="generator.auto", trigger_kind="schedule",
            interval_seconds=interval_seconds,
            next_run_at=datetime.now(UTC) + timedelta(seconds=interval_seconds),
            payload={
                "cards_to_generate": 4,
                "output_language": settings.generation_language,
                "trigger": "auto",
            },
            status="active",
        )
    else:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE pai_scheduled_tasks "
                "SET status='archived', next_run_at=NULL, updated_at=NOW() "
                "WHERE user_id=%s AND id=%s",
                (user_id, task_id),
            )


async def _ensure_auto_generate_schedule(
    conn: AsyncConnection, *, user_id: int, settings: UserSettingsRow,
) -> None:
    """Read-path counterpart to `_sync_auto_generate_schedule`: only acts
    when the schedule task row is missing for an enabled user. Used on
    GET so brand-new users (lazy-created settings row from DB DEFAULTs
    = ON / 12h) actually get a schedule, without bumping `next_run_at`
    on every page refresh — that would push the fire indefinitely.
    """
    if not settings.auto_generate:
        return
    task_id = _auto_generate_task_id(user_id)
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM pai_scheduled_tasks WHERE user_id=%s AND id=%s",
            (user_id, task_id),
        )
        if await cur.fetchone() is not None:
            return
    await _sync_auto_generate_schedule(conn, user_id=user_id, settings=settings)


def _settings_response(row: UserSettingsRow) -> SettingsResponse:
    return SettingsResponse(**asdict(row))


def _clean_client_locale(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip()[:20]
    if len(cleaned) < 2:
        return None
    if not all(ch.isalnum() or ch == "-" for ch in cleaned):
        return None
    return cleaned


def _clean_client_timezone(value: str | None) -> str | None:
    if not value:
        return None
    cleaned = value.strip()[:64]
    try:
        ZoneInfo(cleaned)
    except ZoneInfoNotFoundError:
        return None
    return cleaned


router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("", response_model=ProfileResponse)
async def get_profile_snapshot(
    x_pin_client_locale: str | None = Header(default=None, alias="X-Pin-Client-Locale"),
    x_pin_client_timezone: str | None = Header(default=None, alias="X-Pin-Client-Timezone"),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        profile = await repo.get_profile()
        locale_hint = _clean_client_locale(x_pin_client_locale)
        timezone_hint = _clean_client_timezone(x_pin_client_timezone)
        locale_patch = (
            locale_hint
            if profile and profile.locale == "en-US" and locale_hint and locale_hint != profile.locale
            else None
        )
        timezone_patch = (
            timezone_hint
            if profile and profile.timezone == "UTC" and timezone_hint and timezone_hint != profile.timezone
            else None
        )
        if locale_patch or timezone_patch:
            profile = await repo.upsert_profile(
                locale=locale_patch,
                timezone=timezone_patch,
            )
        goals = await repo.list_goals()
        settings = await repo.get_settings()
        await _ensure_auto_generate_schedule(
            conn, user_id=user.id, settings=settings,
        )
    return ProfileResponse(
        profile=asdict(profile) if profile else None,
        goals=[asdict(g) for g in goals],
        settings=_settings_response(settings),
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


@settings_router.get("", response_model=SettingsResponse)
async def get_settings(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Single source for all user settings — frontend reads here, then
    PATCHes individual toggles via POST. Per-key endpoints used to exist
    (`/auto-generate`, `/auto-dreaming`, `/generation-language`) but
    each invented its own wire shape; collapsing to one resource removes
    that drift class. Auto-crystallize toggle (`useCrystallize.toggleAuto`)
    also routes here.
    """
    async with user_scoped_tx(pool, user.id) as conn:
        s = await ProfileRepository(user.id, conn).get_settings()
        await _ensure_auto_generate_schedule(conn, user_id=user.id, settings=s)
    return _settings_response(s)


@settings_router.post("", response_model=SettingsResponse)
async def update_settings(
    body: SettingsUpdateRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Partial update — only fields present in the body change.

    `_sync_auto_generate_schedule` runs unconditionally because changing
    `generation_language` alone must re-stamp the schedule payload's
    `output_language` field. The sync is one upsert/update either way.

    ``ambient_sources`` is a per-key patch (merged with existing JSONB),
    not a full replacement — set a key to ``null`` to remove it. Server
    stamps ``updated_at`` on every entry it writes through.
    """
    ambient_patch: dict[str, Any] | None = None
    if body.ambient_sources is not None:
        now_iso = datetime.now(UTC).isoformat()
        ambient_patch = {}
        for key, consent in body.ambient_sources.items():
            if consent is None:
                ambient_patch[key] = None  # remove
            else:
                ambient_patch[key] = {
                    "enabled": consent.enabled,
                    "updated_at": now_iso,
                }
    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        row = await repo.upsert_settings(
            generation_language=body.generation_language,
            auto_generate=body.auto_generate,
            auto_generate_interval_minutes=body.auto_generate_interval_minutes,
            auto_dreaming=body.auto_dreaming,
            auto_crystallize=body.auto_crystallize,
            metadata=body.metadata,
            ambient_sources_patch=ambient_patch,
            notify_new_cards=body.notify_new_cards,
            notify_permission_prompted_at=(
                datetime.now(UTC) if body.notify_permission_prompted else None
            ),
            onboarding_completed_at=(
                datetime.now(UTC) if body.onboarding_completed else None
            ),
        )
        await _sync_auto_generate_schedule(conn, user_id=user.id, settings=row)
    return _settings_response(row)
