"""Scheduler tables Repository.

Schema: 021_pai_scheduler.sql.

Two tables:
  pai_scheduled_tasks       — task definitions (cron / interval / event / once)
  pai_scheduled_task_runs   — per-fire records (lease + idempotency anchor)

The hot path is `claim_due_tasks` — SKIP LOCKED CTE that the scheduler
tick loop calls every N seconds to atomically claim due tasks across
potentially-multiple web replicas. Each claim returns the row + bumps
last_run_at + computes next_run_at via croniter (Python side, post-fetch).

Note this Repository is NOT user-scoped in the usual sense — the
scheduler tick has no current user_id ContextVar; it scans all users'
tasks at once. So `claim_due_tasks` is a free function (not bound to
UserScopedRepository), and it uses `service_tx` (no SET LOCAL).
Per-user CRUD methods (create/list/pause for a specific user) DO go
through UserScopedRepository.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from psycopg import AsyncConnection

from .base import UserScopedRepository


@dataclass(slots=True)
class ScheduledTaskRow:
    user_id: int
    id: str
    kind: str
    name: str | None
    prompt: str | None
    trigger_kind: str
    cron_expr: str | None
    interval_seconds: int | None
    event_filter: dict[str, Any] | None
    payload: dict[str, Any]
    timezone: str
    status: str
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_run_status: str | None
    run_count: int
    attempts: int
    max_attempts: int
    progress: dict[str, Any]
    last_error: str | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> ScheduledTaskRow:
        return cls(
            user_id=row["user_id"],
            id=row["id"],
            kind=row["kind"],
            name=row.get("name"),
            prompt=row.get("prompt"),
            trigger_kind=row["trigger_kind"],
            cron_expr=row.get("cron_expr"),
            interval_seconds=row.get("interval_seconds"),
            event_filter=_as_dict_opt(row.get("event_filter")),
            payload=_as_dict(row["payload"]),
            timezone=row["timezone"],
            status=row["status"],
            next_run_at=row.get("next_run_at"),
            last_run_at=row.get("last_run_at"),
            last_run_status=row.get("last_run_status"),
            run_count=row["run_count"],
            attempts=row.get("attempts", 0),
            max_attempts=row.get("max_attempts", 3),
            progress=_as_dict(row.get("progress") or {}),
            last_error=row.get("last_error"),
        )


@dataclass(slots=True)
class ScheduledTaskRunRow:
    user_id: int
    id: str
    task_id: str
    scheduled_for: datetime
    fired_at: datetime
    agent_run_id: str | None
    lease_owner: str | None
    lease_expires_at: datetime | None
    status: str
    error: str | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> ScheduledTaskRunRow:
        return cls(
            user_id=row["user_id"],
            id=row["id"],
            task_id=row["task_id"],
            scheduled_for=row["scheduled_for"],
            fired_at=row["fired_at"],
            agent_run_id=row.get("agent_run_id"),
            lease_owner=row.get("lease_owner"),
            lease_expires_at=row.get("lease_expires_at"),
            status=row["status"],
            error=row.get("error"),
        )


def _as_dict(v: Any) -> dict[str, Any]:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        return json.loads(v)
    return {}


def _as_dict_opt(v: Any) -> dict[str, Any] | None:
    if v is None:
        return None
    return _as_dict(v)


# ── per-user CRUD ───────────────────────────────────────────────────────


class ScheduledTasksRepository(UserScopedRepository):
    """Per-user scheduled task CRUD. Used by /api/tasks/schedules endpoints
    (Step C) and the system task ensure-on-first-login flow."""

    async def upsert(
        self,
        *,
        id: str,
        kind: str,
        trigger_kind: str,
        next_run_at: datetime | None,
        cron_expr: str | None = None,
        interval_seconds: int | None = None,
        event_filter: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
        prompt: str | None = None,
        name: str | None = None,
        timezone: str = "UTC",
        status: str = "active",
    ) -> ScheduledTaskRow:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_scheduled_tasks
                  (user_id, id, kind, name, prompt, trigger_kind,
                   cron_expr, interval_seconds, event_filter, payload,
                   timezone, status, next_run_at)
                VALUES (%s, %s, %s, %s, %s, %s,
                        %s, %s, %s::jsonb, %s::jsonb,
                        %s, %s, %s)
                ON CONFLICT (user_id, id) DO UPDATE SET
                  kind = EXCLUDED.kind,
                  name = EXCLUDED.name,
                  prompt = EXCLUDED.prompt,
                  trigger_kind = EXCLUDED.trigger_kind,
                  cron_expr = EXCLUDED.cron_expr,
                  interval_seconds = EXCLUDED.interval_seconds,
                  event_filter = EXCLUDED.event_filter,
                  payload = EXCLUDED.payload,
                  timezone = EXCLUDED.timezone,
                  status = EXCLUDED.status,
                  next_run_at = EXCLUDED.next_run_at,
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    self._user_id,
                    id,
                    kind,
                    name,
                    prompt,
                    trigger_kind,
                    cron_expr,
                    interval_seconds,
                    json.dumps(event_filter) if event_filter is not None else None,
                    json.dumps(payload or {}),
                    timezone,
                    status,
                    next_run_at,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "scheduled_task upsert returned no row"
            raise RuntimeError(msg)
        # Wake the scheduler if this row is now due. Manual triggers
        # always pass next_run_at <= NOW(); cron schedules with a future
        # next_run_at don't need to wake the loop early.
        if next_run_at is not None and next_run_at <= datetime.now(UTC):
            await notify_scheduler_wake(self._conn)
        return ScheduledTaskRow.from_record(row)

    async def list_active(self) -> list[ScheduledTaskRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_scheduled_tasks
                WHERE user_id = %s AND status = 'active'
                ORDER BY next_run_at NULLS LAST, created_at DESC
                """,
                (self._user_id,),
            )
            rows = await cur.fetchall()
        return [ScheduledTaskRow.from_record(r) for r in rows]

    async def pause(self, task_id: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_scheduled_tasks SET status = 'paused', updated_at = NOW()
                WHERE user_id = %s AND id = %s AND status = 'active'
                """,
                (self._user_id, task_id),
            )
            return (cur.rowcount or 0) > 0

    async def resume(self, task_id: str, *, next_run_at: datetime | None) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_scheduled_tasks
                SET status = 'active', next_run_at = %s, updated_at = NOW()
                WHERE user_id = %s AND id = %s AND status = 'paused'
                """,
                (next_run_at, self._user_id, task_id),
            )
            return (cur.rowcount or 0) > 0


