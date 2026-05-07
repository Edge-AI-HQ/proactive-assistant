"""Profile + Goals + UserSettings Repository.

Three closely-related tables unified into one Repository because the
common access path is "give me everything about this user" (profile
endpoint). Splitting into three would force routes to construct three
Repositories per request — cosmetic split with zero data benefit.

Tables:
  pai_profile         single row per user (TEXT id with composite PK)
  pai_goals           multiple rows per user (id + key)
  pai_user_settings   single row per user (user_id PK)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class ProfileRow:
    id: str
    display_name: str
    locale: str
    timezone: str
    summary: str | None
    facts: dict[str, Any]
    preferences: dict[str, Any]
    constraints: dict[str, Any]
    metadata: dict[str, Any]
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> ProfileRow:
        return cls(
            id=row["id"],
            display_name=row["display_name"],
            locale=row["locale"],
            timezone=row["timezone"],
            summary=row.get("summary"),
            facts=_as_dict(row["facts"]),
            preferences=_as_dict(row["preferences"]),
            constraints=_as_dict(row["constraints"]),
            metadata=_as_dict(row["metadata"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(slots=True)
class GoalRow:
    id: str
    key: str
    title: str
    priority: str
    status: str
    summary: str | None
    closed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    reference_count: int

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> GoalRow:
        return cls(
            id=row["id"], key=row["key"], title=row["title"],
            priority=row["priority"], status=row["status"],
            summary=row.get("summary"),
            closed_at=row.get("closed_at"),
            created_at=row["created_at"], updated_at=row["updated_at"],
            reference_count=row["reference_count"],
        )


@dataclass(slots=True)
class UserSettingsRow:
    generation_language: str
    auto_generate: bool
    auto_dreaming: bool
    auto_crystallize: bool
    metadata: dict[str, Any]
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> UserSettingsRow:
        return cls(
            generation_language=row["generation_language"],
            auto_generate=row["auto_generate"],
            auto_dreaming=row["auto_dreaming"],
            auto_crystallize=row["auto_crystallize"],
            metadata=_as_dict(row["metadata"]),
            updated_at=row["updated_at"],
        )


def _as_dict(v: Any) -> dict[str, Any]:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        return json.loads(v)
    return {}


class ProfileRepository(UserScopedRepository):
    # ── pai_profile ────────────────────────────────────────────────
    async def get_profile(self) -> ProfileRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_profile WHERE user_id = %s",
                (self._user_id,),
            )
            row = await cur.fetchone()
        return ProfileRow.from_record(row) if row else None

    async def upsert_profile(
        self,
        *,
        id: str = "primary",
        display_name: str | None = None,
        locale: str | None = None,
        timezone: str | None = None,
        summary: str | None = None,
        facts: dict[str, Any] | None = None,
        preferences: dict[str, Any] | None = None,
        constraints: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> ProfileRow:
        """Partial upsert — pass only the fields you want to change.

        On INSERT, missing fields fall back to the same defaults the
        constructor would assign (display_name='User', locale='en-US',
        timezone='UTC', JSONB→{}). On UPDATE, missing (None) fields are
        preserved via COALESCE so a single-field tool call doesn't clobber
        the rest of the profile. Mirrors `upsert_settings`'s pattern.
        """
        facts_json = json.dumps(facts) if facts is not None else None
        prefs_json = json.dumps(preferences) if preferences is not None else None
        cons_json = json.dumps(constraints) if constraints is not None else None
        meta_json = json.dumps(metadata) if metadata is not None else None
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_profile
                  (user_id, id, display_name, locale, timezone, summary,
                   facts, preferences, constraints, metadata)
                VALUES
                  (%s, %s,
                   COALESCE(%s, 'User'),
                   COALESCE(%s, 'en-US'),
                   COALESCE(%s, 'UTC'),
                   %s,
                   COALESCE(%s::jsonb, '{}'::jsonb),
                   COALESCE(%s::jsonb, '{}'::jsonb),
                   COALESCE(%s::jsonb, '{}'::jsonb),
                   COALESCE(%s::jsonb, '{}'::jsonb))
                ON CONFLICT (user_id, id) DO UPDATE SET
                  display_name = COALESCE(%s, pai_profile.display_name),
                  locale       = COALESCE(%s, pai_profile.locale),
                  timezone     = COALESCE(%s, pai_profile.timezone),
                  summary      = COALESCE(%s, pai_profile.summary),
                  facts        = COALESCE(%s::jsonb, pai_profile.facts),
                  preferences  = COALESCE(%s::jsonb, pai_profile.preferences),
                  constraints  = COALESCE(%s::jsonb, pai_profile.constraints),
                  metadata     = COALESCE(%s::jsonb, pai_profile.metadata),
                  updated_at   = NOW()
                RETURNING *
                """,
                (
                    self._user_id, id,
                    display_name, locale, timezone, summary,
                    facts_json, prefs_json, cons_json, meta_json,
                    display_name, locale, timezone, summary,
                    facts_json, prefs_json, cons_json, meta_json,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "profile upsert returned no row"
            raise RuntimeError(msg)
        return ProfileRow.from_record(row)

    # ── pai_goals ─────────────────────────────────────────────────
    async def list_goals(self, *, status: str | None = None) -> list[GoalRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_goals
                WHERE user_id = %s
                  AND (%s::text IS NULL OR status = %s)
                ORDER BY created_at DESC
                """,
                (self._user_id, status, status),
            )
            rows = await cur.fetchall()
        return [GoalRow.from_record(r) for r in rows]

    async def upsert_goal(
        self,
        *,
        id: str,
        key: str,
        title: str,
        priority: str = "medium",
        status: str = "active",
        summary: str | None = None,
    ) -> GoalRow:
        """Upsert by logical identity (`key`), not surrogate PK (`id`).

        Why ON CONFLICT (user_id, key) instead of (user_id, id):
          `pai_goals.id` is a generated surrogate; callers (the chat
          agent's `goal_upsert` tool, the UI on edits) typically know the
          stable `key` slug, not the random id. ON CONFLICT (user_id, id)
          would only match when caller provided the existing id verbatim
          — and would 500 with UniqueViolation when caller supplied a
          fresh id but a key that already exists. Conflict-on-key
          collapses both insert and "edit by key" paths into a single
          deterministic upsert; the returned row carries the existing
          id, which the caller can stash for follow-up operations like
          close_goal.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_goals
                  (user_id, id, key, title, priority, status, summary)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id, key) DO UPDATE SET
                  title = EXCLUDED.title,
                  priority = EXCLUDED.priority,
                  status = EXCLUDED.status,
                  summary = EXCLUDED.summary,
                  updated_at = NOW()
                RETURNING *
                """,
                (self._user_id, id, key, title, priority, status, summary),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "goal upsert returned no row"
            raise RuntimeError(msg)
        return GoalRow.from_record(row)

    async def close_goal(self, goal_id: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_goals
                SET status = 'archived', closed_at = NOW(), updated_at = NOW()
                WHERE user_id = %s AND id = %s AND status = 'active'
                """,
                (self._user_id, goal_id),
            )
            return (cur.rowcount or 0) > 0

    # ── pai_user_settings ─────────────────────────────────────────
    async def get_settings(self) -> UserSettingsRow | None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_user_settings WHERE user_id = %s",
                (self._user_id,),
            )
            row = await cur.fetchone()
        return UserSettingsRow.from_record(row) if row else None

    async def upsert_settings(
        self,
        *,
        generation_language: str | None = None,
        auto_generate: bool | None = None,
        auto_dreaming: bool | None = None,
        auto_crystallize: bool | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> UserSettingsRow:
        """Upsert with COALESCE — pass only the fields you want to change."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_user_settings
                  (user_id, generation_language, auto_generate,
                   auto_dreaming, auto_crystallize, metadata)
                VALUES
                  (%s,
                   COALESCE(%s, 'zh-Hans'),
                   COALESCE(%s, FALSE),
                   COALESCE(%s, FALSE),
                   COALESCE(%s, TRUE),
                   COALESCE(%s::jsonb, '{}'::jsonb))
                ON CONFLICT (user_id) DO UPDATE SET
                  generation_language = COALESCE(%s, pai_user_settings.generation_language),
                  auto_generate       = COALESCE(%s, pai_user_settings.auto_generate),
                  auto_dreaming       = COALESCE(%s, pai_user_settings.auto_dreaming),
                  auto_crystallize    = COALESCE(%s, pai_user_settings.auto_crystallize),
                  metadata            = COALESCE(%s::jsonb, pai_user_settings.metadata),
                  updated_at = NOW()
                RETURNING *
                """,
                (
                    self._user_id,
                    generation_language, auto_generate, auto_dreaming, auto_crystallize,
                    json.dumps(metadata) if metadata is not None else None,
                    generation_language, auto_generate, auto_dreaming, auto_crystallize,
                    json.dumps(metadata) if metadata is not None else None,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "settings upsert returned no row"
            raise RuntimeError(msg)
        return UserSettingsRow.from_record(row)
