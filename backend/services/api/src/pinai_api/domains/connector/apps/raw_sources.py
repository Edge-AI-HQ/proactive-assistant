"""Single source of truth for raw-data sources: where each lands and how it's
displayed.

Before this module the same "(toolkit, entity) → source" knowledge was copied
across three places and had already drifted:
  * agent/raw.py   — _RAW_TABLES / _RAW_CONNECTOR_TOOLKITS (full set)
  * ui/raw.py      — _GENERIC_RAW_SLUGS / _RAW_EVENTS_SLUGS (missed notion)
  * personal_data_snapshot.py — RAW_SOURCES (missed every generic source)

The registry itself (RawSource / ALL_SOURCES / snapshot_fragment) lives in the db
leaf `pinai_db.raw_sources` because the reward dashboard — trust-isolated from
this api process — needs the same `(toolkit, entity) → source` knowledge for its
personal-data snapshot, and neither service may import the other. This module
re-exports those shared symbols and layers on the api-only lookups.

L0 storage is split by domain: a source's `domain` ("apps" / "device") routes
reads to pai_raw_apps or pai_raw_device (see the registry in `pinai_db.raw_sources`).
The `(toolkit, entity)` pair stays a connection / display lookup — the agent
reader resolves domain → table, then passes toolkit/entity as SQL params.

Split of responsibility (do not blur):
  * Recipes (db/ingest_recipes/*.yaml) own *fetch + projection* semantics — slug,
    since, entity_type, timestamp/title/snippet paths.
  * The registry owns *display + routing metadata* — domain (→ table), composio
    slug for connection checks, the dashboard grouping/label.
  They reference each other by toolkit; neither duplicates the other.

Scope: the fixed, known sources (9 Composio app + 3 device + 3 generic). Per-user
dynamic sources (custom MCP, inferred long-tail) are NOT here — they're all apps
domain; the agent reader serves them by passing toolkit/entity as SQL params to
pai_raw_apps, and the UI enumerations don't list them. See raw_agent.py for that
dynamic path.
"""

from __future__ import annotations

from pinai_db.raw_sources import (
    ALL_SOURCES,
    RawSource,
    snapshot_fragment,
)

__all__ = [
    "ALL_SOURCES",
    "RawSource",
    "by_path",
    "path_composio_map",
    "snapshot_fragment",
]

_BY_PATH: dict[tuple[str, str], RawSource] = {(s.path_toolkit, s.entity): s for s in ALL_SOURCES}


# ── Lookups ─────────────────────────────────────────────────────────────


def by_path(toolkit: str, entity: str) -> RawSource | None:
    return _BY_PATH.get((toolkit.strip().lower(), entity.strip().lower()))


def path_composio_map() -> dict[tuple[str, str], str]:
    """(path_toolkit, entity) → Composio slug, for the known sources that have a
    connection behind them (excludes device, whose composio_toolkit is None).
    Used by the agent reader's connection-active check."""
    return {
        (s.path_toolkit, s.entity): s.composio_toolkit
        for s in ALL_SOURCES
        if s.composio_toolkit is not None
    }