# ── cross-user scheduler ops (free functions, not Repository methods) ──
# These don't bind a user_id — the scheduler scans all users at once.


async def claim_due_tasks(conn: AsyncConnection, *, batch: int = 16) -> list[ScheduledTaskRow]:
    """Atomic SKIP LOCKED claim of due tasks.

    Returns a snapshot of claimed tasks; caller computes next_run_at and
    writes it back via `update_after_fire`. Splitting claim from
    next_run_at update lets us use croniter (Python) instead of
    Postgres-side cron parsing.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            WITH due AS (
              SELECT user_id, id FROM pai_scheduled_tasks
              WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= NOW()
              ORDER BY next_run_at ASC
              LIMIT %s
              FOR UPDATE SKIP LOCKED
            )
            UPDATE pai_scheduled_tasks st
            SET last_run_at = NOW(),
                run_count = run_count + 1,
                updated_at = NOW()
            FROM due
            WHERE st.user_id = due.user_id AND st.id = due.id
            RETURNING st.*
            """,
            (batch,),
        )
        rows = await cur.fetchall()
    return [ScheduledTaskRow.from_record(r) for r in rows]


async def update_after_fire(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
    next_run_at: datetime | None,
    last_run_status: str,
    archive_if_once: bool = False,
) -> None:
    """Post-fire bookkeeping: write next_run_at + last_run_status; archive
    one-shot tasks after their first fire."""
    async with conn.cursor() as cur:
        if archive_if_once:
            await cur.execute(
                """
                UPDATE pai_scheduled_tasks
                SET next_run_at = %s,
                    last_run_status = %s,
                    status = CASE WHEN trigger_kind = 'once' THEN 'archived' ELSE status END,
                    updated_at = NOW()
                WHERE user_id = %s AND id = %s
                """,
                (next_run_at, last_run_status, user_id, task_id),
            )
        else:
            await cur.execute(
                """
                UPDATE pai_scheduled_tasks
                SET next_run_at = %s, last_run_status = %s, updated_at = NOW()
                WHERE user_id = %s AND id = %s
                """,
                (next_run_at, last_run_status, user_id, task_id),
            )


# Backoff schedule for failed once-shot tasks. Mirrors the OpenClaw plugin's
# defaultBackoffForAttempt: 30s, 2min, 10min. Index is the attempt number
# that just *failed* (1-indexed).
_BACKOFF_BY_ATTEMPT_SECONDS: tuple[int, int, int] = (30, 120, 600)


def backoff_seconds_for_attempt(attempts: int) -> int:
    """Seconds to wait before the next retry. `attempts` is the count
    *after* the failure has been recorded (1 = first failure)."""
    if attempts <= 0:
        return _BACKOFF_BY_ATTEMPT_SECONDS[0]
    idx = min(attempts, len(_BACKOFF_BY_ATTEMPT_SECONDS)) - 1
    return _BACKOFF_BY_ATTEMPT_SECONDS[idx]


