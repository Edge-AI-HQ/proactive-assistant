"""Raw device snapshot tables — pai_raw_device_apps_snapshot,
pai_raw_device_contacts_snapshot, pai_raw_device_health_observations.

Schema: 019_pai_raw_device.sql.

Two write modes per table:
  * incremental — INSERT ... ON CONFLICT (user_id, dedupe_key) DO NOTHING.
  * full — bracket the insert with a DELETE that scopes to the device
    (and for health, narrows further by local_date when known).

The ingest route runs both modes via the policy registry; this repo just
exposes one method per (table, mode) pair.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

from ...device_ingest.policies import (
    DeviceAppSnapshotItem,
    DeviceContactSnapshotItem,
)
from ..repositories.base import UserScopedRepository


@dataclass(slots=True)
class RawIngestResult:
    accepted: int
    inserted: int
    ignored: int


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class RawDeviceRepository(UserScopedRepository):

    # ── apps_snapshot ──

    async def ingest_apps(
        self,
        *,
        device_id: str,
        occurred_at: str,
        snapshot_id: str,
        apps: list[DeviceAppSnapshotItem],
    ) -> RawIngestResult:
        if not apps:
            return RawIngestResult(0, 0, 0)
        accepted = len(apps)
        inserted = 0
        async with self._conn.cursor() as cur:
            for a in apps:
                dedupe = f"{snapshot_id}:{a.bundle_id}"
                await cur.execute(
                    """
                    INSERT INTO pai_raw_device_apps_snapshot
                      (user_id, id, snapshot_id, device_id, bundle_id,
                       app_name, version, last_used_at, occurred_at, dedupe_key)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
                    """,
                    (
                        self._user_id, _gen_id("app"), snapshot_id, device_id,
                        a.bundle_id, a.app_name, a.version, a.last_used_at,
                        occurred_at, dedupe,
                    ),
                )
                inserted += cur.rowcount or 0
        return RawIngestResult(accepted, inserted, accepted - inserted)

    async def replace_apps(
        self, *, device_id: str, occurred_at: str, snapshot_id: str,
        apps: list[DeviceAppSnapshotItem],
    ) -> RawIngestResult:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM pai_raw_device_apps_snapshot WHERE user_id = %s AND device_id = %s",
                (self._user_id, device_id),
            )
        return await self.ingest_apps(
            device_id=device_id, occurred_at=occurred_at,
            snapshot_id=snapshot_id, apps=apps,
        )

    # ── contacts_snapshot ──

    async def ingest_contacts(
        self,
        *,
        device_id: str,
        occurred_at: str,
        snapshot_id: str,
        contacts: list[DeviceContactSnapshotItem],
    ) -> RawIngestResult:
        if not contacts:
            return RawIngestResult(0, 0, 0)
        accepted = len(contacts)
        inserted = 0
        async with self._conn.cursor() as cur:
            for i, c in enumerate(contacts):
                # Contacts have no natural unique key; combine snapshot_id
                # with index + display_name to deduplicate identical
                # uploads of the same snapshot.
                dedupe = f"{snapshot_id}:{i}:{c.display_name or ''}"
                await cur.execute(
                    """
                    INSERT INTO pai_raw_device_contacts_snapshot
                      (user_id, id, snapshot_id, device_id, display_name,
                       emails, phones, last_modified, occurred_at, dedupe_key)
                    VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
                    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
                    """,
                    (
                        self._user_id, _gen_id("ct"), snapshot_id, device_id,
                        c.display_name,
                        json.dumps(c.emails), json.dumps(c.phones),
                        c.last_modified, occurred_at, dedupe,
                    ),
                )
                inserted += cur.rowcount or 0
        return RawIngestResult(accepted, inserted, accepted - inserted)

    async def replace_contacts(
        self, *, device_id: str, occurred_at: str, snapshot_id: str,
        contacts: list[DeviceContactSnapshotItem],
    ) -> RawIngestResult:
        async with self._conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM pai_raw_device_contacts_snapshot WHERE user_id = %s AND device_id = %s",
                (self._user_id, device_id),
            )
        return await self.ingest_contacts(
            device_id=device_id, occurred_at=occurred_at,
            snapshot_id=snapshot_id, contacts=contacts,
        )

    # ── health_observations ──

    async def ingest_health(
        self, *, device_id: str, observations: list,
    ) -> RawIngestResult:
        if not observations:
            return RawIngestResult(0, 0, 0)
        accepted = len(observations)
        inserted = 0
        async with self._conn.cursor() as cur:
            for o in observations:
                row_id = o.id or _gen_id("hlt")
                dedupe = (
                    o.dedupe_key
                    or f"{device_id}:{o.observation_type}:{o.metric or ''}:{o.start_at or o.occurred_at}"
                )
                await cur.execute(
                    """
                    INSERT INTO pai_raw_device_health_observations
                      (user_id, id, device_id, observation_type, metric, value,
                       unit, start_at, end_at, local_date, source_app,
                       payload, occurred_at, dedupe_key)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                    ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
                    """,
                    (
                        self._user_id, row_id, device_id, o.observation_type,
                        o.metric, o.value, o.unit, o.start_at, o.end_at,
                        o.local_date, o.source_app,
                        json.dumps(o.payload or {}), o.occurred_at, dedupe,
                    ),
                )
                inserted += cur.rowcount or 0
        return RawIngestResult(accepted, inserted, accepted - inserted)

    async def replace_health(
        self,
        *,
        device_id: str,
        local_date: str | None,
        metric: str | None = None,
        observations: list,
    ) -> RawIngestResult:
        """Full-sync replace for health observations.

        Always filters by ``reference_count = 0`` so rows already pinned
        by a memory / evolution run survive the replace — those are
        immutable raw evidence per the architecture doc. ``metric``
        narrows scope when the envelope carries a single metric so a
        steps push doesn't wipe a sibling heart_rate row for the same
        ``local_date``.
        """
        clauses = [
            "user_id = %s",
            "device_id = %s",
            "reference_count = 0",
        ]
        params: list[Any] = [self._user_id, device_id]
        if local_date:
            clauses.append("local_date = %s")
            params.append(local_date)
        if metric:
            clauses.append("metric = %s")
            params.append(metric)
        sql = (
            "DELETE FROM pai_raw_device_health_observations WHERE "
            + " AND ".join(clauses)
        )
        async with self._conn.cursor() as cur:
            await cur.execute(sql, tuple(params))
        return await self.ingest_health(
            device_id=device_id, observations=observations,
        )
