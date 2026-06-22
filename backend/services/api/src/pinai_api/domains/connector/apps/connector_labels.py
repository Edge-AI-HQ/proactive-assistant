"""ConnectorLabelsRepository — pai_connector_labels CRUD.

Schema: pai_connector_labels (migration 040).
PK: (user_id, connected_account_id).

Stores the human-readable label resolved from each connected Composio
account (e.g. "boliang@pinai.io" for a Gmail connection). Lifecycle:

  * Resolved + upserted by /api/composio/wait on first ACTIVE transition.
  * Re-resolved by /api/composio/reconnect (user_info can shift).
  * Deleted by /api/composio/disconnect.

Failed resolves bump `resolve_attempts` and capture `last_attempt_error`
so list_connections can lazy-retry with a bounded budget — see
composio_service.resolve_and_store_label.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pinai_db.base import UserScopedRepository


@dataclass(slots=True)
class ConnectorLabel:
    user_id: int
    connected_account_id: str
    toolkit: str
    label: str | None
    raw_user_info: dict[str, Any] | None
    resolved_at: datetime | None
    resolve_attempts: int
    last_attempt_at: datetime | None
    last_attempt_error: str | None


class ConnectorLabelsRepository(UserScopedRepository):
    async def list_for_current_user(self) -> list[ConnectorLabel]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT user_id, connected_account_id, toolkit, label,
                       raw_user_info, resolved_at, resolve_attempts,
                       last_attempt_at, last_attempt_error
                FROM pai_connector_labels
                WHERE user_id = %s
                """,
                (self._user_id,),
            )
            rows = await cur.fetchall()
        return [_row_to_label(r) for r in rows]

    async def upsert_resolved(
        self,
        *,
        connected_account_id: str,
        toolkit: str,
        label: str | None,
        raw_user_info: dict[str, Any] | None,
    ) -> None:
        """Successful resolve: clears the error/attempts trail."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_connector_labels
                  (user_id, connected_account_id, toolkit, label,
                   raw_user_info, resolved_at, resolve_attempts,
                   last_attempt_at, last_attempt_error)
                VALUES (%s, %s, %s, %s, %s::jsonb, NOW(), 0, NOW(), NULL)
                ON CONFLICT (user_id, connected_account_id) DO UPDATE SET
                  toolkit = EXCLUDED.toolkit,
                  label = EXCLUDED.label,
                  raw_user_info = EXCLUDED.raw_user_info,
                  resolved_at = NOW(),
                  resolve_attempts = 0,
                  last_attempt_at = NOW(),
                  last_attempt_error = NULL,
                  updated_at = NOW()
                """,
                (
                    self._user_id,
                    connected_account_id,
                    toolkit,
                    label,
                    json.dumps(raw_user_info) if raw_user_info is not None else None,
                ),
            )

    async def record_attempt_failure(
        self,
        *,
        connected_account_id: str,
        toolkit: str,
        error: str,
    ) -> None:
        """Failed resolve: bumps the attempt counter, stores error.
        Keeps any prior `label` / `raw_user_info` (we don't want to
        overwrite a previously good label with NULL on a transient
        failure)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_connector_labels
                  (user_id, connected_account_id, toolkit,
                   resolve_attempts, last_attempt_at, last_attempt_error)
                VALUES (%s, %s, %s, 1, NOW(), %s)
                ON CONFLICT (user_id, connected_account_id) DO UPDATE SET
                  toolkit = EXCLUDED.toolkit,
                  resolve_attempts = pai_connector_labels.resolve_attempts + 1,
                  last_attempt_at = NOW(),
                  last_attempt_error = EXCLUDED.last_attempt_error,
                  updated_at = NOW()
                """,
                (self._user_id, connected_account_id, toolkit, error[:500]),
            )

    async def delete(self, connected_account_id: str) -> None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM pai_connector_labels
                WHERE user_id = %s AND connected_account_id = %s
                """,
                (self._user_id, connected_account_id),
            )


def _row_to_label(row: dict[str, Any]) -> ConnectorLabel:
    raw = row.get("raw_user_info")
    if isinstance(raw, str):
        raw = json.loads(raw)
    return ConnectorLabel(
        user_id=row["user_id"],
        connected_account_id=row["connected_account_id"],
        toolkit=row["toolkit"],
        label=row.get("label"),
        raw_user_info=raw if isinstance(raw, dict) else None,
        resolved_at=row.get("resolved_at"),
        resolve_attempts=row.get("resolve_attempts") or 0,
        last_attempt_at=row.get("last_attempt_at"),
        last_attempt_error=row.get("last_attempt_error"),
    )
