"""EvolutionRepository — pai_evolution_runs CRUD.

Used by dream/evolve agent (write the run lifecycle) and frontend
debug panel (read runs list / single run detail).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class EvolutionRunRow:
    id: str
    trigger_kind: str
    status: str
    context_summary: str | None
    window_start: datetime | None
    window_end: datetime | None
    memories_written: int
    memories_archived: int
    memories_superseded: int
    profile_updated: bool
    profile_changed_keys: list[str]
    skills_added: int
    skills_updated: int
    skills_disabled: int
    signals_consumed: int
    refs_consumed: dict[str, Any]
    refs_produced: dict[str, Any]
    prompt_excerpt: str | None
    llm_tokens: int | None
    duration_ms: int | None
    started_at: datetime
    completed_at: datetime | None
    error_message: str | None
    details: dict[str, Any] | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> EvolutionRunRow:
        def _list(v):
            return v if isinstance(v, list) else (json.loads(v) if v else [])

        def _dict(v):
            if v is None:
                return None
            return v if isinstance(v, dict) else json.loads(v)
        return cls(
            id=row["id"], trigger_kind=row["trigger_kind"],
            status=row["status"],
            context_summary=row.get("context_summary"),
            window_start=row.get("window_start"),
            window_end=row.get("window_end"),
            memories_written=row["memories_written"],
            memories_archived=row["memories_archived"],
            memories_superseded=row["memories_superseded"],
            profile_updated=row["profile_updated"],
            profile_changed_keys=_list(row["profile_changed_keys"]),
            skills_added=row["skills_added"],
            skills_updated=row["skills_updated"],
            skills_disabled=row["skills_disabled"],
            signals_consumed=row["signals_consumed"],
            refs_consumed=_dict(row["refs_consumed"]) or {},
            refs_produced=_dict(row["refs_produced"]) or {},
            prompt_excerpt=row.get("prompt_excerpt"),
            llm_tokens=row.get("llm_tokens"),
            duration_ms=row.get("duration_ms"),
            started_at=row["started_at"],
            completed_at=row.get("completed_at"),
            error_message=row.get("error_message"),
            details=_dict(row.get("details")),
        )


class EvolutionRepository(UserScopedRepository):
    async def create(
        self,
        *,
        trigger_kind: str,
        context_summary: str | None = None,
        window_start: datetime | None = None,
        window_end: datetime | None = None,
        prompt_excerpt: str | None = None,
        run_id: str | None = None,
    ) -> EvolutionRunRow:
        rid = run_id or f"evol_{uuid.uuid4().hex[:16]}"
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_evolution_runs
                  (user_id, id, trigger_kind, status,
                   context_summary, window_start, window_end, prompt_excerpt)
                VALUES (%s, %s, %s, 'running', %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    self._user_id, rid, trigger_kind,
                    context_summary, window_start, window_end, prompt_excerpt,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "evolution insert returned no row"
            raise RuntimeError(msg)
        return EvolutionRunRow.from_record(row)

    async def list(
        self,
        *,
        trigger_kind: str | None = None,
        status: str | None = None,
        since: datetime | None = None,
        limit: int = 50,
    ) -> list[EvolutionRunRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_evolution_runs
                WHERE user_id = %s
                  AND (%s::text IS NULL OR trigger_kind = %s)
                  AND (%s::text IS NULL OR status = %s)
                  AND (%s::timestamptz IS NULL OR started_at >= %s)
                ORDER BY started_at DESC LIMIT %s
                """,
                (
                    self._user_id,
                    trigger_kind, trigger_kind,
                    status, status,
                    since, since,
                    limit,
                ),
            )
            rows = await cur.fetchall()
        return [EvolutionRunRow.from_record(r) for r in rows]

    async def get(self, run_id: str) -> EvolutionRunRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_evolution_runs WHERE user_id = %s AND id = %s",
                (self._user_id, run_id),
            )
            row = await cur.fetchone()
        return EvolutionRunRow.from_record(row) if row else None

    async def complete(
        self,
        run_id: str,
        *,
        llm_tokens: int | None = None,
        duration_ms: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_evolution_runs
                SET status = 'completed', completed_at = NOW(),
                    llm_tokens = COALESCE(%s, llm_tokens),
                    duration_ms = COALESCE(%s, duration_ms),
                    details = COALESCE(%s::jsonb, details)
                WHERE user_id = %s AND id = %s AND status = 'running'
                """,
                (
                    llm_tokens, duration_ms,
                    json.dumps(details) if details is not None else None,
                    self._user_id, run_id,
                ),
            )
            return (cur.rowcount or 0) > 0

    async def fail(self, run_id: str, *, error_message: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_evolution_runs
                SET status = 'failed', completed_at = NOW(),
                    error_message = %s
                WHERE user_id = %s AND id = %s AND status = 'running'
                """,
                (error_message, self._user_id, run_id),
            )
            return (cur.rowcount or 0) > 0
