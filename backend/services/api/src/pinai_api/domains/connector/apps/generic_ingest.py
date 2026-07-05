"""Generic raw ingest — land EVERY app/connector toolkit's items in the L0
apps-domain table pai_raw_apps.

This is the ONLY ingest path for the apps domain: all Composio app + generic
connector toolkits land in pai_raw_apps (device data has its own writer +
table — see device/raw_device.py → pai_raw_device). The recipe supplies the
(light) semantics — entity_type, id_field, timestamp_path, title_path,
snippet_path — and everything else is stored verbatim in the payload JSONB for
the L1 projector / evolve agent to read.

`toolkit` here is the Composio slug (gmail / googlecalendar / googledocs);
the raw reader (raw_agent) translates the path alias (gcal) → slug before
querying, so pai_raw_apps.toolkit is uniformly the slug.

Must not import connector_ingest (it imports us).
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
            pass
        # Slack-style epoch carrying fractional seconds as a string
        # ("1700000000.123456") — not all-digits, not ISO. float() it.
        try:
            secs = float(s)
        except ValueError:
            return None
        return datetime.fromtimestamp(secs / 1000.0 if secs > 1e11 else secs, tz=UTC)
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
    """Any source item → pai_raw_apps row dict. None for non-dicts
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
    # Shape-variant fallback (e.g. GCal all-day: start.date instead of the timed
    # start.dateTime). Without this, all-day items yield occurred_at=None → the
    # upsert's COALESCE(..., NOW()) piles them all onto today.
    if occurred_at is None and recipe.timestamp_fallback_path:
        occurred_at = parse_any_ts(_walk_path(item, recipe.timestamp_fallback_path))

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
    """INSERT ... ON CONFLICT DO UPDATE into the apps-domain table pai_raw_apps.
    Entities are mostly mutable, so refresh-on-conflict is the safe
    default. Returns newly-inserted count (updates excluded). expires_at
    / reference tracking use table defaults (NULL / 0 / '[]'); the evolve
    forgetting pass sets TTLs later."""
    inserted = 0
    for item in items:
        mapped = map_item(item, toolkit=toolkit, entity_type=entity_type, recipe=recipe)
        if mapped is None:
            continue
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_raw_apps (
                  user_id, id, toolkit, entity_type, external_id,
                  occurred_at, title, snippet, payload, dedupe_key
                ) VALUES (
                  %s, %s, %s, %s, %s,
                  COALESCE(%s, NOW()), %s, %s, %s::jsonb, %s
                )
                ON CONFLICT (user_id, toolkit, entity_type, dedupe_key)
                DO UPDATE SET
                  -- content_updated_at moves ONLY on a real payload change
                  -- (title/snippet/occurred_at are all derived from payload,
                  -- so one IS DISTINCT FROM covers them). It feeds the
                  -- projector's supersede re-projection (design §6.3):
                  -- changed row → new event revision superseding the old.
                  -- An identical re-sync must NOT touch it, or every sync
                  -- would churn L1 revisions.
                  content_updated_at = CASE
                    WHEN pai_raw_apps.payload IS DISTINCT FROM EXCLUDED.payload
                    THEN NOW() ELSE pai_raw_apps.content_updated_at
                  END,
                  payload = EXCLUDED.payload,
                  -- Only move occurred_at when a real timestamp was
                  -- extracted; otherwise EXCLUDED carries NOW() and a
                  -- re-synced row would stay "fresh" forever, polluting
                  -- the generation 24h window.
                  occurred_at = COALESCE(%s, pai_raw_apps.occurred_at),
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
