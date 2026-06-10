"""结构化 schedule 意图 → pai_scheduled_tasks 触发字段。

纯函数、无 IO:agent 解析语言(传 type=once/interval/cron 的结构),
这里负责时间数学(相对时间用 server 的钟、本地时间按 task timezone
换算 UTC)、cron 表达式拼装(agent 不直写 cron)、展示 label 和
相邻触发 gap(供 service 层套 per-mode 最小间隔护栏)。

spec 形状(snake_case,route 层已归一):
  {"type": "once",     "in_minutes": 5}
  {"type": "once",     "at_local": "2026-06-10T15:00"}
  {"type": "interval", "every_seconds": 300}
  {"type": "cron",     "frequency": "daily",  "local_time": "09:00"}
  {"type": "cron",     "frequency": "weekly", "local_time": "09:00",
                       "days_of_week": [1, 7]}   # ISO: 1=周一 … 7=周日
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

from croniter import croniter

_WEEKDAY_ZH = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "日"}
_WEEKDAY_EN = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}


class ScheduleSpecError(Exception):
    """非法 schedule 结构。service 层转译成 ScheduledGeneratorValidationError。"""


@dataclass(slots=True)
class ResolvedSchedule:
    trigger_kind: Literal["once", "schedule"]
    cron_expr: str | None
    interval_seconds: int | None
    next_run_at: datetime  # 首次触发(UTC aware)
    gap_seconds: int | None  # 相邻两次触发间隔;once 为 None
    schedule_key: str  # 语义签名组件,如 "interval:300" / "cron:daily:09:00"
    schedule_label: str  # 人类可读,创建时固化进 payload


def resolve_schedule(
    spec: dict[str, Any],
    *,
    timezone: str,
    language: str = "zh",
    now: datetime | None = None,
) -> ResolvedSchedule:
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        now = now.replace(tzinfo=UTC)
    try:
        tz = ZoneInfo(timezone)
    except Exception as e:
        raise ScheduleSpecError(f"invalid timezone: {timezone}") from e

    spec_type = str(spec.get("type") or "")
    if spec_type == "once":
        return _resolve_once(spec, tz=tz, language=language, now=now)
    if spec_type == "interval":
        return _resolve_interval(spec, language=language, now=now)
    if spec_type == "cron":
        return _resolve_cron(spec, tz=tz, language=language, now=now)
    raise ScheduleSpecError(f"schedule.type must be once|interval|cron, got {spec_type!r}")


def _resolve_once(
    spec: dict[str, Any], *, tz: ZoneInfo, language: str, now: datetime
) -> ResolvedSchedule:
    in_minutes = spec.get("in_minutes")
    at_local = spec.get("at_local")
    if (in_minutes is None) == (at_local is None):
        raise ScheduleSpecError("once schedule needs exactly one of in_minutes / at_local")
    if in_minutes is not None:
        minutes = int(in_minutes)
        if minutes < 1:
            raise ScheduleSpecError("in_minutes must be >= 1")
        run_at = now + timedelta(minutes=minutes)
    else:
        try:
            naive = datetime.strptime(str(at_local), "%Y-%m-%dT%H:%M")
        except ValueError as e:
            raise ScheduleSpecError(f"at_local must be YYYY-MM-DDTHH:MM, got {at_local!r}") from e
        run_at = naive.replace(tzinfo=tz).astimezone(UTC)
        if run_at <= now:
            raise ScheduleSpecError("once schedule time is in the past")
    local = run_at.astimezone(tz)
    label = (
        f"一次 · {local.strftime('%m-%d %H:%M')}"
        if language == "zh"
        else f"Once · {local.strftime('%m-%d %H:%M')}"
    )
    return ResolvedSchedule(
        trigger_kind="once",
        cron_expr=None,
        interval_seconds=None,
        next_run_at=run_at,
        gap_seconds=None,
        schedule_key=f"once:{run_at.strftime('%Y-%m-%dT%H:%MZ')}",
        schedule_label=label,
    )


def _resolve_interval(spec: dict[str, Any], *, language: str, now: datetime) -> ResolvedSchedule:
    raw = spec.get("every_seconds")
    seconds = int(raw) if raw is not None else 0
    if seconds < 1:
        raise ScheduleSpecError("every_seconds must be >= 1")
    if language == "zh":
        label = (
            f"每 {seconds // 3600} 小时"
            if seconds % 3600 == 0
            else f"每 {max(seconds // 60, 1)} 分钟"
        )
    else:
        label = (
            f"Every {seconds // 3600} hours"
            if seconds % 3600 == 0
            else f"Every {max(seconds // 60, 1)} min"
        )
    return ResolvedSchedule(
        trigger_kind="schedule",
        cron_expr=None,
        interval_seconds=seconds,
        next_run_at=now + timedelta(seconds=seconds),
        gap_seconds=seconds,
        schedule_key=f"interval:{seconds}",
        schedule_label=label,
    )


def _resolve_cron(
    spec: dict[str, Any], *, tz: ZoneInfo, language: str, now: datetime
) -> ResolvedSchedule:
    frequency = str(spec.get("frequency") or "")
    if frequency not in ("daily", "weekly"):
        raise ScheduleSpecError("cron schedule.frequency must be daily|weekly")
    hour, minute = _parse_local_time(str(spec.get("local_time") or ""))
    if frequency == "daily":
        cron_expr = f"{minute} {hour} * * *"
        key = f"cron:daily:{hour:02d}:{minute:02d}"
        label = (
            f"每天 {hour:02d}:{minute:02d}"
            if language == "zh"
            else f"Daily {hour:02d}:{minute:02d}"
        )
    else:
        raw_days = spec.get("days_of_week")
        if not isinstance(raw_days, list) or not raw_days:
            raise ScheduleSpecError("weekly schedule needs days_of_week (ISO 1=Mon … 7=Sun)")
        iso_days = sorted({int(d) for d in raw_days})
        if any(d < 1 or d > 7 for d in iso_days):
            raise ScheduleSpecError("days_of_week values must be 1..7 (ISO)")
        cron_days = sorted({0 if d == 7 else d for d in iso_days})  # cron: 0=Sun
        cron_expr = f"{minute} {hour} * * {','.join(str(d) for d in cron_days)}"
        key = f"cron:weekly:{','.join(str(d) for d in iso_days)}:{hour:02d}:{minute:02d}"
        if language == "zh":
            label = f"每周{'/'.join(_WEEKDAY_ZH[d] for d in iso_days)} {hour:02d}:{minute:02d}"
        else:
            label = f"Weekly {'/'.join(_WEEKDAY_EN[d] for d in iso_days)} {hour:02d}:{minute:02d}"
    first, second = _next_two_fires(cron_expr, tz=tz, now=now)
    return ResolvedSchedule(
        trigger_kind="schedule",
        cron_expr=cron_expr,
        interval_seconds=None,
        next_run_at=first,
        gap_seconds=int((second - first).total_seconds()),
        schedule_key=key,
        schedule_label=label,
    )


def _parse_local_time(local_time: str) -> tuple[int, int]:
    try:
        hour_raw, minute_raw = local_time.split(":", 1)
        hour, minute = int(hour_raw), int(minute_raw)
    except ValueError as e:
        raise ScheduleSpecError(f"local_time must be HH:MM, got {local_time!r}") from e
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ScheduleSpecError(f"local_time out of range: {local_time!r}")
    return hour, minute


def _next_two_fires(cron_expr: str, *, tz: ZoneInfo, now: datetime) -> tuple[datetime, datetime]:
    it = croniter(cron_expr, now.astimezone(tz))
    first = it.get_next(datetime).astimezone(UTC)
    second = it.get_next(datetime).astimezone(UTC)
    return first, second
