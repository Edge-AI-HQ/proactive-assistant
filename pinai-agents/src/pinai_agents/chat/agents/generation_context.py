"""Deterministic context builder for generator runs.

The builder reads web's agent APIs with the per-run JWT already installed
in ``run_context``. It collects complete rows for the selected window,
then generator.py is responsible for source-index compaction before any
LLM prompt sees the data.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from ..tools import http_client

logger = logging.getLogger(__name__)

_MIN_CONTEXT_HOURS = 24
_DEFAULT_PAGE_SIZE = 500
_MAX_PAGES = 1_000

_RAW_SOURCE_BY_TOOLKIT: dict[str, tuple[str, str]] = {
    "gmail": ("gmail", "messages"),
    "googlecalendar": ("gcal", "events"),
    "gcal": ("gcal", "events"),
    "googledrive": ("gdrive", "files"),
    "gdrive": ("gdrive", "files"),
    "slack": ("slack", "messages"),
    "github": ("github", "issues"),
    "calendly": ("calendly", "events"),
    "stripe": ("stripe", "invoices"),
    "youtube": ("youtube", "subscriptions"),
    "linkedin": ("linkedin", "profile"),
}

_BASE_RAW_SOURCES: tuple[tuple[str, str], ...] = (
    ("gmail", "messages"),
    ("gcal", "events"),
)


@dataclass(frozen=True)
class GenerationContextWindow:
    since: datetime
    until: datetime
    reason: str

    def as_dict(self) -> dict[str, str]:
        return {
            "since": self.since.isoformat(),
            "until": self.until.isoformat(),
            "reason": self.reason,
        }


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def compute_context_window(
    *,
    now: datetime,
    last_success_at: datetime | None = None,
    min_hours: int = _MIN_CONTEXT_HOURS,
) -> GenerationContextWindow:
    """Cover at least the past 24h, and extend to the previous cycle if older."""
    until = _aware_utc(now)
    min_since = until - timedelta(hours=min_hours)
    if last_success_at is None:
        return GenerationContextWindow(since=min_since, until=until, reason="min_24h")

    last = _aware_utc(last_success_at)
    if last < min_since:
        return GenerationContextWindow(since=last, until=until, reason="last_success")
    return GenerationContextWindow(since=min_since, until=until, reason="min_24h")


def explicit_context_window(
    *,
    since: datetime,
    until: datetime,
) -> GenerationContextWindow:
    return GenerationContextWindow(
        since=_aware_utc(since),
        until=_aware_utc(until),
        reason="explicit",
    )


def _items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        value = payload.get("items")
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _error_payload(exc: BaseException) -> dict[str, str]:
    return {"_error": f"{type(exc).__name__}: {exc}"}


async def _safe_get(path: str, **params: Any) -> Any:
    try:
        return await http_client.get(path, **params)
    except Exception as e:  # noqa: BLE001
        logger.warning("generation context GET failed path=%s error=%s", path, e)
        return _error_payload(e)


async def _paged_items(
    path: str,
    *,
    page_size: int = _DEFAULT_PAGE_SIZE,
    **params: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = int(params.pop("offset", 0) or 0)
    pages = 0
    error: str | None = None
    while pages < _MAX_PAGES:
        payload = await _safe_get(
            path,
            **params,
            limit=page_size,
            offset=offset,
        )
        if isinstance(payload, dict) and payload.get("error"):
            error = str(payload.get("detail") or payload.get("error"))
            break
        page = _items(payload)
        rows.extend(page)
        pages += 1
        if len(page) < page_size:
            break
        offset += page_size
    return rows, {
        "count": len(rows),
        "pages": pages,
        "pageSize": page_size,
        "truncated": pages >= _MAX_PAGES,
        "error": error,
    }


def _connection_toolkit(connection: dict[str, Any]) -> str | None:
    raw = connection.get("toolkit")
    if isinstance(raw, dict):
        raw = raw.get("slug") or raw.get("name")
    if raw is None:
        raw = connection.get("toolkit_slug") or connection.get("toolkitSlug")
    return str(raw).strip().lower() if raw else None


def _raw_sources_from_connections(connections: list[dict[str, Any]]) -> list[tuple[str, str]]:
    sources = list(_BASE_RAW_SOURCES)
    seen = set(sources)
    for connection in connections:
        toolkit_slug = _connection_toolkit(connection)
        source = _RAW_SOURCE_BY_TOOLKIT.get(toolkit_slug or "")
        if source is None or source in seen:
            continue
        seen.add(source)
        sources.append(source)
    return sources


async def build_generation_context(
    *,
    now: datetime,
    context_since: datetime | None = None,
    context_until: datetime | None = None,
    last_success_at: datetime | None = None,
    raw_page_size: int = _DEFAULT_PAGE_SIZE,
    page_size: int = _DEFAULT_PAGE_SIZE,
) -> dict[str, Any]:
    until = context_until or now
    window = (
        explicit_context_window(since=context_since, until=until)
        if context_since is not None
        else compute_context_window(now=until, last_success_at=last_success_at)
    )
    since_iso = window.since.isoformat()
    until_iso = window.until.isoformat()

    (
        profile,
        memory_payload,
        signals,
        cards_recent,
        feedback,
        world,
        preferences,
        connections_payload,
    ) = await asyncio.gather(
        _safe_get("/api/agent/profile/get"),
        _safe_get("/api/agent/memory/list", minQuality=0.7, limit=200, offset=0),
        _paged_items(
            "/api/agent/signals/recent",
            status="all",
            since=since_iso,
            until=until_iso,
            includePayload=True,
            page_size=page_size,
        ),
        _safe_get("/api/agent/cards/recent", limit=30),
        _safe_get("/api/agent/feedback/list", since=since_iso, limit=200),
        _safe_get("/api/agent/world/recent", status="open", hours=24, limit=200),
        _safe_get("/api/agent/preferences/list", status="active", limit=200),
        _safe_get("/api/agent/composio/connections"),
    )

    signal_rows, signal_stats = signals
    connections = _items(connections_payload)
    raw_sources = _raw_sources_from_connections(connections)
    raw_results = await asyncio.gather(
        *(
            _paged_items(
                f"/api/agent/raw/{toolkit}/{entity}",
                since=since_iso,
                until=until_iso,
                page_size=raw_page_size,
            )
            for toolkit, entity in raw_sources
        )
    )
    connected_raw: dict[str, list[dict[str, Any]]] = {}
    raw_stats: dict[str, dict[str, Any]] = {}
    for (toolkit, entity), (rows, stats) in zip(raw_sources, raw_results, strict=True):
        key = f"{toolkit}/{entity}"
        connected_raw[key] = rows
        raw_stats[key] = stats

    context = {
        "context_window": window.as_dict(),
        "profile": profile,
        "memory": _items(memory_payload),
        "signals": signal_rows,
        "gmail": connected_raw.get("gmail/messages", []),
        "gcal": connected_raw.get("gcal/events", []),
        "cards_recent": _items(cards_recent),
        "feedback": _items(feedback),
        "world": _items(world),
        "preferences": _items(preferences),
        "connections": connections,
        "connected_raw": connected_raw,
        "ambient_signal_details": [],
        "context_stats": {
            "window": window.as_dict(),
            "signals": signal_stats,
            "connected_raw": raw_stats,
            "memory": {"count": len(_items(memory_payload))},
            "cards_recent": {"count": len(_items(cards_recent))},
            "feedback": {"count": len(_items(feedback))},
            "world": {"count": len(_items(world))},
            "preferences": {"count": len(_items(preferences))},
        },
    }
    logger.info(
        "generation context built window=%s..%s signals=%d raw_rows=%d raw_sources=%d",
        since_iso,
        until_iso,
        len(signal_rows),
        sum(len(rows) for rows in connected_raw.values()),
        len(connected_raw),
    )
    return context
