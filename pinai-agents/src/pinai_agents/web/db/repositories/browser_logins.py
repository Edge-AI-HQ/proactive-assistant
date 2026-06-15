"""BrowserLoginsRepository — pai_browser_logins CRUD.

Schema: pai_browser_logins (migration 096). PK: (user_id, site_domain).

Tracks which websites the user has an active login for inside their
persistent Browserbase Context. METADATA ONLY — cookies live in the
Context (persist:True), never in this table. Lifecycle:

  * Upserted (status=active) by POST /api/browser/logins when the user
    manually operates the browser live view on a site.
  * Deleted by DELETE /api/browser/logins/{site_domain}.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class BrowserLogin:
    user_id: int
    site_domain: str
    display_name: str | None
    login_label: str | None
    status: str
    last_used_at: datetime | None
    created_at: datetime | None
    updated_at: datetime | None


class BrowserLoginsRepository(UserScopedRepository):
    async def list_for_current_user(self) -> list[BrowserLogin]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT user_id, site_domain, display_name, login_label,
                       status, last_used_at, created_at, updated_at
                FROM pai_browser_logins
                WHERE user_id = %s
                ORDER BY last_used_at DESC NULLS LAST, site_domain
                """,
                (self._user_id,),
            )
            rows = await cur.fetchall()
        return [_row_to_login(r) for r in rows]

    async def upsert(
        self,
        *,
        site_domain: str,
        display_name: str | None = None,
        login_label: str | None = None,
    ) -> None:
        """Record (or refresh) an active login for a site. Bumps
        last_used_at; keeps a prior display_name/label if this call doesn't
        carry one (COALESCE), so a bare re-touch never wipes a good label."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_browser_logins
                  (user_id, site_domain, display_name, login_label,
                   status, last_used_at)
                VALUES (%s, %s, %s, %s, 'active', NOW())
                ON CONFLICT (user_id, site_domain) DO UPDATE SET
                  display_name = COALESCE(
                      EXCLUDED.display_name, pai_browser_logins.display_name),
                  login_label = COALESCE(
                      EXCLUDED.login_label, pai_browser_logins.login_label),
                  status = 'active',
                  last_used_at = NOW(),
                  updated_at = NOW()
                """,
                (self._user_id, site_domain, display_name, login_label),
            )

    async def delete(self, site_domain: str) -> None:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM pai_browser_logins
                WHERE user_id = %s AND site_domain = %s
                """,
                (self._user_id, site_domain),
            )


def _row_to_login(row: dict[str, Any]) -> BrowserLogin:
    return BrowserLogin(
        user_id=row["user_id"],
        site_domain=row["site_domain"],
        display_name=row.get("display_name"),
        login_label=row.get("login_label"),
        status=row.get("status") or "active",
        last_used_at=row.get("last_used_at"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )
