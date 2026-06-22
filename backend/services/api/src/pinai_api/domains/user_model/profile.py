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

from pinai_db.base import UserScopedRepository


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
            id=row["id"],
            key=row["key"],
            title=row["title"],
            priority=row["priority"],
            status=row["status"],
            summary=row.get("summary"),
            closed_at=row.get("closed_at"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            reference_count=row["reference_count"],
        )


@dataclass(slots=True)
class UserSettingsRow:
    generation_language: str
    auto_generate: bool
    auto_generate_interval_minutes: int
    auto_dreaming: bool
    auto_crystallize: bool
    # Per-user "permission mode" for the chat agent's side-effect tools:
    # 'ask' (default — pause for HITL approval) or 'bypass' (run without the
    # per-call approval pause). TEXT so future modes can be added. Persisted,
    # cross-device SSOT; the runtime effect is delivered per-run via request
    # meta (mapped to a bool), never read from this column by chat (trust
    # boundary).
    permission_mode: str
    # Proactive heartbeat opt-in (the "Proactive" page toggle). False by
    # default. The settings route mirrors this into a per-user `proactive.tick`
    # scheduler task — the scheduler tick only reads pai_scheduled_tasks, never
    # this column.
    proactive_enabled: bool
    # Heartbeat cadence — the interval of the per-user `proactive.tick` task.
    # One of {60, 300, 1800}s (081 CHECK); the settings route mirrors it
    # into the task's interval_seconds. Default 300 (5 min).
    proactive_interval_seconds: int
    metadata: dict[str, Any]
    # Per-mobile-source ambient capture consents. Shape:
    # { "<source_key>": { "enabled": <bool>, "updated_at": "<iso>" } }.
    # Empty = "no ambient capture" — login alone never starts a source.
    ambient_sources: dict[str, Any]
    # New-cards push notification opt-in. False by default; flipped on
    # only when the user accepts the in-app pre-prompt AND the OS prompt.
    notify_new_cards: bool
    # First time we showed the in-app pre-prompt. NULL means "never asked
    # yet — show it on next home mount"; non-NULL means "don't ask again,
    # the toggle in Account is the only way to change preference".
    notify_permission_prompted_at: datetime | None
    # First-run onboarding completion. NULL = SPA renders <OnboardingFlow />;
    # non-NULL = the user finished or skipped through the flow at least
    # once and lands in the main shell going forward. Skip still counts.
    onboarding_completed_at: datetime | None
    updated_at: datetime

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> UserSettingsRow:
        return cls(
            generation_language=row["generation_language"],
            auto_generate=row["auto_generate"],
            auto_generate_interval_minutes=row["auto_generate_interval_minutes"],
            auto_dreaming=row["auto_dreaming"],
            auto_crystallize=row["auto_crystallize"],
            permission_mode=str(row.get("permission_mode", "ask")),
            proactive_enabled=row["proactive_enabled"],
            proactive_interval_seconds=row["proactive_interval_seconds"],
            metadata=_as_dict(row["metadata"]),
            ambient_sources=_as_dict(row.get("ambient_sources")),
            notify_new_cards=bool(row.get("notify_new_cards", False)),
            notify_permission_prompted_at=row.get("notify_permission_prompted_at"),
            onboarding_completed_at=row.get("onboarding_completed_at"),
            updated_at=row["updated_at"],
        )


def _as_dict(v: Any) -> dict[str, Any]:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        return json.loads(v)
    return {}


