"""/api/profile — combined profile + goals + settings snapshot for the UI."""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Header, status
from psycopg import AsyncConnection
from psycopg.rows import DictRow

from ....shared.api_models import (
    GoalUpsertRequest,
    ProfileResponse,
    SettingsResponse,
    SettingsUpdateRequest,
)
from ...auth.deps import User, current_user, get_pool
from ...db.repositories.profile import ProfileRepository, ProfileRow, UserSettingsRow
from ...db.repositories.scheduled_tasks import ScheduledTasksRepository
from ...db.rls import user_scoped_tx
from ...services.browserbase_provisioning import ensure_browserbase_context
from ...services.litellm_provisioning import ensure_user_litellm_key
from ...services.scheduled_generators import retime_user_cron_tasks


def _auto_dreaming_task_id(user_id: int) -> str:
    return f"dream.auto.{user_id}"


_AUTO_DREAMING_CRON_EXPR = "0 6 * * *"
_LOCALE_LANGUAGE_PREFIXES = {
    "zh": "zh-Hans",
    "ja": "ja",
    "ko": "ko",
    "es": "es",
    "fr": "fr",
    "de": "de",
    "pt": "pt",
}


def _initial_generation_language_from_locale(locale: str | None) -> str | None:
    cleaned = _clean_client_locale(locale)
    if cleaned is None:
        return None
    prefix = cleaned.split("-", 1)[0].lower()
    return _LOCALE_LANGUAGE_PREFIXES.get(prefix)


def _next_auto_dreaming_fire(
    *,
    timezone: str,
    after: datetime | None = None,
) -> datetime:
    now = after or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    tz = ZoneInfo(timezone)
    local_now = now.astimezone(tz)
    target = local_now.replace(hour=6, minute=0, second=0, microsecond=0)
    if target <= local_now:
        target += timedelta(days=1)
    return target.astimezone(UTC)


async def _profile_timezone(conn: AsyncConnection[DictRow], *, user_id: int) -> str:
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT timezone FROM pai_profile WHERE user_id=%s LIMIT 1",
            (user_id,),
        )
        row = await cur.fetchone()
    timezone = (row["timezone"] if row is not None else None) or "UTC"
    try:
        ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        return "UTC"
    return timezone


