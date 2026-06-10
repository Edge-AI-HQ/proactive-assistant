"""Scheduled generator service.

This module is intentionally a thin layer over the existing scheduler tables:
it normalizes a user's confirmed recurring generation request into one
`pai_scheduled_tasks` row with kind `generator.scheduled`.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from psycopg_pool import AsyncConnectionPool

from ..db.repositories.scheduled_tasks import ScheduledTaskRow, ScheduledTasksRepository
from ..db.rls import user_scoped_tx
from ..scheduler.cron import next_fire

SCHEDULED_GENERATOR_KIND = "generator.scheduled"

_TIME_RE = re.compile(r"(?P<hour>\d{1,2})(?:[:：](?P<minute>\d{1,2}))?\s*(?:点|时|am|pm|AM|PM)?")


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


async def preview_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    original_request: str,
    timezone: str,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    parsed_intent, confirmed_brief, semantic_signature = _parse_request(
        original_request=original_request,
        timezone=timezone,
    )
    preview_id = _preview_id(
        user_id=user_id,
        original_request=original_request,
        timezone=timezone,
        semantic_signature=semantic_signature,
    )
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        similar = _find_similar(
            await repo.list_by_kinds(kinds=(SCHEDULED_GENERATOR_KIND,)),
            parsed_intent=parsed_intent,
            confirmed_brief=confirmed_brief,
        )
    return {
        "preview_id": preview_id,
        "parsed_intent": parsed_intent,
        "confirmed_brief": confirmed_brief,
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
            kinds=(SCHEDULED_GENERATOR_KIND,),
            include_archived=include_archived,
        )


async def create_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    preview_id: str,
    semantic_signature: str,
    original_request: str,
    parsed_intent: dict[str, Any],
    confirmed_brief: dict[str, Any],
    duplicate_ack: bool = False,
    similar_task_ids_seen: list[str] | None = None,
) -> CreateScheduledGeneratorResult:
    parsed_intent = _normalize_payload_keys(parsed_intent)
    confirmed_brief = _normalize_payload_keys(confirmed_brief)
    _validate_timezone(str(parsed_intent.get("timezone") or "UTC"))
    cron_expr = _cron_expr_for(parsed_intent)
    task_id = _task_id_for_preview(preview_id)
    timezone = str(parsed_intent.get("timezone") or "UTC")
    seen_ids = set(similar_task_ids_seen or [])

    async with user_scoped_tx(pool, user_id) as conn:
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"scheduled-generator:{user_id}:{semantic_signature}",),
        )
        repo = ScheduledTasksRepository(user_id, conn)
        existing = await repo.get_by_id_and_kinds(
            task_id=task_id,
            kinds=(SCHEDULED_GENERATOR_KIND,),
        )
        if existing is not None:
            return CreateScheduledGeneratorResult(
                task=existing,
                created=False,
                requires_confirmation=False,
                similar_tasks=[],
            )

        similar = _find_similar(
            await repo.list_by_kinds(kinds=(SCHEDULED_GENERATOR_KIND,)),
            parsed_intent=parsed_intent,
            confirmed_brief=confirmed_brief,
        )
        unseen_similar = [row for row in similar if row.id not in seen_ids]
        if similar and (not duplicate_ack or unseen_similar):
            return CreateScheduledGeneratorResult(
                task=None,
                created=False,
                requires_confirmation=True,
                similar_tasks=similar,
            )

        now = datetime.now(UTC)
        next_run_at = next_fire(
            trigger_kind="schedule",
            cron_expr=cron_expr,
            interval_seconds=None,
            timezone=timezone,
            after=now,
        )
        payload = {
            "source": "main_chat",
            "preview_id": preview_id,
            "semantic_signature": semantic_signature,
            "original_request": original_request,
            "parsed_intent": parsed_intent,
            "confirmed_brief": confirmed_brief,
            "cards_to_generate": int(parsed_intent.get("card_count") or 1),
            "output_language": _output_language_for(original_request),
            "trigger": "scheduled",
        }
        task = await repo.upsert(
            id=task_id,
            kind=SCHEDULED_GENERATOR_KIND,
            trigger_kind="schedule",
            cron_expr=cron_expr,
            next_run_at=next_run_at,
            timezone=timezone,
            payload=payload,
            name=str(confirmed_brief.get("title") or ""),
            status="active",
        )
    return CreateScheduledGeneratorResult(
        task=task,
        created=True,
        requires_confirmation=False,
        similar_tasks=[],
    )


async def pause_scheduled_generator(
    pool: AsyncConnectionPool,
    *,
    user_id: int,
    task_id: str,
) -> ScheduledTaskRow:
    async with user_scoped_tx(pool, user_id) as conn:
        repo = ScheduledTasksRepository(user_id, conn)
        task = await repo.pause_by_kinds(task_id=task_id, kinds=(SCHEDULED_GENERATOR_KIND,))
        if task is not None:
            return task
        existing = await repo.get_by_id_and_kinds(
            task_id=task_id, kinds=(SCHEDULED_GENERATOR_KIND,)
        )
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
        existing = await repo.get_by_id_and_kinds(
            task_id=task_id, kinds=(SCHEDULED_GENERATOR_KIND,)
        )
        if existing is None:
            raise ScheduledGeneratorNotFoundError(task_id)
        next_run_at = next_fire(
            trigger_kind=existing.trigger_kind,
            cron_expr=existing.cron_expr,
            interval_seconds=existing.interval_seconds,
            timezone=existing.timezone,
            after=datetime.now(UTC),
        )
        task = await repo.resume_by_kinds(
            task_id=task_id,
            kinds=(SCHEDULED_GENERATOR_KIND,),
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
        task = await repo.archive_by_kinds(task_id=task_id, kinds=(SCHEDULED_GENERATOR_KIND,))
        if task is not None:
            return task
        existing = await repo.get_by_id_and_kinds(
            task_id=task_id, kinds=(SCHEDULED_GENERATOR_KIND,)
        )
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
        "next_run_at": row.next_run_at,
        "last_run_at": row.last_run_at,
        "last_run_status": row.last_run_status,
        "run_count": row.run_count,
        "payload": payload,
    }


def _parse_request(
    *,
    original_request: str,
    timezone: str,
) -> tuple[dict[str, Any], dict[str, Any], str]:
    text = original_request.strip()
    if not text:
        raise ScheduledGeneratorValidationError("original_request is required")
    _validate_timezone(timezone)
    hour, minute = _extract_local_time(text)
    topic = _extract_topic(text)
    local_time = f"{hour:02d}:{minute:02d}"
    parsed_intent = {
        "frequency": "daily",
        "local_time": local_time,
        "timezone": timezone,
        "topic": topic,
        "card_count": 1,
    }
    confirmed_brief = {
        "title": _title_for_topic(topic),
        "topic": topic,
        "instruction": (
            f"每天 {local_time} 生成 1 张和 {topic} 相关的卡片,优先选择对我有行动价值的信息。"
        ),
    }
    semantic_signature = "|".join(
        [
            "daily",
            local_time,
            timezone,
            _topic_key(topic),
        ]
    )
    return parsed_intent, confirmed_brief, semantic_signature


def _extract_local_time(text: str) -> tuple[int, int]:
    match = _TIME_RE.search(text)
    if not match:
        raise ScheduledGeneratorValidationError("local time is required")
    hour = int(match.group("hour"))
    minute = int(match.group("minute") or 0)
    lowered = text.lower()
    if "pm" in lowered and hour < 12:
        hour += 12
    if hour > 23 or minute > 59:
        raise ScheduledGeneratorValidationError("local time is invalid")
    return hour, minute


def _extract_topic(text: str) -> str:
    match = _TIME_RE.search(text)
    tail = text[match.end() :] if match else text
    cleaned = tail
    for token in (
        "给我",
        "推一些",
        "推送一些",
        "推送",
        "推",
        "生成一些",
        "生成",
        "提醒我",
        "提醒",
        "卡片",
    ):
        cleaned = cleaned.replace(token, " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ，,。.")
    return cleaned or "Personalized updates"


def _validate_timezone(timezone: str) -> None:
    try:
        ZoneInfo(timezone)
    except Exception as e:
        raise ScheduledGeneratorValidationError(f"invalid timezone: {timezone}") from e


def _cron_expr_for(parsed_intent: dict[str, Any]) -> str:
    local_time = str(parsed_intent.get("local_time") or "")
    try:
        hour_raw, minute_raw = local_time.split(":", 1)
        hour = int(hour_raw)
        minute = int(minute_raw)
    except Exception as e:
        raise ScheduledGeneratorValidationError("parsed_intent.local_time is invalid") from e
    if hour > 23 or minute > 59 or hour < 0 or minute < 0:
        raise ScheduledGeneratorValidationError("parsed_intent.local_time is invalid")
    return f"{minute} {hour} * * *"


_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def _to_snake_key(name: str) -> str:
    return _CAMEL_BOUNDARY.sub("_", name).lower()


def _normalize_payload_keys(value: Any) -> Any:
    """Recursively snake_case dict keys.

    preview returns parsed_intent / confirmed_brief through the route's
    camelCasing `_dump`, and the frontend / Main Chat tool echo them back to
    create verbatim. Internally we read snake_case keys (parsed_intent
    .local_time drives the cron expr), so normalize at the create boundary —
    the API stays camelCase, storage stays snake_case, and a camelCase
    round-trip can no longer silently break the schedule. Idempotent on keys
    that are already snake_case.
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
) -> str:
    digest = hashlib.sha256(
        f"{user_id}|{original_request}|{timezone}|{semantic_signature}".encode()
    ).hexdigest()
    return f"sgprev_{digest[:20]}"


