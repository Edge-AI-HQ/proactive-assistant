"""Raw device snapshots — apps / contacts / health + ambient — into the
device-domain L0 table pai_raw_device.

Device data is its own L0 domain (doc §三): every snapshot lands in
pai_raw_device with `kind` in {apps, contacts, health, utterance,
transcript_window, visit, …} — no toolkit column (that discriminator is the
apps domain's; device's domain IS "device"). The source-specific fields live in
payload JSONB; external_id carries the device_id so the full-sync replace can
scope its DELETE to one device.

Two write modes per kind:
  * incremental — INSERT ... ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING
    (snapshots are immutable).
  * full — bracket the insert with a DELETE scoped to the device (health
    narrows further by local_date / metric and skips reference-pinned rows —
    rows already cited by a memory / evolution run are immutable evidence).
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

from pinai_db.base import UserScopedRepository
from psycopg import AsyncCursor
from psycopg.rows import DictRow

from .device_ingest.policies import (
    DeviceAppSnapshotItem,
    DeviceContactSnapshotItem,
    DeviceIngestItem,
)


@dataclass(slots=True)
class RawIngestResult:
    accepted: int
    inserted: int
    ignored: int


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class RawDeviceRepository(UserScopedRepository):
    async def _insert_raw(
        self,
        cur: AsyncCursor[DictRow],
        *,
        kind: str,
        device_id: str,
        platform: str | None = None,
        dedupe_key: str,
        occurred_at: str,
        title: str | None,
        snippet: str | None,
        payload: dict[str, Any],
        on_conflict_update: bool = False,
        on_conflict_guard: str = "",
    ) -> int:
        """One pai_raw_device row for a device item. Snapshots are immutable
        (``on_conflict_update=False`` → conflicts on the (kind, dedupe_key) key
        are left untouched). Latest-wins context events (a transcript window
        that grows with more audio) pass ``on_conflict_update=True`` so a
        re-ingest refreshes the row in place; ``on_conflict_guard`` adds a WHERE
        clause so a stale re-ingest can be rejected (rowcount=0)."""
        if on_conflict_update:
            conflict_action = (
                "DO UPDATE SET title = EXCLUDED.title, snippet = EXCLUDED.snippet, "
                "payload = EXCLUDED.payload, occurred_at = EXCLUDED.occurred_at"
            )
            if on_conflict_guard:
                conflict_action += f" WHERE {on_conflict_guard}"
        else:
            conflict_action = "DO NOTHING"
        await cur.execute(
            f"""
            INSERT INTO pai_raw_device (
              user_id, id, kind, external_id, platform,
              occurred_at, title, snippet, payload, dedupe_key
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
            ON CONFLICT (user_id, external_id, kind, dedupe_key) {conflict_action}
            """,
            (
                self._user_id,
                _gen_id("dev"),
                kind,
                device_id,
                platform,
                occurred_at,
                title,
                snippet,
                json.dumps(payload),
                dedupe_key,
            ),
        )
        return cur.rowcount or 0

    def _context_payload(self, item: DeviceIngestItem) -> dict[str, Any]:
        """Carry the context event's signal-shaped metadata into payload so the
        L1 event projector and downstream readers keep source kind / salience /
        confidence / device_id alongside the original payload. The payload `kind`
        is the RAW source kind (e.g. "ambient.utterance") — deliberately distinct
        from the table's `kind` column, which holds the normalized bucket
        ("utterance" via the item's DeviceRecipe). Both are kept: the column drives
        routing/dedupe, the payload preserves the original ambient/device origin."""
        return {
            **item.payload,
            "kind": item.kind,
            "salience": item.salience,
            "confidence": item.confidence,
            "device_id": item.device_id,
        }

    # ── context events (signal_only / dual) ──

    async def ingest_context_event(self, item: DeviceIngestItem) -> RawIngestResult:
        """Immutable pai_raw_device row for an ambient / device context event.
        The kind is the normalized bucket (utterance / visit / calendar /
        motion / focus / context); dedupe_key dedupes re-uploads."""
        async with self._conn.cursor() as cur:
            inserted = await self._insert_raw(
                cur,
                kind=item.entity_type,
                device_id=item.device_id,
                platform=item.platform,
                dedupe_key=item.dedupe_key,
                occurred_at=item.occurred_at,
                title=item.title,
                snippet=item.summary,
                payload=self._context_payload(item),
            )
        return RawIngestResult(1, inserted, 1 - inserted)

    async def upsert_transcript_window(self, item: DeviceIngestItem) -> RawIngestResult:
        """Latest-wins pai_raw_device row for a transcript candidate window
        (``ambient.candidate_window``) — the window grows as more audio lands,
        so a re-ingest on the canonical dedupe_key refreshes title / snippet /
        payload / occurred_at in place."""
        async with self._conn.cursor() as cur:
            n = await self._insert_raw(
                cur,
                kind="transcript_window",
                device_id=item.device_id,
                platform=item.platform,
                dedupe_key=item.dedupe_key,
                occurred_at=item.occurred_at,
                title=item.title,
                snippet=item.summary,
                payload=self._context_payload(item),
                on_conflict_update=True,
                # Monotonic freshness guard: the window grows with more audio, so
                # a re-ingest only wins when its raw_ref_count is >= the stored
                # one. A stale upload (fewer aggregated chunks) leaves the richer
                # row untouched (rowcount=0 → duplicate), matching the old
                # ingest_transcript_candidate_window_latest contract.
                on_conflict_guard=(
                    "COALESCE((EXCLUDED.payload->>'raw_ref_count')::int, 0) >= "
                    "COALESCE((pai_raw_device.payload->>'raw_ref_count')::int, 0)"
                ),
            )
        # n=1 on insert or a winning refresh; n=0 when the guard rejected a stale
        # re-ingest. Map that straight to inserted/ignored.
        return RawIngestResult(1, n, 1 - n)

    async def _delete_device_scope(
        self,
        cur: AsyncCursor[DictRow],
        *,
        kind: str,
        device_id: str,
        extra_sql: str = "",
        extra_params: tuple[Any, ...] = (),
    ) -> None:
        await cur.execute(
            f"""
            DELETE FROM pai_raw_device
            WHERE user_id = %s AND kind = %s
              AND external_id = %s{extra_sql}
            """,
            (self._user_id, kind, device_id, *extra_params),
        )

    # ── apps ──

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
                inserted += await self._insert_raw(
                    cur,
                    kind="apps",
                    device_id=device_id,
                    dedupe_key=f"{snapshot_id}:{a.bundle_id}",
                    occurred_at=occurred_at,
                    title=a.app_name or a.bundle_id,
                    snippet=a.bundle_id,
                    payload={
                        "device_id": device_id,
                        "snapshot_id": snapshot_id,
                        "bundle_id": a.bundle_id,
                        "app_name": a.app_name,
                        "version": a.version,
                        "last_used_at": a.last_used_at,
                    },
                )
        return RawIngestResult(accepted, inserted, accepted - inserted)

    async def replace_apps(
        self,
        *,
        device_id: str,
        occurred_at: str,
        snapshot_id: str,
        apps: list[DeviceAppSnapshotItem],
    ) -> RawIngestResult:
        async with self._conn.cursor() as cur:
            await self._delete_device_scope(cur, kind="apps", device_id=device_id)
        return await self.ingest_apps(
            device_id=device_id,
            occurred_at=occurred_at,
            snapshot_id=snapshot_id,
            apps=apps,
        )

    # ── contacts ──

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
                # Contacts have no natural unique key; combine snapshot_id with
                # index + display_name to deduplicate identical re-uploads.
                inserted += await self._insert_raw(
                    cur,
                    kind="contacts",
                    device_id=device_id,
                    dedupe_key=f"{snapshot_id}:{i}:{c.display_name or ''}",
                    occurred_at=occurred_at,
                    title=c.display_name,
                    snippet=None,
                    payload={
                        "device_id": device_id,
                        "snapshot_id": snapshot_id,
                        "display_name": c.display_name,
                        "emails": c.emails,
                        "phones": c.phones,
                        "last_modified": c.last_modified,
                    },
                )
        return RawIngestResult(accepted, inserted, accepted - inserted)

    async def replace_contacts(
        self,
        *,
        device_id: str,
        occurred_at: str,
        snapshot_id: str,
        contacts: list[DeviceContactSnapshotItem],
    ) -> RawIngestResult:
        async with self._conn.cursor() as cur:
            await self._delete_device_scope(cur, kind="contacts", device_id=device_id)
        return await self.ingest_contacts(
            device_id=device_id,
            occurred_at=occurred_at,
            snapshot_id=snapshot_id,
            contacts=contacts,
        )

    # ── health ──

    async def ingest_health(
        self,
        *,
        device_id: str,
        observations: list,
    ) -> RawIngestResult:
        if not observations:
            return RawIngestResult(0, 0, 0)
        accepted = len(observations)
        inserted = 0
        async with self._conn.cursor() as cur:
            for o in observations:
                dedupe = (
                    o.dedupe_key
                    or f"{device_id}:{o.observation_type}:{o.metric or ''}:{o.start_at or o.occurred_at}"
                )
                inserted += await self._insert_raw(
                    cur,
                    kind="health",
                    device_id=device_id,
                    dedupe_key=dedupe,
                    occurred_at=o.occurred_at,
                    title=o.metric or o.observation_type,
                    snippet=None,
                    payload={
                        **(o.payload or {}),
                        "device_id": device_id,
                        "observation_type": o.observation_type,
                        "metric": o.metric,
                        "value": o.value,
                        "unit": o.unit,
                        "start_at": o.start_at,
                        "end_at": o.end_at,
                        "local_date": o.local_date,
                        "source_app": o.source_app,
                    },
                )
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

        Always filters by ``reference_count = 0`` so rows already pinned by a
        memory / evolution run survive the replace — those are immutable raw
        evidence per the architecture doc. ``local_date`` / ``metric`` narrow
        scope (in payload JSONB) so a steps push doesn't wipe a sibling
        heart_rate row for the same day.
        """
        extra_sql = " AND reference_count = 0"
        extra_params: list[Any] = []
        if local_date:
            extra_sql += " AND payload->>'local_date' = %s"
            extra_params.append(local_date)
        if metric:
            extra_sql += " AND payload->>'metric' = %s"
            extra_params.append(metric)
        async with self._conn.cursor() as cur:
            await self._delete_device_scope(
                cur,
                kind="health",
                device_id=device_id,
                extra_sql=extra_sql,
                extra_params=tuple(extra_params),
            )
        return await self.ingest_health(device_id=device_id, observations=observations)