def _merge_ambient_sources(
    existing: dict[str, Any],
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Shallow per-key merge. ``patch[k] = None`` deletes ``k``, anything
    else replaces ``existing[k]``. Returns a fresh dict — never mutates
    inputs. Used by upsert_settings so a partial update doesn't wipe
    siblings (e.g. toggling sound_classifier doesn't lose location)."""
    merged = dict(existing)
    for k, v in patch.items():
        if v is None:
            merged.pop(k, None)
        else:
            merged[k] = v
    return merged


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
                    self._user_id,
                    id,
                    display_name,
                    locale,
                    timezone,
                    summary,
                    facts_json,
                    prefs_json,
                    cons_json,
                    meta_json,
                    display_name,
                    locale,
                    timezone,
                    summary,
                    facts_json,
                    prefs_json,
                    cons_json,
                    meta_json,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "profile upsert returned no row"
            raise RuntimeError(msg)
        return ProfileRow.from_record(row)

    async def merge_profile_preference(
        self,
        *,
        key: str,
        value: str,
        id: str = "primary",
    ) -> ProfileRow:
        """Atomically merge one top-level key into profile.preferences."""
        patch_json = json.dumps({key: value})
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_profile
                  (user_id, id, display_name, preferences)
                VALUES
                  (%s, %s, 'User', %s::jsonb)
                ON CONFLICT (user_id, id) DO UPDATE SET
                  preferences = pai_profile.preferences || EXCLUDED.preferences,
                  updated_at  = NOW()
                RETURNING *
                """,
                (self._user_id, id, patch_json),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "profile preference merge returned no row"
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
    async def get_settings(
        self,
        *,
        initial_generation_language: str | None = None,
    ) -> UserSettingsRow:
        """Lazy-create on first read, then return the row.

        Defaults live exclusively on `pai_user_settings` columns
        (`010_pai_core_state.sql`, `037_pai_user_settings_auto_generate_interval.sql`).
        We usually INSERT with only `user_id` so column DEFAULTs apply.
        The UI can pass an initial generation language from the first client
        locale; ON CONFLICT keeps existing user choices untouched.
        Net effect: every authenticated user always has exactly one row,
        and callers never need a `None` branch.
        """
        async with self._conn.cursor() as cur:
            if initial_generation_language:
                await cur.execute(
                    """
                    INSERT INTO pai_user_settings (user_id, generation_language)
                    VALUES (%s, %s)
                    ON CONFLICT (user_id) DO NOTHING
                    """,
                    (self._user_id, initial_generation_language),
                )
            else:
                await cur.execute(
                    "INSERT INTO pai_user_settings (user_id) VALUES (%s) "
                    "ON CONFLICT (user_id) DO NOTHING",
                    (self._user_id,),
                )
            await cur.execute(
                "SELECT * FROM pai_user_settings WHERE user_id = %s",
                (self._user_id,),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "settings get returned no row after lazy-create"
            raise RuntimeError(msg)
        return UserSettingsRow.from_record(row)

    async def upsert_settings(
        self,
        *,
        generation_language: str | None = None,
        auto_generate: bool | None = None,
        auto_generate_interval_minutes: int | None = None,
        auto_dreaming: bool | None = None,
        auto_crystallize: bool | None = None,
        permission_mode: str | None = None,
        proactive_enabled: bool | None = None,
        proactive_interval_seconds: int | None = None,
        metadata: dict[str, Any] | None = None,
        ambient_sources_patch: dict[str, Any] | None = None,
        notify_new_cards: bool | None = None,
        # datetime → set; None → preserve via COALESCE. The column is
        # written exactly once per user (when the in-app pre-prompt is
        # first shown) and never reset, so there's no None-means-clear
        # path to model. Route passes datetime.now(UTC) on the stamp.
        notify_permission_prompted_at: datetime | None = None,
        # datetime → set; None → preserve. The column is written exactly
        # once per user (when onboarding finishes) and never reset, so
        # there's no None-means-clear path. Route passes datetime.now(UTC)
        # on the stamp.
        onboarding_completed_at: datetime | None = None,
    ) -> UserSettingsRow:
        """Partial upsert — pass only the fields you want to change.

        Two-step: ensure-row-exists (column DEFAULTs apply) + UPDATE with
        COALESCE preserving missing fields. Defaults are NOT duplicated in
        application code; `pai_user_settings` column DEFAULTs are the
        single source of truth.

        ``ambient_sources_patch`` does a per-key shallow merge against the
        existing JSONB so toggling one source can't accidentally wipe a
        sibling (privacy invariant per docs/plans/2026-05-12-v2-to-v3-migration.mdx
        step 1 D-5). Pass ``{"sound_classifier": None}`` to remove a key.
        """
        async with self._conn.cursor() as cur:
            # Single lazy-create — works for the no-patch path AND lets the
            # ambient merge SELECT below see a real row.
            await cur.execute(
                "INSERT INTO pai_user_settings (user_id) VALUES (%s) "
                "ON CONFLICT (user_id) DO NOTHING",
                (self._user_id,),
            )

            # Merge ambient_sources before write so the UPDATE stays a
            # single statement. RLS scopes the SELECT to this user_id, and
            # user_scoped_tx wraps everything in one transaction, so the
            # read-modify-write window is serialized per-user.
            if ambient_sources_patch is not None:
                await cur.execute(
                    "SELECT ambient_sources FROM pai_user_settings WHERE user_id = %s",
                    (self._user_id,),
                )
                existing_row = await cur.fetchone()
                existing = _as_dict(existing_row["ambient_sources"]) if existing_row else {}
                merged = _merge_ambient_sources(existing, ambient_sources_patch)
                ambient_json: str | None = json.dumps(merged)
            else:
                ambient_json = None

            await cur.execute(
                """
                UPDATE pai_user_settings SET
                  generation_language            = COALESCE(%s, generation_language),
                  auto_generate                  = COALESCE(%s, auto_generate),
                  auto_generate_interval_minutes = COALESCE(%s, auto_generate_interval_minutes),
                  auto_dreaming                  = COALESCE(%s, auto_dreaming),
                  auto_crystallize               = COALESCE(%s, auto_crystallize),
                  permission_mode                = COALESCE(%s, permission_mode),
                  proactive_enabled              = COALESCE(%s, proactive_enabled),
                  proactive_interval_seconds     = COALESCE(%s, proactive_interval_seconds),
                  metadata                       = COALESCE(%s::jsonb, metadata),
                  ambient_sources                = COALESCE(%s::jsonb, ambient_sources),
                  notify_new_cards               = COALESCE(%s, notify_new_cards),
                  notify_permission_prompted_at  = COALESCE(%s, notify_permission_prompted_at),
                  onboarding_completed_at        = COALESCE(%s, onboarding_completed_at),
                  updated_at = NOW()
                WHERE user_id = %s
                RETURNING *
                """,
                (
                    generation_language,
                    auto_generate,
                    auto_generate_interval_minutes,
                    auto_dreaming,
                    auto_crystallize,
                    permission_mode,
                    proactive_enabled,
                    proactive_interval_seconds,
                    json.dumps(metadata) if metadata is not None else None,
                    ambient_json,
                    notify_new_cards,
                    notify_permission_prompted_at,
                    onboarding_completed_at,
                    self._user_id,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "settings upsert returned no row"
            raise RuntimeError(msg)
        return UserSettingsRow.from_record(row)
