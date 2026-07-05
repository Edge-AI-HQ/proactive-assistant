"""设备时区漂移 → 用户周期任务跟随重算。

用户时区（pai_user_settings.timezone，跟随设备）变化时，把该用户所有 cron
调度任务的 timezone 改写并按新时区重算 next_run_at。这是纯调度操作（只碰
pai_scheduled_tasks + orchestration.cron.next_fire），不依赖任何业务域；放在
orchestration 层，和 cron / dispatcher / tick_loop 同属调度编排。此前历史上挂
在 generation 的 scheduled_generators，导致 user_model.settings_* 反向 import
generation、与 generation → user_model（SettingsRepository）构成互相依赖的环，
归位至此即解环。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .cron import next_fire


async def retime_user_cron_tasks(conn: Any, *, user_id: int, timezone: str) -> int:
    """设备时区变了 → 周期任务跟着走:cron 任务(每天/每周 X 点)改写 timezone
    并按新时区重算 next_run_at("每天 9 点"永远是用户当地 9 点);interval
    任务只同步 timezone 字段(触发间隔与时区无关);once 任务不动(创建时已
    定格为绝对时刻)。paused 任务也改写:retime 是边沿触发(只在漂移那一次
    跑),暂停中错过就永远错过——resume 用行上的 timezone 重算 next_fire,
    留旧值会让"每天 9 点"恢复成旧时区的 9 点(paused 行的 next_run_at
    无所谓:tick loop 不捡、resume 重算)。在调用方的 user_scoped_tx 上
    执行,返回改写行数。"""
    now = datetime.now(UTC)
    cur = await conn.execute(
        """
        SELECT id, cron_expr FROM pai_scheduled_tasks
        WHERE user_id = %s AND status IN ('active', 'paused')
          AND trigger_kind = 'schedule' AND timezone <> %s
        """,
        (user_id, timezone),
    )
    rows = await cur.fetchall()
    for row in rows:
        if row["cron_expr"]:
            nxt = next_fire(
                trigger_kind="schedule",
                cron_expr=row["cron_expr"],
                interval_seconds=None,
                timezone=timezone,
                after=now,
            )
            await conn.execute(
                "UPDATE pai_scheduled_tasks SET timezone = %s, next_run_at = %s "
                "WHERE user_id = %s AND id = %s",
                (timezone, nxt, user_id, row["id"]),
            )
        else:
            await conn.execute(
                "UPDATE pai_scheduled_tasks SET timezone = %s WHERE user_id = %s AND id = %s",
                (timezone, user_id, row["id"]),
            )
    return len(rows)
