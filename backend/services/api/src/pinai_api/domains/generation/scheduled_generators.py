"""User-created scheduled task service (generator cards + reminders).

This module is intentionally a thin layer over the existing scheduler tables:
it validates a structured schedule intent (resolved by `schedule_spec`) and
writes one `pai_scheduled_tasks` row — kind `generator.scheduled` for
mode=generate, kind `reminder.card` for mode=reminder. Recurring tasks go
through preview → confirm → create; one-off tasks are created directly via
`create_once_scheduled_task`.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pinai_db.rls import user_scoped_tx
from psycopg_pool import AsyncConnectionPool

from pinai_api.config import get_web_settings

from ...domains.user_model.settings import SettingsRepository
from ...orchestration.cron import next_fire
from ...platform.db.repositories.scheduled_tasks import ScheduledTaskRow, ScheduledTasksRepository
from .schedule_spec import ResolvedSchedule, ScheduleSpecError, resolve_schedule

SCHEDULED_GENERATOR_KIND = "generator.scheduled"
REMINDER_KIND = "reminder.card"
USER_TASK_KINDS: tuple[str, ...] = (SCHEDULED_GENERATOR_KIND, REMINDER_KIND)
_MODE_TO_KIND = {"generate": SCHEDULED_GENERATOR_KIND, "reminder": REMINDER_KIND}


class ScheduledGeneratorError(Exception):
    pass


class ScheduledGeneratorNotFoundError(ScheduledGeneratorError):
    pass


class ScheduledGeneratorValidationError(ScheduledGeneratorError):
    pass


@dataclass(slots=True)
class CreateScheduledGeneratorResult:
    task: ScheduledTaskRow | None
    created: bool
    requires_confirmation: bool
    similar_tasks: list[ScheduledTaskRow]


def _language_for(original_request: str) -> str:
    return "zh" if _output_language_for(original_request) == "zh-Hans" else "en"


def _validate_reminder(mode: str, reminder: dict[str, Any] | None) -> dict[str, str]:
    if mode != "reminder":
        return {}
    reminder = _normalize_payload_keys(reminder or {})
    title = str(reminder.get("title") or "").strip()
    message = str(reminder.get("message") or "").strip()
    if not title or not message:
        raise ScheduledGeneratorValidationError(
            "reminder mode needs reminder.title and reminder.message"
        )
    if len(title) > 80 or len(message) > 500:
        raise ScheduledGeneratorValidationError(
            "reminder.title <= 80 chars, reminder.message <= 500 chars"
        )
    return {"title": title, "message": message}


def _resolve_and_guard(
    *,
    schedule: dict[str, Any],
    timezone: str,
    mode: str,
    original_request: str,
) -> ResolvedSchedule:
    if mode not in _MODE_TO_KIND:
        raise ScheduledGeneratorValidationError(f"mode must be reminder|generate, got {mode!r}")
    settings = get_web_settings()
    try:
        resolved = resolve_schedule(
            _normalize_payload_keys(schedule),
            timezone=timezone,
            language=_language_for(original_request),
        )
    except ScheduleSpecError as e:
        raise ScheduledGeneratorValidationError(str(e)) from e
    if resolved.trigger_kind == "once":
        max_ahead = timedelta(days=settings.scheduled_once_max_days_ahead)
        if resolved.next_run_at > datetime.now(UTC) + max_ahead:
            raise ScheduledGeneratorValidationError(
                f"once schedule must be within {settings.scheduled_once_max_days_ahead} days"
            )
    elif resolved.gap_seconds is not None:
        min_gap = (
            settings.scheduled_reminder_min_gap_seconds
            if mode == "reminder"
            else settings.scheduled_generate_min_gap_seconds
        )
        if resolved.gap_seconds < min_gap:
            raise ScheduledGeneratorValidationError(
                f"{mode} tasks fire at most every {min_gap} seconds (got {resolved.gap_seconds})"
            )
    return resolved


async def _follow_device_timezone(pool: AsyncConnectionPool, *, user_id: int, supplied: str) -> str:
    """永远跟手机:pai_user_settings.timezone(由前端 X-Pin-Client-Timezone 头
    跟随设备,见 settings_ui.py)是时区的事实源。get_settings lazy-create 保证
    settings 行总在、timezone 总非空(建行默认 'UTC'),所以服务端总能拿到确定
    时区,任务时区不再依赖 agent/LLM 选对(实测 LLM 没来源时会按语言瞎猜,中文
    → Asia/Shanghai)。没引导过时区的用户因此回退到保守的 'UTC' 而非 LLM 猜的
    值;supplied 仅作 settings.timezone 意外为空时的防御兜底,正常路径不触发。"""
    async with user_scoped_tx(pool, user_id) as conn:
        settings = await SettingsRepository(user_id, conn).get_settings()
    stored = (settings.timezone or "").strip()
    return stored or supplied


async def _guard_max_active(repo: ScheduledTasksRepository) -> None:
    settings = get_web_settings()
    count = await repo.count_by_kinds(kinds=USER_TASK_KINDS)
    if count >= settings.scheduled_tasks_max_active_per_user:
        raise ScheduledGeneratorValidationError(
            f"too many scheduled tasks (max {settings.scheduled_tasks_max_active_per_user});"
            " delete one first"
        )


async def preview_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    original_request: str,
    timezone: str,
    schedule: dict[str, Any],
    mode: str = "generate",
    topic: str | None = None,
    reminder: dict[str, Any] | None = None,
    conversation_id: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    if not original_request.strip():
        raise ScheduledGeneratorValidationError("original_request is required")
    timezone = await _follow_device_timezone(pool, user_id=user_id, supplied=timezone)
    resolved = _resolve_and_guard(
        schedule=schedule, timezone=timezone, mode=mode, original_request=original_request
    )
    reminder_clean = _validate_reminder(mode, reminder)
    topic_clean = (topic or "").strip() or reminder_clean.get("title") or "Personalized updates"
    semantic_signature = "|".join([mode, resolved.schedule_key, timezone, _topic_key(topic_clean)])
    preview_id = _preview_id(
        user_id=user_id,
        original_request=original_request,
        timezone=timezone,
        semantic_signature=semantic_signature,
        issued_run_id=run_id or "",
    )
    parsed_intent = {
        "schedule": _normalize_payload_keys(schedule),
        "timezone": timezone,
        "topic": topic_clean,
        "mode": mode,
    }
    confirmed_brief = (
        {
            "title": _title_for_topic(topic_clean),
            "topic": topic_clean,
            "instruction": (
                f"{resolved.schedule_label} 生成 1 张和 {topic_clean} 相关的卡片,"
                "优先选择对我有行动价值的信息。"
            ),
        }
        if mode == "generate"
        else {"title": reminder_clean["title"], "topic": topic_clean}
    )
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        similar = _find_similar(
            await repo.list_by_kinds(kinds=(_MODE_TO_KIND[mode],)),
            semantic_signature=semantic_signature,
            parsed_intent=parsed_intent,
            confirmed_brief=confirmed_brief,
        )
    return {
        "preview_id": preview_id,
        "mode": mode,
        "schedule": parsed_intent["schedule"],
        "schedule_label": resolved.schedule_label,
        "parsed_intent": parsed_intent,
        "confirmed_brief": confirmed_brief,
        "reminder": reminder_clean or None,
        "semantic_signature": semantic_signature,
        "similar_tasks": [_task_summary(row) for row in similar],
        "conversation_id": conversation_id,
    }


async def list_scheduled_generators(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    include_archived: bool = False,
) -> list[ScheduledTaskRow]:
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        return await repo.list_by_kinds(
            kinds=USER_TASK_KINDS,
            include_archived=include_archived,
        )


async def create_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    preview_id: str,
    semantic_signature: str,
    original_request: str,
    timezone: str,
    schedule: dict[str, Any],
    mode: str = "generate",
    topic: str | None = None,
    reminder: dict[str, Any] | None = None,
    confirmed_brief: dict[str, Any] | None = None,
    duplicate_ack: bool = False,
    similar_task_ids_seen: list[str] | None = None,
    caller_run_id: str | None = None,
) -> CreateScheduledGeneratorResult:
    if not original_request.strip():
        raise ScheduledGeneratorValidationError("original_request is required")
    schedule_norm = _normalize_payload_keys(schedule)
    if str(schedule_norm.get("type") or "") == "once":
        raise ScheduledGeneratorValidationError("use the once endpoint for one-off tasks")
    timezone = await _follow_device_timezone(pool, user_id=user_id, supplied=timezone)
    resolved = _resolve_and_guard(
        schedule=schedule, timezone=timezone, mode=mode, original_request=original_request
    )
    reminder_clean = _validate_reminder(mode, reminder)
    topic_clean = (topic or "").strip() or reminder_clean.get("title") or "Personalized updates"
    # Recompute server-side — the client-echoed semantic_signature is part of
    # the request contract but never trusted for matching or locking.
    semantic_signature = "|".join([mode, resolved.schedule_key, timezone, _topic_key(topic_clean)])
    # 同轮硬闸:preview_id 的指纹混入了发出它的 run_id。create 在同一轮
    # (同一 run JWT)带着本轮刚发的 preview_id 回来 = 模型没等用户确认
    # 就自行创建 → 服务端直接拒绝。提示词失守时这里兜底。
    if caller_run_id:
        same_turn_preview = _preview_id(
            user_id=user_id,
            original_request=original_request,
            timezone=timezone,
            semantic_signature=semantic_signature,
            issued_run_id=caller_run_id,
        )
        if preview_id == same_turn_preview:
            raise ScheduledGeneratorValidationError(
                "confirmation gate: this preview was issued in the SAME agent "
                "turn. Show the preview to the user, END your turn, and call "
                "create only after the user explicitly confirms in their NEXT "
                "message."
            )
    kind = _MODE_TO_KIND[mode]
    task_id = _task_id_for_preview(preview_id)
    seen_ids = set(similar_task_ids_seen or [])
    parsed_intent = {
        "schedule": schedule_norm,
        "timezone": timezone,
        "topic": topic_clean,
        "mode": mode,
    }
    brief = (
        _normalize_payload_keys(confirmed_brief or {})
        if mode == "generate"
        else {"title": reminder_clean["title"], "topic": topic_clean}
    )

    async with user_scoped_tx(pool, user_id) as conn:
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"scheduled-generator:{user_id}:{semantic_signature}",),
        )
        repo = ScheduledTasksRepository(user_id, conn)
        existing = await repo.get_by_id_and_kinds(task_id=task_id, kinds=(kind,))
        if existing is not None:
            return CreateScheduledGeneratorResult(
                task=existing,
                created=False,
                requires_confirmation=False,
                similar_tasks=[],
            )

        await _guard_max_active(repo)

        similar = _find_similar(
            await repo.list_by_kinds(kinds=(kind,)),
            semantic_signature=semantic_signature,
            parsed_intent=parsed_intent,
            confirmed_brief=brief,
        )
        unseen_similar = [row for row in similar if row.id not in seen_ids]
        if similar and (not duplicate_ack or unseen_similar):
            return CreateScheduledGeneratorResult(
                task=None,
                created=False,
                requires_confirmation=True,
                similar_tasks=similar,
            )

        payload: dict[str, Any] = {
            "source": "main_chat",
            "preview_id": preview_id,
            "semantic_signature": semantic_signature,
            "original_request": original_request,
            "parsed_intent": parsed_intent,
            "schedule_label": resolved.schedule_label,
        }
        if mode == "reminder":
            payload["reminder"] = reminder_clean
            payload["trigger"] = "reminder"
            name = reminder_clean["title"]
        else:
            payload["confirmed_brief"] = brief
            payload["cards_to_generate"] = 1
            payload["output_language"] = _output_language_for(original_request)
            payload["trigger"] = "scheduled"
            name = _brief_title(brief, parsed_intent)
        task = await repo.upsert(
            id=task_id,
            kind=kind,
            trigger_kind=resolved.trigger_kind,
            cron_expr=resolved.cron_expr,
            interval_seconds=resolved.interval_seconds,
            next_run_at=resolved.next_run_at,
            timezone=timezone,
            payload=payload,
            name=name,
            status="active",
        )
    return CreateScheduledGeneratorResult(
        task=task,
        created=True,
        requires_confirmation=False,
        similar_tasks=[],
    )


async def create_once_scheduled_task(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    original_request: str,
    timezone: str,
    schedule: dict[str, Any],
    mode: str = "reminder",
    topic: str | None = None,
    reminder: dict[str, Any] | None = None,
) -> ScheduledTaskRow:
    if not original_request.strip():
        raise ScheduledGeneratorValidationError("original_request is required")
    timezone = await _follow_device_timezone(pool, user_id=user_id, supplied=timezone)
    resolved = _resolve_and_guard(
        schedule=schedule, timezone=timezone, mode=mode, original_request=original_request
    )
    if resolved.trigger_kind != "once":
        raise ScheduledGeneratorValidationError("this endpoint only accepts schedule.type=once")
    reminder_clean = _validate_reminder(mode, reminder)
    topic_clean = (topic or "").strip() or reminder_clean.get("title") or "Personalized updates"
    kind = _MODE_TO_KIND[mode]
    parsed_intent = {
        "schedule": _normalize_payload_keys(schedule),
        "timezone": timezone,
        "topic": topic_clean,
        "mode": mode,
    }
    payload: dict[str, Any] = {
        "source": "main_chat",
        "original_request": original_request,
        "parsed_intent": parsed_intent,
        "schedule_label": resolved.schedule_label,
    }
    if mode == "reminder":
        payload["reminder"] = reminder_clean
        payload["trigger"] = "reminder"
        name = reminder_clean["title"]
    else:
        payload["confirmed_brief"] = {
            "title": _title_for_topic(topic_clean),
            "topic": topic_clean,
            "instruction": f"{resolved.schedule_label} 生成 1 张和 {topic_clean} 相关的卡片。",
        }
        payload["cards_to_generate"] = 1
        payload["output_language"] = _output_language_for(original_request)
        payload["trigger"] = "scheduled"
        name = str(payload["confirmed_brief"]["title"])
        # Once-shot generate = usually an event briefing (meeting / flight).
        # Carry a zero-LLM fallback nudge: if the generator burns all its
        # retries at fire time, the dispatcher degrades to a plain reminder
        # card so the user is still pinged about the event itself.
        payload["fallback_reminder"] = {
            "title": _title_for_topic(topic_clean),
            "message": original_request.strip(),
        }
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        await _guard_max_active(repo)
        task = await repo.upsert(
            id=f"sched.once.{uuid.uuid4().hex[:16]}",
            kind=kind,
            trigger_kind="once",
            next_run_at=resolved.next_run_at,
            timezone=timezone,
            payload=payload,
            name=name,
            status="active",
        )
    return task


async def pause_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    task_id: str,
) -> ScheduledTaskRow:
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        task = await repo.pause_by_kinds(task_id=task_id, kinds=USER_TASK_KINDS)
        if task is not None:
            return task
        existing = await repo.get_by_id_and_kinds(task_id=task_id, kinds=USER_TASK_KINDS)
    if existing is None:
        raise ScheduledGeneratorNotFoundError(task_id)
    return existing


async def resume_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    task_id: str,
) -> ScheduledTaskRow:
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        existing = await repo.get_by_id_and_kinds(task_id=task_id, kinds=USER_TASK_KINDS)
        if existing is None:
            raise ScheduledGeneratorNotFoundError(task_id)
        next_run_at: datetime | None
        if existing.trigger_kind == "once":
            # next_fire("once") returns None, which would zombify the task.
            # Keep the stored fire time if it hasn't passed; otherwise fire
            # now — the user asked for a reminder that never happened, so a
            # late delivery beats silently dropping it.
            now = datetime.now(UTC)
            stored = existing.next_run_at
            next_run_at = stored if stored is not None and stored > now else now
        else:
            next_run_at = next_fire(
                trigger_kind=existing.trigger_kind,
                cron_expr=existing.cron_expr,
                interval_seconds=existing.interval_seconds,
                timezone=existing.timezone,
                after=datetime.now(UTC),
            )
        task = await repo.resume_by_kinds(
            task_id=task_id,
            kinds=USER_TASK_KINDS,
            next_run_at=next_run_at,
        )
    return task or existing


async def delete_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    task_id: str,
) -> ScheduledTaskRow:
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        task = await repo.archive_by_kinds(task_id=task_id, kinds=USER_TASK_KINDS)
        if task is not None:
            return task
        existing = await repo.get_by_id_and_kinds(task_id=task_id, kinds=USER_TASK_KINDS)
    if existing is None:
        raise ScheduledGeneratorNotFoundError(task_id)
    return existing


def serialize_task(row: ScheduledTaskRow) -> dict[str, Any]:
    payload = row.payload or {}
    raw_parsed = payload.get("parsed_intent")
    parsed = raw_parsed if isinstance(raw_parsed, dict) else {}
    raw_brief = payload.get("confirmed_brief")
    brief = raw_brief if isinstance(raw_brief, dict) else {}
    return {
        "id": row.id,
        "kind": row.kind,
        "status": row.status,
        "title": _brief_title(brief, parsed),
        "frequency": parsed.get("frequency"),
        "local_time": parsed.get("local_time"),
        "timezone": row.timezone,
        "cron_expr": row.cron_expr,
        "trigger_kind": row.trigger_kind,
        "interval_seconds": row.interval_seconds,
        "schedule_label": payload.get("schedule_label"),
        "next_run_at": row.next_run_at,
        "last_run_at": row.last_run_at,
        "last_run_status": row.last_run_status,
        "run_count": row.run_count,
        "payload": payload,
    }


_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def _to_snake_key(name: str) -> str:
    return _CAMEL_BOUNDARY.sub("_", name).lower()


def _normalize_payload_keys(value: Any) -> Any:
    """Recursively snake_case dict keys.

    preview returns parsed_intent / confirmed_brief through the route's
    camelCasing `_dump`, and the frontend / Main Chat tool echo them back to
    create verbatim. Internally we read snake_case keys (schedule.local_time
    drives the cron expr), so normalize at the create boundary — the API
    stays camelCase, storage stays snake_case, and a camelCase round-trip
    can no longer silently break the schedule. Idempotent on keys that are
    already snake_case.
    """
    if isinstance(value, dict):
        return {_to_snake_key(str(k)): _normalize_payload_keys(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize_payload_keys(item) for item in value]
    return value


def _preview_id(
    *,
    user_id: int,
    original_request: str,
    timezone: str,
    semantic_signature: str,
    issued_run_id: str = "",
) -> str:
    """preview 指纹。混入发出它的 agent run_id(来自已认证 JWT,模型无法
    伪造)——create 端据此识别「同一轮里 preview 完立刻 create」并拒绝,
    这是确认流程的服务端硬闸,不依赖提示词自觉。"""
    digest = hashlib.sha256(
        f"{user_id}|{original_request}|{timezone}|{semantic_signature}|{issued_run_id}".encode()
    ).hexdigest()
    return f"sgprev_{digest[:20]}"


def _task_id_for_preview(preview_id: str) -> str:
    digest = hashlib.sha256(preview_id.encode()).hexdigest()
    return f"sched.gen.{digest[:16]}"


def _find_similar(
    tasks: list[ScheduledTaskRow],
    *,
    semantic_signature: str,
    parsed_intent: dict[str, Any],
    confirmed_brief: dict[str, Any],
) -> list[ScheduledTaskRow]:
    schedule = parsed_intent.get("schedule")
    target_schedule = schedule if isinstance(schedule, dict) else {}
    target_topic = _topic_key(str(confirmed_brief.get("topic") or parsed_intent.get("topic") or ""))
    matches: list[ScheduledTaskRow] = []
    for row in tasks:
        payload = row.payload or {}
        if str(payload.get("semantic_signature") or "") == semantic_signature:
            matches.append(row)
            continue
        # PR65 legacy rows have no schedule_key-based signature: fall back to
        # exact frequency/local_time/timezone/topic matching.
        raw_intent = payload.get("parsed_intent")
        candidate = raw_intent if isinstance(raw_intent, dict) else {}
        legacy_match = (
            str(candidate.get("frequency") or "") == "daily"
            and target_schedule.get("type") == "cron"
            and target_schedule.get("frequency") == "daily"
            and str(candidate.get("local_time") or "")
            == str(target_schedule.get("local_time") or "")
            and str(candidate.get("timezone") or row.timezone or "")
            == str(parsed_intent.get("timezone") or "")
            and _topic_key(str(candidate.get("topic") or "")) == target_topic
        )
        if legacy_match:
            matches.append(row)
    return matches


def _task_summary(row: ScheduledTaskRow) -> dict[str, Any]:
    serialized = serialize_task(row)
    return {
        "id": serialized["id"],
        "title": serialized["title"],
        "status": serialized["status"],
        "frequency": serialized["frequency"],
        "local_time": serialized["local_time"],
        "timezone": serialized["timezone"],
        "schedule_label": serialized["schedule_label"],
    }


def _brief_title(brief: dict[str, Any], parsed: dict[str, Any]) -> str:
    title = brief.get("title")
    if isinstance(title, str) and title.strip():
        return title.strip()
    topic = brief.get("topic") or parsed.get("topic") or "Scheduled generator"
    return _title_for_topic(str(topic))


def _title_for_topic(topic: str) -> str:
    if re.search(r"[\u4e00-\u9fff]", topic):
        return f"{topic}卡片"
    return f"{topic} cards"


def _topic_key(topic: str) -> str:
    key = topic.strip().lower()
    key = key.replace("新闻", " news ")
    key = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", key)
    return key.strip("-") or "personalized-updates"


def _output_language_for(original_request: str) -> str:
    if re.search(r"[\u4e00-\u9fff]", original_request):
        return "zh-Hans"
    return "en"
