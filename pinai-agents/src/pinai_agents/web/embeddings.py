"""Embeddings client + worker — semantic memory search backbone.

Pipeline:
  1. Memory / signal write inserts the row + adds (table, id, text) to
     pai_embedding_queue with status='pending'.
  2. Scheduler tick wakes _drain_embedding_queue every N seconds.
  3. Worker batches up to BATCH_SIZE pending rows, calls LiteLLM
     /embeddings (text-embedding-3-small, 1536 dims), writes vectors
     back to source tables, marks queue rows done.
  4. Failed rows get attempts++ and retry until MAX_ATTEMPTS, after
     which they're left as 'failed' for manual inspection.

Why a queue not synchronous embed: the LiteLLM call is a few hundred ms
on a good day; doing it inline doubles user-visible write latency. Async
queue keeps memory_add fast and decouples model availability from write
path. Trade-off: search index lags inserts by one tick interval (~30s
default), which is fine — semantic search isn't a strict-consistency
read path.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..config import get_web_settings

logger = logging.getLogger(__name__)

# Pinned to text-embedding-3-small for now; bump alongside the
# embedding column dimension if we move to large (3072) or another
# provider. NOTE: schema 029 fixes vector dim at 1536 — changing model
# to a different dim requires a migration (drop + recreate column).
_MODEL = "text-embedding-3-small"
_DIM = 1536

# Per-call cap. LiteLLM passes batches as `input: [str, str, ...]`;
# OpenAI's limit is 2048 inputs but we stay conservative.
_BATCH = 32

_MAX_ATTEMPTS = 5


class EmbeddingError(Exception):
    """Raised when embedding fails — caller decides retry vs. mark failed."""


async def embed_batch(texts: list[str]) -> list[list[float]]:
    """Call LiteLLM's /embeddings endpoint with a batch of texts.

    Uses a fresh httpx.AsyncClient per call — embedding is a low-rate
    background task; no need for connection pooling. Failed responses
    raise EmbeddingError; caller increments attempts.
    """
    settings = get_web_settings()
    base = (settings.litellm_base_url or "").rstrip("/")
    if not base:
        msg = "LITELLM_BASE_URL not configured — cannot embed"
        raise EmbeddingError(msg)

    if not texts:
        return []

    headers: dict[str, str] = {"Content-Type": "application/json"}
    # LiteLLM proxy: master key is fine for service-internal calls.
    # Per-user budgets stay enforced via virtual_key for chat-side
    # LLM calls; the embedding worker is service-side.
    master = settings.litellm_master_key or ""
    if master:
        headers["Authorization"] = f"Bearer {master}"

    body: dict[str, Any] = {"model": _MODEL, "input": texts}
    async with httpx.AsyncClient(timeout=30.0) as cli:
        resp = await cli.post(f"{base}/embeddings", headers=headers, json=body)
    if resp.status_code >= 400:
        msg = f"litellm /embeddings {resp.status_code}: {resp.text[:200]}"
        raise EmbeddingError(msg)
    data = resp.json()
    items = data.get("data") or []
    if len(items) != len(texts):
        msg = f"embeddings count mismatch: sent {len(texts)} got {len(items)}"
        raise EmbeddingError(msg)
    out: list[list[float]] = []
    for it in items:
        emb = it.get("embedding")
        if not isinstance(emb, list) or len(emb) != _DIM:
            msg = f"bad embedding shape: {type(emb).__name__} len={len(emb) if isinstance(emb, list) else 'n/a'}"
            raise EmbeddingError(msg)
        out.append(emb)
    return out


async def enqueue(
    conn,
    *,
    user_id: int,
    table_name: str,
    row_id: str,
    text: str,
) -> None:
    """Add a (table, row_id) entry to the embedding queue. Idempotent
    on the (user_id, table, id) PK — re-enqueueing the same row resets
    status to 'pending' and snapshots the latest text (handles updates)."""
    if not text.strip():
        return  # skip empty bodies — nothing to embed
    if table_name not in ("pai_memory", "pai_personal_signals", "pai_world_signals"):
        msg = f"unsupported embedding table: {table_name}"
        raise ValueError(msg)
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO pai_embedding_queue
              (user_id, table_name, row_id, text, status, attempts)
            VALUES (%s, %s, %s, %s, 'pending', 0)
            ON CONFLICT (user_id, table_name, row_id) DO UPDATE SET
              text = EXCLUDED.text,
              status = 'pending',
              attempts = 0,
              last_error = NULL,
              enqueued_at = NOW(),
              completed_at = NULL
            """,
            (user_id, table_name, row_id, text),
        )