def _task_id_for_preview(preview_id: str) -> str:
    digest = hashlib.sha256(preview_id.encode()).hexdigest()
    return f"sched.gen.{digest[:16]}"


def _find_similar(
    tasks: list[ScheduledTaskRow],
    *,
    parsed_intent: dict[str, Any],
    confirmed_brief: dict[str, Any],
) -> list[ScheduledTaskRow]:
    target_frequency = str(parsed_intent.get("frequency") or "")
    target_time = str(parsed_intent.get("local_time") or "")
    target_timezone = str(parsed_intent.get("timezone") or "")
    target_topic = _topic_key(
        str(
            confirmed_brief.get("topic")
            or confirmed_brief.get("title")
            or parsed_intent.get("topic")
            or ""
        )
    )
    matches: list[ScheduledTaskRow] = []
    for row in tasks:
        payload = row.payload or {}
        raw_intent = payload.get("parsed_intent")
        candidate_intent = raw_intent if isinstance(raw_intent, dict) else {}
        raw_brief = payload.get("confirmed_brief")
        candidate_brief = raw_brief if isinstance(raw_brief, dict) else {}
        candidate_topic = _topic_key(
            str(
                candidate_brief.get("topic")
                or candidate_brief.get("title")
                or candidate_intent.get("topic")
                or ""
            )
        )
        if (
            str(candidate_intent.get("frequency") or "") == target_frequency
            and str(candidate_intent.get("local_time") or "") == target_time
            and str(candidate_intent.get("timezone") or row.timezone or "") == target_timezone
            and candidate_topic == target_topic
        ):
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
