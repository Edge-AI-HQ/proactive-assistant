"""schedule_spec 纯函数测试 — 无 DB。覆盖 once/interval/cron 解析、
label 渲染、gap 计算、非法输入。时间全部显式传 now,杜绝壁钟依赖。"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pinai_api.domains.generation.schedule_spec import (
    ScheduleSpecError,
    resolve_schedule,
)

NOW = datetime(2026, 6, 9, 10, 0, tzinfo=UTC)  # = 2026-06-09 18:00 Asia/Shanghai


def test_once_in_minutes():
    r = resolve_schedule(
        {"type": "once", "in_minutes": 5},
        timezone="Asia/Shanghai",
        language="zh",
        now=NOW,
    )
    assert r.trigger_kind == "once"
    assert r.cron_expr is None and r.interval_seconds is None
    assert r.next_run_at == datetime(2026, 6, 9, 10, 5, tzinfo=UTC)
    assert r.gap_seconds is None
    assert r.schedule_label == "一次 · 06-09 18:05"
    assert r.schedule_key.startswith("once:")


def test_once_at_local_converts_timezone():
    r = resolve_schedule(
        {"type": "once", "at_local": "2026-06-10T15:00"},
        timezone="Asia/Shanghai",
        language="zh",
        now=NOW,
    )
    # 15:00 Asia/Shanghai = 07:00 UTC
    assert r.next_run_at == datetime(2026, 6, 10, 7, 0, tzinfo=UTC)
    assert r.schedule_label == "一次 · 06-10 15:00"


def test_once_in_the_past_rejected():
    with pytest.raises(ScheduleSpecError):
        resolve_schedule(
            {"type": "once", "at_local": "2026-06-09T17:00"},  # 17:00 SH < now 18:00 SH
            timezone="Asia/Shanghai",
            language="zh",
            now=NOW,
        )


def test_interval():
    r = resolve_schedule(
        {"type": "interval", "every_seconds": 300},
        timezone="UTC",
        language="zh",
        now=NOW,
    )
    assert r.trigger_kind == "schedule"
    assert r.interval_seconds == 300 and r.cron_expr is None
    assert r.next_run_at == datetime(2026, 6, 9, 10, 5, tzinfo=UTC)
    assert r.gap_seconds == 300
    assert r.schedule_label == "每 5 分钟"
    assert r.schedule_key == "interval:300"


def test_interval_hour_label_english():
    r = resolve_schedule(
        {"type": "interval", "every_seconds": 7200},
        timezone="UTC",
        language="en",
        now=NOW,
    )
    assert r.schedule_label == "Every 2 hours"


def test_cron_daily():
    r = resolve_schedule(
        {"type": "cron", "frequency": "daily", "local_time": "09:00"},
        timezone="Asia/Shanghai",
        language="zh",
        now=NOW,
    )
    assert r.trigger_kind == "schedule"
    assert r.cron_expr == "0 9 * * *"
    assert r.gap_seconds == 86400
    assert r.schedule_label == "每天 09:00"
    # now=18:00 SH → 下一次是明天 09:00 SH = 01:00 UTC
    assert r.next_run_at == datetime(2026, 6, 10, 1, 0, tzinfo=UTC)


def test_cron_weekly_iso_days_maps_sunday():
    r = resolve_schedule(
        {"type": "cron", "frequency": "weekly", "local_time": "09:00", "days_of_week": [1, 7]},
        timezone="Asia/Shanghai",
        language="zh",
        now=NOW,
    )
    assert r.cron_expr == "0 9 * * 0,1"  # ISO 7(周日)→ cron 0;升序去重
    assert r.schedule_label == "每周一/日 09:00"
    assert r.schedule_key == "cron:weekly:1,7:09:00"


@pytest.mark.parametrize(
    "spec",
    [
        {"type": "nope"},
        {"type": "once"},  # 缺 in_minutes / at_local
        {"type": "once", "in_minutes": 0},
        {"type": "once", "in_minutes": 5, "at_local": "2026-06-10T15:00"},  # 二选一
        {"type": "interval", "every_seconds": 0},
        {"type": "cron", "frequency": "daily"},  # 缺 local_time
        {"type": "cron", "frequency": "daily", "local_time": "25:00"},
        {"type": "cron", "frequency": "weekly", "local_time": "09:00"},  # weekly 缺 days
        {"type": "cron", "frequency": "weekly", "local_time": "09:00", "days_of_week": [8]},
    ],
)
def test_invalid_specs_raise(spec):
    with pytest.raises(ScheduleSpecError):
        resolve_schedule(spec, timezone="UTC", language="zh", now=NOW)
