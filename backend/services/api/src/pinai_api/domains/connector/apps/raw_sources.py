"""Single source of truth for raw-data sources: where each lands and how
it's displayed.

Before this module the same "(toolkit, entity) → storage" knowledge was
copied across three places and had already drifted:
  * agent/raw.py   — _RAW_TABLES / _RAW_CONNECTOR_TOOLKITS (full set)
  * ui/raw.py      — _GENERIC_RAW_SLUGS / _RAW_EVENTS_SLUGS (missed notion)
  * personal_data_snapshot.py — RAW_SOURCES (missed every generic source)

The registry itself (Store / DisplaySql / RawSource / ALL_SOURCES /
snapshot_fragment) now lives in the db leaf `pinai_db.raw_sources` because
the reward dashboard — trust-isolated from this api process — needs the
same `(toolkit, entity) → typed table + display SQL` knowledge for its
personal-data snapshot, and neither service may import the other. This
module re-exports those shared symbols and layers on the api-only
agent-reader allowlist + UI lookups.

Split of responsibility (do not blur):
  * Recipes (db/ingest_recipes/*.yaml) own *fetch* semantics — slug, since,
    entity_type, timestamp/title/snippet paths.
  * The registry owns *storage + display* — typed table name, composio
    slug for connection checks, the UI slug, and the dashboard projection.
  They reference each other by toolkit; neither duplicates the other.

Scope: the fixed, known sources (9 typed Composio + 3 device + 3 generic).
Per-user dynamic sources (custom MCP, inferred long-tail) are NOT here —
the agent reader serves those by passing toolkit/entity as SQL params to
pai_raw_events, and the UI enumerations don't list them. See
agent/raw.py for that dynamic path.
"""

from __future__ import annotations

from pinai_db.raw_sources import (
    ALL_SOURCES,
    DisplaySql,
    RawSource,
    Store,
    snapshot_fragment,
)

__all__ = [
    "ALL_SOURCES",
    "DisplaySql",
    "RawSource",
    "Store",
    "by_path",
    "by_ui_slug",
    "snapshot_fragment",
    "typed_composio_toolkits",
    "typed_path_composio_map",
    "typed_path_table_map",
]

_BY_PATH: dict[tuple[str, str], RawSource] = {(s.path_toolkit, s.entity): s for s in ALL_SOURCES}
_BY_UI_SLUG: dict[str, RawSource] = {s.ui_slug: s for s in ALL_SOURCES}


# ── Lookups ─────────────────────────────────────────────────────────────


def by_path(toolkit: str, entity: str) -> RawSource | None:
    return _BY_PATH.get((toolkit.strip().lower(), entity.strip().lower()))


def by_ui_slug(slug: str) -> RawSource | None:
    return _BY_UI_SLUG.get(slug.strip().lower())


def typed_path_table_map() -> dict[tuple[str, str], str]:
    """(path_toolkit, entity) → physical table, for the agent reader's
    static allowlist. Includes device; typed only (table is not None)."""
    return {
        (s.path_toolkit, s.entity): s.table
        for s in ALL_SOURCES
        if s.store == "typed" and s.table is not None
    }


def typed_path_composio_map() -> dict[tuple[str, str], str]:
    """(path_toolkit, entity) → Composio slug, for the typed sources that
    have a connection behind them (excludes device)."""
    return {
        (s.path_toolkit, s.entity): s.composio_toolkit
        for s in ALL_SOURCES
        if s.store == "typed" and s.composio_toolkit is not None
    }


def typed_composio_toolkits() -> frozenset[str]:
    """Composio slugs that have a typed table. A recipe whose toolkit is
    NOT in this set stores into pai_raw_events (generic) — used by the
    recipe static-validation gate."""
    return frozenset(
        s.composio_toolkit
        for s in ALL_SOURCES
        if s.store == "typed" and s.composio_toolkit is not None
    )
