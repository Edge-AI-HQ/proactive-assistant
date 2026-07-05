"""EvolutionRepository — pai_evolution_runs CRUD.

Used by dream/evolve agent (write the run lifecycle) and frontend
debug panel (read runs list / single run detail).
"""

from __future__ import annotations

import builtins
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pinai_db.base import UserScopedRepository


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
            id=row["id"],
            trigger_kind=row["trigger_kind"],
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
                    self._user_id,
                    rid,
                    trigger_kind,
                    context_summary,
                    window_start,
                    window_end,
                    prompt_excerpt,
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
                    trigger_kind,
                    trigger_kind,
                    status,
                    status,
                    since,
                    since,
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
        context_summary: str | None = None,
        memories_written: int | None = None,
        memories_archived: int | None = None,
        memories_superseded: int | None = None,
        profile_updated: bool | None = None,
        profile_changed_keys: builtins.list[str] | None = None,
        skills_added: int | None = None,
        skills_updated: int | None = None,
        skills_disabled: int | None = None,
        signals_consumed: int | None = None,
        refs_consumed: dict[str, Any] | None = None,
        refs_produced: dict[str, Any] | None = None,
        llm_tokens: int | None = None,
        duration_ms: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_evolution_runs
                SET status = 'completed', completed_at = NOW(),
                    context_summary = COALESCE(%s, context_summary),
                    memories_written = COALESCE(%s, memories_written),
                    memories_archived = COALESCE(%s, memories_archived),
                    memories_superseded = COALESCE(%s, memories_superseded),
                    profile_updated = COALESCE(%s, profile_updated),
                    profile_changed_keys = COALESCE(%s::jsonb, profile_changed_keys),
                    skills_added = COALESCE(%s, skills_added),
                    skills_updated = COALESCE(%s, skills_updated),
                    skills_disabled = COALESCE(%s, skills_disabled),
                    signals_consumed = COALESCE(%s, signals_consumed),
                    refs_consumed = COALESCE(%s::jsonb, refs_consumed),
                    refs_produced = COALESCE(%s::jsonb, refs_produced),
                    llm_tokens = COALESCE(%s, llm_tokens),
                    duration_ms = COALESCE(%s, duration_ms),
                    details = COALESCE(%s::jsonb, details)
                WHERE user_id = %s AND id = %s AND status = 'running'
                """,
                (
                    context_summary,
                    memories_written,
                    memories_archived,
                    memories_superseded,
                    profile_updated,
                    json.dumps(profile_changed_keys) if profile_changed_keys is not None else None,
                    skills_added,
                    skills_updated,
                    skills_disabled,
                    signals_consumed,
                    json.dumps(refs_consumed) if refs_consumed is not None else None,
                    json.dumps(refs_produced) if refs_produced is not None else None,
                    llm_tokens,
                    duration_ms,
                    json.dumps(details) if details is not None else None,
                    self._user_id,
                    run_id,
                ),
            )
            return (cur.rowcount or 0) > 0

    async def summarize_outputs(self, run_id: str) -> dict[str, Any]:
        """Aggregate durable side effects written under one agent run id.

        Skills are the only run-attributable output left: pai_skill_index carries
        created_run_id / last_updated_run_id. The old pai_memory / pai_personal_signals
        aggregates were dead reads — evolve writes events / portrait / skills now and
        those tables are retired. The events dimension can't be aggregated here yet:
        pai_events has no run-association column, so per-run event accounting is an
        evolve-audit gap to fill once pai_events gains a run link.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT
                  COUNT(*) FILTER (WHERE created_run_id = %s)::int AS skills_added,
                  COUNT(*) FILTER (
                    WHERE last_updated_run_id = %s AND created_run_id <> %s
                  )::int AS skills_updated,
                  COUNT(*) FILTER (
                    WHERE last_updated_run_id = %s AND status = 'disabled'
                  )::int AS skills_disabled,
                  COALESCE(jsonb_agg(id ORDER BY updated_at)
                    FILTER (WHERE id IS NOT NULL), '[]'::jsonb) AS skill_ids
                FROM pai_skill_index
                WHERE user_id = %s
                  AND (created_run_id = %s OR last_updated_run_id = %s)
                """,
                (
                    run_id,
                    run_id,
                    run_id,
                    run_id,
                    self._user_id,
                    run_id,
                    run_id,
                ),
            )
            skills = await cur.fetchone() or {}

        skill_ids = skills.get("skill_ids") or []
        refs_produced: dict[str, Any] = {}
        if skill_ids:
            refs_produced["pai_skill_index"] = skill_ids
        return {
            "skills_added": int(skills.get("skills_added") or 0),
            "skills_updated": int(skills.get("skills_updated") or 0),
            "skills_disabled": int(skills.get("skills_disabled") or 0),
            "refs_produced": refs_produced,
        }

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