async def record_failure_and_decide(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
    last_error: str,
    retry_backoff_seconds: int,
) -> tuple[int, str]:
    """Single atomic UPDATE that records a failure and decides whether
    to retry or archive.

    Once-shot tasks archive after max_attempts. Recurring tasks stay active:
    transient runtime failures such as model quota, timeouts, or connector
    outages must not permanently disable a user's schedule.

    Either way attempts is incremented and last_error is recorded. Success
    later clears attempts / last_error via record_recurring_success().

    Returns (new_attempts, new_status). Returning (0, 'archived') means
    the row didn't exist (caller already lost the race with reaper /
    delete). The CASE expression keeps the decision SQL-side so we don't
    have to do a read + write split that would race the scheduler tick.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_tasks
            SET attempts = attempts + 1,
                next_run_at = CASE
                  WHEN attempts + 1 < max_attempts
                    THEN NOW() + (%s::int * INTERVAL '1 second')
                  WHEN trigger_kind <> 'once'
                    THEN COALESCE(next_run_at, NOW() + (%s::int * INTERVAL '1 second'))
                  ELSE NULL
                END,
                status = CASE
                  WHEN trigger_kind <> 'once' THEN 'active'
                  WHEN attempts + 1 < max_attempts THEN 'active'
                  ELSE 'archived'
                END,
                last_run_status = 'failed',
                last_error = %s,
                updated_at = NOW()
            WHERE user_id = %s AND id = %s
            RETURNING attempts, status
            """,
            (
                retry_backoff_seconds,
                retry_backoff_seconds,
                last_error[:1000],
                user_id,
                task_id,
            ),
        )
        row = await cur.fetchone()
    if not row:
        return (0, "archived")
    return (int(row["attempts"]), row["status"])


async def archive_after_success(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
) -> None:
    """Terminal-success an active once-shot task: archive + clear
    next_run_at. Called by dispatcher after `complete_run(success)` to
    finalize the task row. cron / interval tasks should NOT call this —
    `update_after_fire` already advances next_run_at for them."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_tasks
            SET status = 'archived',
                next_run_at = NULL,
                last_run_status = 'success',
                last_error = NULL,
                updated_at = NOW()
            WHERE user_id = %s AND id = %s AND trigger_kind = 'once'
            """,
            (user_id, task_id),
        )


async def record_recurring_success(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
) -> None:
    """Clear stale failure bookkeeping after a recurring task succeeds."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_tasks
            SET attempts = 0,
                last_run_status = 'success',
                last_error = NULL,
                updated_at = NOW()
            WHERE user_id = %s
              AND id = %s
              AND trigger_kind <> 'once'
            """,
            (user_id, task_id),
        )


async def update_progress(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
    progress: dict[str, Any],
) -> None:
    """Replace the progress JSON. Handlers call this between stages so the
    UI / debug endpoints see what step the task is in (fetch, raw, evolve,
    …). Cheap — single row UPDATE."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_tasks
            SET progress = %s::jsonb, updated_at = NOW()
            WHERE user_id = %s AND id = %s
            """,
            (json.dumps(progress), user_id, task_id),
        )


# Postgres NOTIFY channel the scheduler tick_loop LISTENs on. Any code
# path that newly enqueues an immediately-due task should fire this so
# the loop wakes within ~50ms instead of waiting up to scheduler_tick_seconds.
# Channel name is intentionally short — it fits in pg_listening_channels
# without truncation and reads cleanly in `pg_notify` calls.
SCHEDULER_WAKE_CHANNEL = "pai_scheduler_wake"


async def notify_scheduler_wake(conn: AsyncConnection) -> None:
    """Fire NOTIFY pai_scheduler_wake. Cheap — single round trip,
    no payload. Best-effort: a dropped notification at most causes one
    tick of latency (≤ scheduler_tick_seconds), never lost work.
    """
    async with conn.cursor() as cur:
        # `NOTIFY` is a top-level SQL command, not a DML — psycopg accepts
        # it via execute(). pg_notify() function form is alternative but
        # NOTIFY <channel> is fine when the channel name is a static string.
        await cur.execute(f"NOTIFY {SCHEDULER_WAKE_CHANNEL}")


