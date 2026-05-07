"""Generic per-user KV (pai_app_state).

Used by:
  - crystallize state (namespace='crystallize')
  - misc agent run scratch state
  - user-facing UI prefs that don't deserve a typed column

Keep the API thin — JSON in, JSON out, no schema enforcement.
"""

from __future__ import annotations

import json
from typing import Any

from .base import UserScopedRepository


class AppStateRepository(UserScopedRepository):
    async def get(self, namespace: str, key: str) -> Any | None:
        """Return the parsed JSON value, or None if missing."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT value FROM pai_app_state
                WHERE user_id = %s AND namespace = %s AND key = %s
                """,
                (self._user_id, namespace, key),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        v = row["value"]
        return v if not isinstance(v, str) else json.loads(v)

    async def set(self, namespace: str, key: str, value: Any) -> None:
        """Upsert. Caller passes a JSON-serializable value."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_app_state (user_id, namespace, key, value, updated_at)
                VALUES (%s, %s, %s, %s::jsonb, NOW())
                ON CONFLICT (user_id, namespace, key) DO UPDATE SET
                  value = EXCLUDED.value,
                  updated_at = NOW()
                """,
                (self._user_id, namespace, key, json.dumps(value)),
            )

    async def delete(self, namespace: str, key: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM pai_app_state
                WHERE user_id = %s AND namespace = %s AND key = %s
                """,
                (self._user_id, namespace, key),
            )
            return (cur.rowcount or 0) > 0

    async def list_namespace(self, namespace: str) -> dict[str, Any]:
        """Return all keys under a namespace as a dict. Empty dict if none."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT key, value FROM pai_app_state
                WHERE user_id = %s AND namespace = %s
                """,
                (self._user_id, namespace),
            )
            rows = await cur.fetchall()
        out: dict[str, Any] = {}
        for r in rows:
            v = r["value"]
            out[r["key"]] = v if not isinstance(v, str) else json.loads(v)
        return out