async def drain_queue(conn, *, batch_size: int = _BATCH) -> int:
    """Pull up to `batch_size` pending rows, embed, write back, mark
    done. Returns count of successfully embedded rows.

    Runs as service_role (no app.user_id) — touches multiple users'
    queue rows in one batch. The write-back to pai_memory etc. is
    user-scoped per row (each UPDATE uses the row's user_id directly,
    not RLS-derived).
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT user_id, table_name, row_id, text, attempts
            FROM pai_embedding_queue
            WHERE status = 'pending' AND attempts < %s
            ORDER BY enqueued_at
            LIMIT %s
            FOR UPDATE SKIP LOCKED
            """,
            (_MAX_ATTEMPTS, batch_size),
        )
        rows = await cur.fetchall()
    if not rows:
        return 0

    texts = [r["text"] for r in rows]
    try:
        vectors = await embed_batch(texts)
    except EmbeddingError as e:
        logger.warning("embedding batch failed: %s", e)
        # Bump attempts; status stays 'pending' until cap hit.
        async with conn.cursor() as cur:
            for r in rows:
                new_attempts = int(r["attempts"]) + 1
                new_status = "failed" if new_attempts >= _MAX_ATTEMPTS else "pending"
                await cur.execute(
                    """
                    UPDATE pai_embedding_queue
                    SET attempts = %s, status = %s, last_error = %s
                    WHERE user_id = %s AND table_name = %s AND row_id = %s
                    """,
                    (
                        new_attempts,
                        new_status,
                        str(e)[:500],
                        r["user_id"],
                        r["table_name"],
                        r["row_id"],
                    ),
                )
        return 0

    # Write embeddings back to source tables + mark queue done.
    written = 0
    async with conn.cursor() as cur:
        for r, vec in zip(rows, vectors, strict=True):
            table = r["table_name"]
            uid = int(r["user_id"])
            rid = r["row_id"]
            # Format vector for psycopg: pgvector accepts a string like
            # '[0.1, 0.2, ...]' or python list via psycopg's adapter.
            # We use the string form for portability.
            vec_lit = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
            try:
                # Embeddings on shared pai_world_signals don't have user_id
                # column — write by id only. Per-user tables include it.
                if table == "pai_world_signals":
                    await cur.execute(
                        f"""
                        UPDATE {table}
                        SET embedding = %s::vector,
                            embedding_model = %s,
                            embedded_at = NOW()
                        WHERE id = %s
                        """,
                        (vec_lit, _MODEL, rid),
                    )
                else:
                    await cur.execute(
                        f"""
                        UPDATE {table}
                        SET embedding = %s::vector,
                            embedding_model = %s,
                            embedded_at = NOW()
                        WHERE user_id = %s AND id = %s
                        """,
                        (vec_lit, _MODEL, uid, rid),
                    )
                await cur.execute(
                    """
                    UPDATE pai_embedding_queue
                    SET status = 'done', completed_at = NOW(), last_error = NULL
                    WHERE user_id = %s AND table_name = %s AND row_id = %s
                    """,
                    (uid, table, rid),
                )
                written += 1
            except Exception as e:
                logger.warning(
                    "embedding write-back failed user=%d table=%s id=%s: %s",
                    uid,
                    table,
                    rid,
                    e,
                )
    return written


async def text_to_query_vector(text: str) -> list[float]:
    """Embed a single query string for similarity search."""
    if not text.strip():
        msg = "query text required"
        raise ValueError(msg)
    vecs = await embed_batch([text])
    return vecs[0]
