"""UserSettings Repository — single row per user (pai_user_settings).

Was bundled with profile + goals (the retired pai_profile / pai_goals
tables) until the lifelong-memory sunset. Profile facts/preferences/goals
moved to the L1 events stream + L2 markdown portrait; the one structured
identity field with live runtime consumers — `timezone` — moved here
(migration 113). What remains is the per-user settings row.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pinai_db.base import UserScopedRepository


@dataclass(slots=True)
class UserSettingsRow:
    # 用户时区(IANA, e.g. "Asia/Shanghai")。设备时区引导(X-Pin-Client-Timezone)
    # 写这里;chat <current_datetime> 锚点 / generator "Today is" / auto.dreaming
    # 每日 06:00 排程都读这里。从退役的 pai_profile.timezone 迁来(migration 113)。
    timezone: str
    generation_language: str
    auto_generate: bool
    auto_generate_interval_minutes: int
    auto_dreaming: bool
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
            timezone=row["timezone"],
            generation_language=row["generation_language"],
            auto_generate=row["auto_generate"],
            auto_generate_interval_minutes=row["auto_generate_interval_minutes"],
            auto_dreaming=row["auto_dreaming"],
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


class SettingsRepository(UserScopedRepository):
    async def get_settings(
        self,
        *,
        initial_generation_language: str | None = None,
    ) -> UserSettingsRow:
        """Lazy-create on first read, then return the row.

        Defaults live exclusively on `pai_user_settings` columns
        (`010_pai_core_state.sql`, `037_pai_user_settings_auto_generate_interval.sql`,
        `113_pai_user_settings_timezone.sql`). We usually INSERT with only
        `user_id` so column DEFAULTs apply. The UI can pass an initial
        generation language from the first client locale; ON CONFLICT keeps
        existing user choices untouched. Net effect: every authenticated user
        always has exactly one row, and callers never need a `None` branch.
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
        timezone: str | None = None,
        generation_language: str | None = None,
        auto_generate: bool | None = None,
        auto_generate_interval_minutes: int | None = None,
        auto_dreaming: bool | None = None,
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
                  timezone                       = COALESCE(%s, timezone),
                  generation_language            = COALESCE(%s, generation_language),
                  auto_generate                  = COALESCE(%s, auto_generate),
                  auto_generate_interval_minutes = COALESCE(%s, auto_generate_interval_minutes),
                  auto_dreaming                  = COALESCE(%s, auto_dreaming),
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
                    timezone,
                    generation_language,
                    auto_generate,
                    auto_generate_interval_minutes,
                    auto_dreaming,
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
