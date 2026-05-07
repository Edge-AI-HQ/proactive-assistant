"""SkillsRepository — pai_skill_index CRUD + body.

Skill body markdown lives inline in `body` column (added by 025
migration). Frontend reads list (no body) and detail (with body) at
different endpoints. Step 2b will move body to Supabase Storage; the
Repository signature stays stable.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class SkillRow:
    id: str
    title: str
    description: str | None
    status: str
    revision: int
    body_hash: str
    triggers: list[str]
    source: str
    created_run_id: str | None
    last_updated_run_id: str | None
    enabled_at: datetime | None
    disabled_at: datetime | None
    created_at: datetime
    updated_at: datetime
    reference_count: int
    last_referenced_at: datetime | None
    referenced_by_runs: list[str]
    body: str | None  # populated only on detail / create / update

    @classmethod
    def from_record(cls, row: dict[str, Any], *, with_body: bool = False) -> SkillRow:
        triggers = row["triggers"]
        if not isinstance(triggers, list):
            triggers = json.loads(triggers) if triggers else []
        ref_runs = row["referenced_by_runs"]
        if not isinstance(ref_runs, list):
            ref_runs = json.loads(ref_runs) if ref_runs else []
        return cls(
            id=row["id"], title=row["title"],
            description=row.get("description"),
            status=row["status"], revision=row["revision"],
            body_hash=row["body_hash"],
            triggers=triggers, source=row["source"],
            created_run_id=row.get("created_run_id"),
            last_updated_run_id=row.get("last_updated_run_id"),
            enabled_at=row.get("enabled_at"),
            disabled_at=row.get("disabled_at"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            reference_count=row["reference_count"],
            last_referenced_at=row.get("last_referenced_at"),
            referenced_by_runs=ref_runs,
            body=row.get("body") if with_body else None,
        )


def _body_hash(body: str | None) -> str:
    """SHA-256 of body. Empty string for None."""
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()[:32]


class SkillsRepository(UserScopedRepository):
    _LIST_COLUMNS = (
        "id, title, description, status, revision, body_hash, triggers, source, "
        "created_run_id, last_updated_run_id, enabled_at, disabled_at, "
        "created_at, updated_at, reference_count, last_referenced_at, referenced_by_runs"
    )
    _ALL_COLUMNS = _LIST_COLUMNS + ", body"

    async def list(
        self,
        *,
        status: str | None = None,
        limit: int = 50,
    ) -> list[SkillRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                SELECT {self._LIST_COLUMNS} FROM pai_skill_index
                WHERE user_id = %s
                  AND (%s::text IS NULL OR status = %s)
                ORDER BY updated_at DESC
                LIMIT %s
                """,
                (self._user_id, status, status, limit),
            )
            rows = await cur.fetchall()
        return [SkillRow.from_record(r, with_body=False) for r in rows]

    async def get(self, skill_id: str) -> SkillRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"SELECT {self._ALL_COLUMNS} FROM pai_skill_index "
                f"WHERE user_id = %s AND id = %s",
                (self._user_id, skill_id),
            )
            row = await cur.fetchone()
        return SkillRow.from_record(row, with_body=True) if row else None

    async def add(
        self,
        *,
        title: str,
        body: str,
        description: str | None = None,
        triggers: list[str] | None = None,
        status: str = "enabled",
        source: str = "manual",
        created_run_id: str | None = None,
        skill_id: str | None = None,
    ) -> SkillRow:
        sid = skill_id or f"sk_{uuid.uuid4().hex[:16]}"
        async with self._conn.cursor() as cur:
            await cur.execute(
                f"""
                INSERT INTO pai_skill_index
                  (user_id, id, title, description, status, body, body_hash,
                   triggers, source, created_run_id, last_updated_run_id,
                   enabled_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s,
                        CASE WHEN %s = 'enabled' THEN NOW() ELSE NULL END)
                RETURNING {self._ALL_COLUMNS}
                """,
                (
                    self._user_id, sid, title, description, status,
                    body, _body_hash(body),
                    json.dumps(triggers or []),
                    source, created_run_id, created_run_id,
                    status,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "skill insert returned no row"
            raise RuntimeError(msg)
        return SkillRow.from_record(row, with_body=True)

    async def patch(
        self,
        skill_id: str,
        *,
        title: str | None = None,
        description: str | None = None,
        body: str | None = None,
        triggers: list[str] | None = None,
        status: str | None = None,
        last_updated_run_id: str | None = None,
    ) -> SkillRow | None:
        # Build SET clause dynamically — only include fields the caller
        # passed. Bumps revision + updated_at on any change. Body change
        # also updates body_hash.
        sets: list[str] = []
        params: list[Any] = []
        if title is not None:
            sets.append("title = %s")
            params.append(title)
        if description is not None:
            sets.append("description = %s")
            params.append(description)
        if body is not None:
            sets.append("body = %s")
            params.append(body)
            sets.append("body_hash = %s")
            params.append(_body_hash(body))
        if triggers is not None:
            sets.append("triggers = %s::jsonb")
            params.append(json.dumps(triggers))
        if status is not None:
            sets.append("status = %s")
            params.append(status)
            if status == "enabled":
                sets.append("enabled_at = NOW()")
                sets.append("disabled_at = NULL")
            elif status == "disabled":
                sets.append("disabled_at = NOW()")
        if last_updated_run_id is not None:
            sets.append("last_updated_run_id = %s")
            params.append(last_updated_run_id)
        if not sets:
            return await self.get(skill_id)
        sets.append("revision = revision + 1")
        sets.append("updated_at = NOW()")

        sql = (
            f"UPDATE pai_skill_index SET {', '.join(sets)} "
            f"WHERE user_id = %s AND id = %s "
            f"RETURNING {self._ALL_COLUMNS}"
        )
        params.extend([self._user_id, skill_id])
        async with self._conn.cursor() as cur:
            await cur.execute(sql, params)
            row = await cur.fetchone()
        return SkillRow.from_record(row, with_body=True) if row else None

    async def archive(self, skill_id: str) -> SkillRow | None:
        return await self.patch(skill_id, status="archived")