async def enqueue_once(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
    kind: str,
    payload: dict[str, Any],
    max_attempts: int = 3,
    run_after: datetime | None = None,
) -> bool:
    """Insert a once-shot task. PK is (user_id, task_id) so callers control
    idempotency by giving the same task_id (e.g. ``init.gmail.<cid>``).
    Returns True if a new row was inserted, False if it already existed.
    Use a user-scoped tx so RLS sees the right user_id.

    Fires NOTIFY pai_scheduler_wake when run_after is None or in the past
    so the tick_loop picks it up without waiting for the next interval.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_scheduled_tasks
              (user_id, id, kind, trigger_kind,
               next_run_at, payload, max_attempts, status, attempts)
            VALUES (%s, %s, %s, 'once',
                    COALESCE(%s, NOW()), %s::jsonb, %s, 'active', 0)
            ON CONFLICT (user_id, id) DO NOTHING
            """,
            (user_id, task_id, kind, run_after, json.dumps(payload), max_attempts),
        )
        inserted = (cur.rowcount or 0) > 0
    if inserted and (run_after is None or run_after <= datetime.now(UTC)):
        await notify_scheduler_wake(conn)
    return inserted


async def requeue_once(
    conn: AsyncConnection,
    *,
    user_id: int,
    task_id: str,
    kind: str,
    payload: dict[str, Any],
    max_attempts: int = 3,
) -> None:
    """Insert OR reset a once-shot task — used by reconnect / explicit
    "run again". Differs from `enqueue_once` in that an existing row is
    forcibly reactivated (status → active, attempts → 0, next_run_at →
    NOW(), payload replaced). Composing archive + insert manually races
    with the scheduler tick; this single statement is atomic.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_scheduled_tasks
              (user_id, id, kind, trigger_kind,
               next_run_at, payload, max_attempts, status, attempts)
            VALUES (%s, %s, %s, 'once',
                    NOW(), %s::jsonb, %s, 'active', 0)
            ON CONFLICT (user_id, id) DO UPDATE SET
              kind = EXCLUDED.kind,
              trigger_kind = 'once',
              next_run_at = NOW(),
              payload = EXCLUDED.payload,
              max_attempts = EXCLUDED.max_attempts,
              status = 'active',
              attempts = 0,
              last_error = NULL,
              progress = '{}'::jsonb,
              last_run_status = NULL,
              updated_at = NOW()
            """,
            (user_id, task_id, kind, json.dumps(payload), max_attempts),
        )
    # Always due immediately (NOW()) — wake the scheduler so the user
    # doesn't pay tick_seconds latency on a manual reconnect / retry.
    await notify_scheduler_wake(conn)


async def insert_run(
    conn: AsyncConnection,
    *,
    user_id: int,
    run_id: str,
    task_id: str,
    scheduled_for: datetime,
    lease_owner: str,
    lease_seconds: int,
) -> bool:
    """Insert pai_scheduled_task_runs row marking start of a fire.

    Idempotency guard: if (user_id, task_id, scheduled_for) already exists
    (different worker raced and won), this INSERT is a no-op via
    ON CONFLICT DO NOTHING. Returns True if we got the row (we own this
    fire), False if we lost the race.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_scheduled_task_runs
              (user_id, id, task_id, scheduled_for, fired_at,
               lease_owner, lease_expires_at, status)
            VALUES (%s, %s, %s, %s, NOW(),
                    %s, NOW() + (%s::int * INTERVAL '1 second'), 'running')
            ON CONFLICT (user_id, task_id, scheduled_for) DO NOTHING
            """,
            (user_id, run_id, task_id, scheduled_for, lease_owner, lease_seconds),
        )
        return (cur.rowcount or 0) > 0


async def heartbeat_run(
    conn: AsyncConnection,
    *,
    user_id: int,
    run_id: str,
    lease_owner: str,
    lease_seconds: int,
) -> bool:
    """Renew lease. Only succeeds if we still own the lease (no race-stolen)."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_task_runs
            SET lease_expires_at = NOW() + (%s::int * INTERVAL '1 second')
            WHERE user_id = %s AND id = %s
              AND lease_owner = %s
              AND status = 'running'
            """,
            (lease_seconds, user_id, run_id, lease_owner),
        )
        return (cur.rowcount or 0) > 0


async def complete_run(
    conn: AsyncConnection,
    *,
    user_id: int,
    run_id: str,
    status: str,
    error: str | None = None,
) -> None:
    """Mark a run finished. status: success | failed."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_task_runs
            SET status = %s, error = %s, lease_expires_at = NULL
            WHERE user_id = %s AND id = %s
            """,
            (status, error, user_id, run_id),
        )


async def reap_stale_runs(conn: AsyncConnection) -> int:
    """Reset 'running' rows whose lease has expired. Crashed workers
    leave these lying around — bumping back to 'queued' lets the next
    tick re-claim them through normal due-task flow on the next cron
    tick (or surface as failed if dispatcher decides not to retry).
    For now simpler: mark them failed so they don't loop forever.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE pai_scheduled_task_runs
            SET status = 'failed', error = 'lease expired (worker crashed)'
            WHERE status = 'running' AND lease_expires_at < NOW()
            """,
        )
        return cur.rowcount or 0
