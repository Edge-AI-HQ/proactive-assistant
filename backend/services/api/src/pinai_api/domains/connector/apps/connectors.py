"""ConnectorsRepository — connector_sync_cursors CRUD.

Schema: pai_connector_sync_cursors (migration 015).
PK: (user_id, toolkit, connected_account_id).

The cursor records the last successful sync's lower bound. Sync mode
reads it to decide what `since` to pass to the per-toolkit fetcher;
on success, writes it forward to the sync's start time. On failure
the cursor is untouched, so the next attempt re-fetches the same
window — raw-table dedupe absorbs the overlap.

`toolkit_cursor` is a free-form JSONB escape hatch for toolkits whose
"since" is more complex than a single timestamp (e.g. paginated
opaque cursor strings). Most toolkits leave it null and use only
last_synced_at.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from pinai_db.base import UserScopedRepository


@dataclass(slots=True)
class ConnectorSyncCursor:
    user_id: int
    toolkit: str
    connected_account_id: str
    last_synced_at: datetime
    toolkit_cursor: dict[str, Any] | None
    updated_at: datetime


class ConnectorsRepository(UserScopedRepository):
    """Cursor get/set for connector incremental sync."""

    async def get_cursor(
        self,
        *,
        toolkit: str,
        connected_account_id: str,
    ) -> ConnectorSyncCursor | None:
        """Return the cursor row, or None if no successful sync yet
        (caller falls back to a bootstrap window — typically 24h)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT user_id, toolkit, connected_account_id,
                       last_synced_at, toolkit_cursor, updated_at
                FROM pai_connector_sync_cursors
                WHERE user_id = %s AND toolkit = %s
                  AND connected_account_id = %s
                """,
                (self._user_id, toolkit, connected_account_id),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        raw_tc = row.get("toolkit_cursor")
        if isinstance(raw_tc, str):
            raw_tc = json.loads(raw_tc)
        return ConnectorSyncCursor(
            user_id=row["user_id"],
            toolkit=row["toolkit"],
            connected_account_id=row["connected_account_id"],
            last_synced_at=row["last_synced_at"],
            toolkit_cursor=raw_tc if isinstance(raw_tc, dict) else None,
            updated_at=row["updated_at"],
        )

    async def set_cursor(
        self,
        *,
        toolkit: str,
        connected_account_id: str,
        last_synced_at: datetime,
        toolkit_cursor: dict[str, Any] | None = None,
    ) -> None:
        """Upsert. Only called after a sync's raw-insert succeeds — failures
        leave the prior cursor in place so the next attempt re-pulls."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_connector_sync_cursors
                  (user_id, toolkit, connected_account_id,
                   last_synced_at, toolkit_cursor)
                VALUES (%s, %s, %s, %s, %s::jsonb)
                ON CONFLICT (user_id, toolkit, connected_account_id) DO UPDATE
                  SET last_synced_at = EXCLUDED.last_synced_at,
                      toolkit_cursor = EXCLUDED.toolkit_cursor,
                      updated_at = NOW()
                """,
                (
                    self._user_id,
                    toolkit,
                    connected_account_id,
                    last_synced_at,
                    json.dumps(toolkit_cursor) if toolkit_cursor is not None else None,
                ),
            )
