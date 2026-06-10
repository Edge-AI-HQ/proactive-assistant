"""reminder.card 到点执行 — web 进程直接写一张提醒卡,零 LLM。

设计 SSOT: docs/plans/2026-06-09-scheduled-tasks-once-interval-reminder.mdx。
卡片字段对齐前端 normalizeIntentCard(proactive-ai-frontend/src/types/
intent-card.ts)——它对缺省字段全有兜底,但 id/title/whyNow/summary/
sourceKind/sourceLabel 必须给足,否则角标和 NowFeed 文案缺失。
落库走 persist_pipeline_run_strict:失败抛错 → dispatcher 按既有
退避重试(30s/2min/10min ×3)。push 永不上抛(卡已落库)。
跳过 card fanout:提醒卡不需要预跑对话,点开再按需 bootstrap。
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from psycopg_pool import AsyncConnectionPool

from ..db.repositories.scheduled_tasks import ScheduledTaskRow
from . import push_notifier
from .pipeline_persistence import persist_pipeline_run_strict

logger = logging.getLogger(__name__)


def _reminder_card(task: ScheduledTaskRow, *, card_id: str, now: datetime) -> dict[str, Any]:
    payload = task.payload or {}
    raw = payload.get("reminder")
    reminder = raw if isinstance(raw, dict) else {}
    title = str(reminder.get("title") or task.name or "Reminder").strip()
    message = str(reminder.get("message") or title).strip()
    return {
        "id": card_id,
        "goalBasket": "life",
        "title": title,
        "whyNow": message,
        "summary": message,
        "primaryAction": {"label": "Done", "type": "confirm"},
        "secondaryActions": [{"label": "Later", "type": "snooze"}],
        "confidence": 1.0,
        "urgency": 0.8,
        "importance": 0.6,
        "sources": ["scheduled-reminder"],
        "agentChain": [],
        "createdAt": now.isoformat(),
        "sourceKind": "scheduled",
        "sourceLabel": title,
    }


async def fire_reminder(
    pool: AsyncConnectionPool,
    task: ScheduledTaskRow,
    run_id: str,
) -> None:
    now = datetime.now(UTC)
    card = _reminder_card(task, card_id=f"card-rem-{uuid.uuid4().hex[:12]}", now=now)
    await persist_pipeline_run_strict(
        pool,
        user_id=task.user_id,
        payload={"runId": run_id, "cards": [card]},
        trigger="reminder",
    )
    logger.info(
        "reminder.card fired user=%d task=%s run=%s title=%r",
        task.user_id,
        task.id,
        run_id,
        card["title"],
    )
    await push_notifier.notify_reminder(
        pool,
        user_id=task.user_id,
        title=card["title"],
        message=card["summary"],
        task_id=task.id,
    )
