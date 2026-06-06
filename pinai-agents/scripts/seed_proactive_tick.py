"""Seed a `proactive.tick` interval task for one user (experiment bootstrap).

The proactive agent is driven by a per-user recurring scheduler task. The
product path is the Settings opt-in (proactive_enabled + proactive_interval_seconds,
synced into the task by routes/ui/profile.py). This script bootstraps the task
directly for a test user — handy for experiments / before onboarding.

Usage:
    cd pinai-agents
    uv run python scripts/seed_proactive_tick.py <user_id> [interval_seconds]

The user must already have a LiteLLM virtual key (i.e. have used chat at
least once); the process loop skips turns for users without one.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import UTC, datetime

from pinai_agents.web.db.pool import close_pool, open_pool
from pinai_agents.web.db.repositories.scheduled_tasks import ScheduledTasksRepository
from pinai_agents.web.db.rls import user_scoped_tx

_DEFAULT_INTERVAL_SECONDS = 300


async def _main(user_id: int, interval_seconds: int) -> None:
    pool = await open_pool()
    try:
        async with user_scoped_tx(pool, user_id) as conn:
            row = await ScheduledTasksRepository(user_id, conn).upsert(
                id="proactive.tick",
                kind="proactive.tick",
                # Recurring interval task: trigger_kind='schedule' +
                # interval_seconds (see scheduler/cron.py:next_fire). 'interval'
                # is NOT a valid trigger_kind — the DB CHECK only allows
                # 'schedule' / 'event' / 'once'.
                trigger_kind="schedule",
                interval_seconds=interval_seconds,
                next_run_at=datetime.now(UTC),
                name="Proactive agent heartbeat",
            )
        print(
            f"seeded proactive.tick user={user_id} interval={interval_seconds}s "
            f"status={row.status} next_run_at={row.next_run_at}",
        )
    finally:
        await close_pool(pool)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    uid = int(sys.argv[1])
    interval = int(sys.argv[2]) if len(sys.argv) > 2 else _DEFAULT_INTERVAL_SECONDS
    asyncio.run(_main(uid, interval))