async def _sync_auto_dreaming_schedule(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    settings: UserSettingsRow,
) -> None:
    """Reflect auto_dreaming into a daily 06:00 scheduled task.

    The user-facing switch lives in pai_user_settings, but the scheduler
    only wakes up from pai_scheduled_tasks. Keep one deterministic row
    per user so toggling the switch actually creates or archives the
    recurring dream task.
    """
    task_id = _auto_dreaming_task_id(user_id)
    if settings.auto_dreaming:
        timezone = await _profile_timezone(conn, user_id=user_id)
        await ScheduledTasksRepository(user_id, conn).upsert(
            id=task_id,
            kind="auto.dreaming",
            trigger_kind="schedule",
            cron_expr=_AUTO_DREAMING_CRON_EXPR,
            next_run_at=_next_auto_dreaming_fire(timezone=timezone),
            payload={"trigger": "auto"},
            name="Daily auto dreaming",
            timezone=timezone,
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


async def _ensure_auto_dreaming_schedule(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    settings: UserSettingsRow,
) -> None:
    """Backfill or repair the daily dream schedule for enabled users.

    Read paths call this so existing users with auto_dreaming=true but no
    scheduler row are repaired without needing to toggle the setting off
    and on again.
    """
    if not settings.auto_dreaming:
        return
    task_id = _auto_dreaming_task_id(user_id)
    timezone = await _profile_timezone(conn, user_id=user_id)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT kind, trigger_kind, status, cron_expr, timezone
            FROM pai_scheduled_tasks
            WHERE user_id=%s AND id=%s
            """,
            (user_id, task_id),
        )
        row = await cur.fetchone()
    if (
        row is not None
        and row["kind"] == "auto.dreaming"
        and row["trigger_kind"] == "schedule"
        and row["status"] == "active"
        and row["cron_expr"] == _AUTO_DREAMING_CRON_EXPR
        and row["timezone"] == timezone
    ):
        return
    await _sync_auto_dreaming_schedule(conn, user_id=user_id, settings=settings)


async def _ensure_settings_schedules(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    settings: UserSettingsRow,
) -> None:
    await _ensure_auto_dreaming_schedule(conn, user_id=user_id, settings=settings)


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


# 时区头的采信分级:只有手机是"跟随"事实源。X-Pin-Client-Platform 缺失
# (在野老 App 不发这个头)视为手机 — 旧客户端零感知。
_TZ_TRUSTED_PLATFORMS = frozenset({"ios", "android"})


async def _sync_device_timezone(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    timezone_hint: str | None,
    platform_hint: str | None = None,
) -> ProfileRow | None:
    """永远跟手机:有效的设备时区(X-Pin-Client-Timezone)是时区事实源 —
    没有档案就建档,漂了就更新(旅行/搬家自动跟随),并把周期任务的
    "每天 X 点"重排到新时区。返回更新后的 profile(没动则 None)。

    平台分级(防多客户端互搏):手机(ios/android,或没发 platform 头的
    在野老 App)完整跟随 + retime;web/desktop(X-Pin-Client-Platform:
    web)只允许 seed 还没确立的时区(行缺失或仍是建行默认值 'UTC'),
    **永远不能覆盖**手机已确立的时区 — 否则人在 LA、家里桌面端还在上海,
    两端轮询会让 profile 和所有 cron 任务的 next_run_at 反复横跳。
    已知边界:真在 UTC 时区的手机建立的 'UTC' 与建行默认值不可区分,
    可能被异地 web 端 seed 一次,手机下次请求即翻回(单次往返,非持续)。

    挂在 /api/profile 和 /api/settings 两个 GET 上 — App 冷启动实际只打
    /api/settings(useUserSettings),只挂 /api/profile 的话引导永远不跑。"""
    if not timezone_hint:
        return None
    repo = ProfileRepository(user_id, conn)
    profile = await repo.get_profile()
    if profile is not None and profile.timezone == timezone_hint:
        return None
    trusted = platform_hint is None or platform_hint.strip().lower() in _TZ_TRUSTED_PLATFORMS
    if not trusted and profile is not None and profile.timezone != "UTC":
        return None  # web/desktop 不得覆盖已确立的时区
    updated = await repo.upsert_profile(timezone=timezone_hint)
    await retime_user_cron_tasks(conn, user_id=user_id, timezone=timezone_hint)
    return updated


router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("", response_model=ProfileResponse)
async def get_profile_snapshot(
    x_pin_client_locale: str | None = Header(default=None, alias="X-Pin-Client-Locale"),
    x_pin_client_timezone: str | None = Header(default=None, alias="X-Pin-Client-Timezone"),
    x_pin_client_platform: str | None = Header(default=None, alias="X-Pin-Client-Platform"),
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
            if profile
            and profile.locale == "en-US"
            and locale_hint
            and locale_hint != profile.locale
            else None
        )
        if locale_patch:
            profile = await repo.upsert_profile(locale=locale_patch)
        synced = await _sync_device_timezone(
            conn,
            user_id=user.id,
            timezone_hint=timezone_hint,
            platform_hint=x_pin_client_platform,
        )
        if synced is not None:
            profile = synced
        goals = await repo.list_goals()
        settings = await repo.get_settings(
            initial_generation_language=_initial_generation_language_from_locale(locale_hint),
        )
        await _ensure_settings_schedules(conn, user_id=user.id, settings=settings)
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
            id=goal_id,
            key=body.key,
            title=body.title,
            priority=body.priority,
            status=body.status,
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
    x_pin_client_locale: str | None = Header(default=None, alias="X-Pin-Client-Locale"),
    x_pin_client_timezone: str | None = Header(default=None, alias="X-Pin-Client-Timezone"),
    x_pin_client_platform: str | None = Header(default=None, alias="X-Pin-Client-Platform"),
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
        # App 冷启动只打这个接口(不打 /api/profile),设备时区引导必须在
        # 这里跑 — 前端本来就在 settings 请求上带了时区头。
        await _sync_device_timezone(
            conn,
            user_id=user.id,
            timezone_hint=_clean_client_timezone(x_pin_client_timezone),
            platform_hint=x_pin_client_platform,
        )
        s = await ProfileRepository(user.id, conn).get_settings(
            initial_generation_language=_initial_generation_language_from_locale(
                x_pin_client_locale,
            ),
        )
        await _ensure_settings_schedules(conn, user_id=user.id, settings=s)
    return _settings_response(s)


@settings_router.post("", response_model=SettingsResponse)
async def update_settings(
    body: SettingsUpdateRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Partial update — only fields present in the body change.

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

    # Onboarding completion is where we provision the user's LiteLLM virtual
    # key (+ Browserbase context), so every downstream LLM/agent task —
    # connector.evolve, dreaming, generator, the proactive heartbeat, chat —
    # has them ready the moment it runs. ensure_user_litellm_key raises on
    # LiteLLM failure, so onboarding can't finish (onboarding_completed_at
    # stays NULL) until the key is minted; the client retries the finish step.
    # Browserbase is best-effort (never blocks). Idempotent, so a re-stamp is
    # a no-op once provisioned.
    if body.onboarding_completed:
        await ensure_user_litellm_key(pool, user)
        await ensure_browserbase_context(pool, user)

    async with user_scoped_tx(pool, user.id) as conn:
        repo = ProfileRepository(user.id, conn)
        row = await repo.upsert_settings(
            generation_language=body.generation_language,
            auto_generate=body.auto_generate,
            auto_generate_interval_minutes=body.auto_generate_interval_minutes,
            auto_dreaming=body.auto_dreaming,
            auto_crystallize=body.auto_crystallize,
            permission_mode=body.permission_mode,
            proactive_enabled=body.proactive_enabled,
            proactive_interval_seconds=body.proactive_interval_seconds,
            metadata=body.metadata,
            ambient_sources_patch=ambient_patch,
            notify_new_cards=body.notify_new_cards,
            notify_permission_prompted_at=(
                datetime.now(UTC) if body.notify_permission_prompted else None
            ),
            onboarding_completed_at=(datetime.now(UTC) if body.onboarding_completed else None),
        )
        await _sync_auto_dreaming_schedule(conn, user_id=user.id, settings=row)
    return _settings_response(row)
