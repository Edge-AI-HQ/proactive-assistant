"""Generic raw ingest — land any toolkit's items in pai_raw_events.

Counterpart to the per-toolkit `_upsert_<tk>` functions in
connector_ingest.py: toolkits WITHOUT a typed pai_raw_* table fall back
to this module. The recipe supplies the (light) semantics — entity_type,
id_field, timestamp_path, title_path, snippet_path — everything else is
stored verbatim in the payload JSONB for the evolve agent to read.

Must not import connector_ingest (it imports us for the fallback).
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import DictRow

from .ingest_runner import Recipe, _walk_path

logger = logging.getLogger(__name__)

# Defensive cap: long-tail toolkits can return pathological single items
# (inlined attachments etc.). Oversized payloads are stored truncated with
# a marker rather than rejected — the envelope columns stay usable.
_MAX_PAYLOAD_BYTES = 256 * 1024


def parse_any_ts(value: Any) -> datetime | None:
    """ISO string / epoch seconds / epoch millis → aware datetime.
    None on anything unparsable — caller falls back to NOW()."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        secs = float(value) / 1000.0 if value > 1e11 else float(value)
        return datetime.fromtimestamp(secs, tz=UTC)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if s.isdigit():
            ms = int(s)
            secs = ms / 1000.0 if ms > 1e11 else float(ms)
            return datetime.fromtimestamp(secs, tz=UTC)
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _gen_raw_id() -> str:
    """Same shape as connector_ingest._gen_raw_id — PK filler; the
    (user_id, toolkit, entity_type, dedupe_key) unique index is the
    actual dedupe."""
    return f"raw_{int(time.time() * 1_000_000):x}"


def _canonical_hash(payload: dict[str, Any]) -> str:
    canon = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canon.encode()).hexdigest()[:32]


def _as_text(value: Any, *, max_len: int) -> str | None:
    if value is None:
        return None
    s = value if isinstance(value, str) else str(value)
    s = s.strip()
    if not s:
        return None
    return s[:max_len]


def map_item(
    item: dict[str, Any],
    *,
    toolkit: str,
    entity_type: str,
    recipe: Recipe,
) -> dict[str, Any] | None:
    """Any source item → pai_raw_events row dict. None for non-dicts
    (run_fetch already filters, second line of defense)."""
    if not isinstance(item, dict):
        return None

    external_id: str | None = None
    if recipe.id_field:
        external_id = _as_text(item.get(recipe.id_field), max_len=512)

    if external_id:
        dedupe_key = f"{toolkit}:{entity_type}:{external_id}"
    else:
        dedupe_key = f"{toolkit}:{entity_type}:sha256:{_canonical_hash(item)}"

    occurred_at: datetime | None = None
    if recipe.timestamp_path:
        occurred_at = parse_any_ts(_walk_path(item, recipe.timestamp_path))

    title = (
        _as_text(_walk_path(item, recipe.title_path), max_len=512) if recipe.title_path else None
    )
    snippet = (
        _as_text(_walk_path(item, recipe.snippet_path), max_len=2000)
        if recipe.snippet_path
        else None
    )

    payload_json = json.dumps(item, default=str)
    if len(payload_json.encode()) > _MAX_PAYLOAD_BYTES:
        logger.warning(
            "[generic_ingest] payload truncated toolkit=%s entity=%s key=%s",
            toolkit,
            entity_type,
            dedupe_key,
        )
        payload_json = json.dumps(
            {"__truncated__": True, "id": external_id, "title": title},
        )

    return {
        "external_id": external_id,
        "occurred_at": occurred_at,
        "title": title,
        "snippet": snippet,
        "payload_json": payload_json,
        "dedupe_key": dedupe_key,
    }


async def upsert_generic(
    conn: AsyncConnection[DictRow],
    user_id: int,
    toolkit: str,
    entity_type: str,
    recipe: Recipe,
    items: list[dict[str, Any]],
) -> int:
    """INSERT ... ON CONFLICT DO UPDATE into pai_raw_events. Long-tail
    entities are mostly mutable, so refresh-on-conflict is the safe
    default (matches github/gdrive/calendly typed upserters). Returns
    newly-inserted count (updates excluded), same semantics as the
    typed upserters."""
    inserted = 0
    for item in items:
        mapped = map_item(item, toolkit=toolkit, entity_type=entity_type, recipe=recipe)
        if mapped is None:
            continue
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_events (
                  user_id, id, toolkit, entity_type, external_id,
                  occurred_at, title, snippet, payload, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  COALESCE(%s, NOW()), %s, %s, %s::jsonb, %s
                )
                ON CONFLICT (user_id, toolkit, entity_type, dedupe_key)
                DO UPDATE SET
                  payload = EXCLUDED.payload,
                  -- Only move occurred_at when a real timestamp was
                  -- extracted; otherwise EXCLUDED carries NOW() and a
                  -- re-synced row would stay "fresh" forever, polluting
                  -- the generation 24h window.
                  occurred_at = COALESCE(%s, pai_raw_events.occurred_at),
                  ingested_at = NOW(),
                  title = EXCLUDED.title,
                  snippet = EXCLUDED.snippet
                RETURNING (xmax = 0) AS is_insert
                """,
                (
                    user_id,
                    _gen_raw_id(),
                    toolkit,
                    entity_type,
                    mapped["external_id"],
                    mapped["occurred_at"],
                    mapped["title"],
                    mapped["snippet"],
                    mapped["payload_json"],
                    mapped["dedupe_key"],
                    mapped["occurred_at"],
                ),
            )
            row = await cur.fetchone()
            if row is not None and row.get("is_insert"):
                inserted += 1
    return inserted
