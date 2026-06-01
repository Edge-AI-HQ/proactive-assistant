"""Memory v3 ledger Repository.

Schema: 011_pai_memory_signals.sql.

Append-only state machine:
  active → archived             (user / agent decides this row is no longer current)
  active → superseded           (agent writes a newer memory that replaces this)
                                superseded_by points at the new id
  active → active (mutate)      (debug only — frontend memory editor)

Lifecycle ops are encoded as named methods, not generic UPDATE — that
makes the state machine readable in code.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .base import UserScopedRepository


@dataclass(slots=True)
class MemoryRow:
    """1:1 with pai_memory row, decoded JSONB → list / dict."""

    id: str
    text: str
    source: str
    source_run_id: str | None
    subject: str | None
    quality: float
    confidence: float
    status: str
    superseded_by: str | None
    occurred_at: datetime | None
    created_at: datetime
    tags: list[str]
    related_memory_ids: list[str]
    reference_count: int
    last_referenced_at: datetime | None
    referenced_by_runs: list[str]

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> MemoryRow:
        return cls(
            id=row["id"],
            text=row["text"],
            source=row["source"],
            source_run_id=row.get("source_run_id"),
            subject=row.get("subject"),
            quality=float(row["quality"]),
            confidence=float(row["confidence"]),
            status=row["status"],
            superseded_by=row.get("superseded_by"),
            occurred_at=row.get("occurred_at"),
            created_at=row["created_at"],
            tags=row["tags"] if isinstance(row["tags"], list) else json.loads(row["tags"]),
            related_memory_ids=(
                row["related_memory_ids"]
                if isinstance(row["related_memory_ids"], list)
                else json.loads(row["related_memory_ids"])
            ),
            reference_count=row["reference_count"],
            last_referenced_at=row.get("last_referenced_at"),
            referenced_by_runs=(
                row["referenced_by_runs"]
                if isinstance(row["referenced_by_runs"], list)
                else json.loads(row["referenced_by_runs"])
            ),
        )


@dataclass(slots=True)
class AddMemoryInput:
    id: str
    text: str
    source: str
    subject: str | None = None
    quality: float = 0.5
    confidence: float = 0.5
    source_run_id: str | None = None
    occurred_at: datetime | None = None
    tags: list[str] | None = None


class MemoryRepository(UserScopedRepository):
    async def add(self, input: AddMemoryInput) -> MemoryRow:
        """Insert one memory + enqueue for embedding. Caller generates
        `id` (TEXT, unique per user).

        Tags default empty. status defaults to 'active'. Reference triple
        starts at 0. The embedding row is added to pai_embedding_queue
        in the same transaction — async worker (scheduler tick) picks up
        within ~30s and writes the vector back to this row.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_memory
                  (user_id, id, text, source, source_run_id, subject,
                   quality, confidence, status, occurred_at, tags)
                VALUES
                  (%s, %s, %s, %s, %s, %s, %s, %s, 'active', %s, %s::jsonb)
                RETURNING *
                """,
                (
                    self._user_id,
                    input.id,
                    input.text,
                    input.source,
                    input.source_run_id,
                    input.subject,
                    input.quality,
                    input.confidence,
                    input.occurred_at,
                    json.dumps(input.tags or []),
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"insert returned no row (user={self._user_id} id={input.id})"
            raise RuntimeError(msg)

        # Enqueue for embedding. Same transaction as the insert — if the
        # caller commits, the queue row commits too; rollback drops both.
        from ...embeddings import enqueue as enqueue_embedding  # noqa: PLC0415

        await enqueue_embedding(
            self._conn,
            user_id=self._user_id,
            table_name="pai_memory",
            row_id=input.id,
            text=input.text,
        )
        return MemoryRow.from_record(row)

    async def search_semantic(
        self,
        *,
        query_vector: list[float],
        limit: int = 10,
        min_quality: float | None = None,
    ) -> list[MemoryRow]:
        """Cosine-similarity search against the user's embedded memories.

        Filters out rows that haven't been embedded yet (embedding IS NULL)
        — those need to wait for the queue worker. Caller can fall back
        to keyword search via list_recent for those.
        """
        vec_lit = "[" + ",".join(f"{x:.6f}" for x in query_vector) + "]"
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT *, embedding <=> %s::vector AS distance
                FROM pai_memory
                WHERE user_id = %s
                  AND embedding IS NOT NULL
                  AND status = 'active'
                  AND (%s::real IS NULL OR quality >= %s)
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (vec_lit, self._user_id, min_quality, min_quality, vec_lit, limit),
            )
            rows = await cur.fetchall()
        return [MemoryRow.from_record(r) for r in rows]

    async def get(self, memory_id: str) -> MemoryRow | None:
        """Single fetch by id. Returns None if not found / not visible to user."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_memory WHERE user_id = %s AND id = %s",
                (self._user_id, memory_id),
            )
            row = await cur.fetchone()
        return MemoryRow.from_record(row) if row else None

    async def list_active(
        self,
        *,
        min_quality: float = 0.0,
        subject: str | None = None,
        subject_prefix: str | None = None,
        since: datetime | None = None,
        limit: int = 50,
        offset: int = 0,
        order_by: str = "created_at_desc",
    ) -> tuple[list[MemoryRow], int]:
        """List status='active' memories with common filters.

        Returns `(rows, total)` where `total` is the count of all rows
        matching the filters BEFORE limit/offset (via `COUNT(*) OVER()`),
        so callers can paginate without a second query and without filter
        drift between the page query and the count query.

        order_by accepts: 'created_at_desc' (default) | 'quality_desc' |
        'last_referenced_desc'. Other values raise ValueError to prevent
        SQL-injection via column name.
        """
        order_clause = {
            "created_at_desc": "ORDER BY created_at DESC",
            "quality_desc": "ORDER BY quality DESC, created_at DESC",
            "last_referenced_desc": "ORDER BY last_referenced_at DESC NULLS LAST, created_at DESC",
        }.get(order_by)
        if order_clause is None:
            msg = f"unsupported order_by: {order_by!r}"
            raise ValueError(msg)

        sql = (
            """
            SELECT *, COUNT(*) OVER () AS total_count
            FROM pai_memory
            WHERE user_id = %s
              AND status = 'active'
              AND quality >= %s
              AND (%s::text IS NULL OR subject = %s)
              AND (%s::text IS NULL OR subject LIKE %s)
              AND (%s::timestamptz IS NULL OR created_at >= %s)
        """
            + order_clause
            + " LIMIT %s OFFSET %s"
        )

        prefix_pat = f"{subject_prefix}%" if subject_prefix else None
        async with self._conn.cursor() as cur:
            await cur.execute(
                sql,
                (
                    self._user_id,
                    min_quality,
                    subject,
                    subject,
                    subject_prefix,
                    prefix_pat,
                    since,
                    since,
                    limit,
                    offset,
                ),
            )
            rows = await cur.fetchall()
        # Empty page → total=0. This is technically wrong only in the
        # "offset past end of filtered set" edge case; not worth a second
        # query (would re-introduce filter-drift surface). Frontend
        # paginators clamp to page 0 when total is 0, which recovers on
        # the next refetch.
        if not rows:
            return [], 0
        total = int(rows[0]["total_count"])
        return [MemoryRow.from_record(r) for r in rows], total

    async def archive(self, memory_id: str) -> MemoryRow | None:
        """active → archived. No-op if already archived/superseded."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_memory SET status = 'archived'
                WHERE user_id = %s AND id = %s AND status = 'active'
                RETURNING *
                """,
                (self._user_id, memory_id),
            )
            row = await cur.fetchone()
        return MemoryRow.from_record(row) if row else None

    async def supersede(self, *, old_id: str, new_id: str) -> MemoryRow | None:
        """active → superseded, link to new memory id.

        Caller is responsible for already having INSERT'd `new_id` as a
        new active memory. This call only updates the OLD row.
        """
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_memory
                SET status = 'superseded', superseded_by = %s
                WHERE user_id = %s AND id = %s AND status = 'active'
                RETURNING *
                """,
                (new_id, self._user_id, old_id),
            )
            row = await cur.fetchone()
        return MemoryRow.from_record(row) if row else None

    async def bump_reference(self, memory_ids: list[str], run_id: str) -> int:
        """Increment reference_count + append run_id to referenced_by_runs.

        Caller (agent run wrapper) tracks which memories the run consumed
        and bumps in batch at run end. Returns number of rows updated.
        """
        if not memory_ids:
            return 0
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_memory
                SET reference_count = reference_count + 1,
                    last_referenced_at = NOW(),
                    referenced_by_runs =
                      (referenced_by_runs - %s) || to_jsonb(%s::text)
                WHERE user_id = %s AND id = ANY(%s)
                """,
                (run_id, run_id, self._user_id, memory_ids),
            )
            return cur.rowcount or 0
