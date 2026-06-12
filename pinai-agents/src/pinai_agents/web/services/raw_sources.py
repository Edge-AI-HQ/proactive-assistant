"""Single source of truth for raw-data sources: where each lands and how
it's displayed.

Before this module the same "(toolkit, entity) → storage" knowledge was
copied across three places and had already drifted:
  * agent/raw.py   — _RAW_TABLES / _RAW_CONNECTOR_TOOLKITS (full set)
  * ui/raw.py      — _GENERIC_RAW_SLUGS / _RAW_EVENTS_SLUGS (missed notion)
  * personal_data_snapshot.py — RAW_SOURCES (missed every generic source)

Split of responsibility (do not blur):
  * Recipes (db/ingest_recipes/*.yaml) own *fetch* semantics — slug, since,
    entity_type, timestamp/title/snippet paths.
  * This registry owns *storage + display* — typed table name, composio
    slug for connection checks, the UI slug, and the dashboard projection.
  They reference each other by toolkit; neither duplicates the other.

Scope: the fixed, known sources (9 typed Composio + 3 device + 3 generic).
Per-user dynamic sources (custom MCP, inferred long-tail) are NOT here —
the agent reader serves those by passing toolkit/entity as SQL params to
pai_raw_events, and the UI enumerations don't list them. See
agent/raw.py for that dynamic path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Store = Literal["typed", "events"]


@dataclass(frozen=True)
class DisplaySql:
    """SQL expressions (alias `r`) projecting a typed raw row into the
    dashboard's normalized shape. Only typed sources need these — the
    generic pai_raw_events store already has title/snippet columns."""

    title: str
    subtitle: str
    summary: str
    status: str
    chips: str


@dataclass(frozen=True)
class RawSource:
    """One raw source and everywhere it shows up.

    path_toolkit/entity: the /api/agent/raw/{path_toolkit}/{entity} pair.
      For typed sources this is the short alias (gmail, gcal, gdrive…);
      for generic sources it equals the Composio slug (the value stored in
      pai_raw_events.toolkit), so reads route correctly.
    composio_toolkit: Composio slug for the connection-active check; None
      for device sources (no Composio connection behind them).
    ui_slug: the /api/raw/<slug> identifier (frontend RAW_SOURCE_CONFIG is
      the naming authority — keep these in sync with it).
    snapshot_key/label: dashboard grouping key and human label.
    display: typed-table projection SQL; None for generic (column-backed).
    """

    path_toolkit: str
    entity: str
    store: Store
    composio_toolkit: str | None
    ui_slug: str
    snapshot_key: str
    label: str
    table: str | None = None
    display: DisplaySql | None = None


# ── The registry ────────────────────────────────────────────────────────
# Typed Composio sources (9) — own pai_raw_<x> tables + native indexes.
_TYPED_COMPOSIO: tuple[RawSource, ...] = (
    RawSource(
        path_toolkit="gmail",
        entity="messages",
        store="typed",
        composio_toolkit="gmail",
        ui_slug="gmail_messages",
        snapshot_key="gmail",
        label="Gmail",
        table="pai_raw_gmail_messages",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.subject, ''), '无主题邮件')",
            subtitle="r.from_addr",
            summary="COALESCE(NULLIF(r.snippet, ''), LEFT(COALESCE(r.body, ''), 260))",
            status="NULL",
            chips="jsonb_build_array(r.thread_id)",
        ),
    ),
    RawSource(
        path_toolkit="gcal",
        entity="events",
        store="typed",
        composio_toolkit="googlecalendar",
        ui_slug="gcal_events",
        snapshot_key="gcal",
        label="Google Calendar",
        table="pai_raw_gcal_events",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.title, ''), '未命名日历事件')",
            subtitle="r.location",
            summary="LEFT(COALESCE(r.description, ''), 260)",
            status="r.status",
            chips="jsonb_build_array(r.calendar_id)",
        ),
    ),
    RawSource(
        path_toolkit="gdrive",
        entity="files",
        store="typed",
        composio_toolkit="googledrive",
        ui_slug="gdrive_files",
        snapshot_key="gdrive",
        label="Google Drive",
        table="pai_raw_gdrive_files",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.name, ''), '未命名文件')",
            subtitle="r.mime_type",
            summary="COALESCE(r.web_view_link, '')",
            status="CASE WHEN r.trashed THEN 'trashed' ELSE 'active' END",
            chips="jsonb_build_array(r.file_id)",
        ),
    ),
    RawSource(
        path_toolkit="slack",
        entity="messages",
        store="typed",
        composio_toolkit="slack",
        ui_slug="slack_messages",
        snapshot_key="slack",
        label="Slack",
        table="pai_raw_slack_messages",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.channel_name, ''), 'Slack 消息')",
            subtitle="r.slack_user_name",
            summary="LEFT(COALESCE(r.text, ''), 280)",
            status="NULL",
            chips="jsonb_build_array(r.channel_id)",
        ),
    ),
    RawSource(
        path_toolkit="github",
        entity="issues",
        store="typed",
        composio_toolkit="github",
        ui_slug="github_issues",
        snapshot_key="github",
        label="GitHub",
        table="pai_raw_github_issues",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.title, ''), 'GitHub issue')",
            subtitle="CONCAT_WS('#', r.repo_full_name, r.number::text)",
            summary="LEFT(COALESCE(r.body_preview, ''), 280)",
            status="r.state",
            chips="jsonb_build_array(CASE WHEN r.is_pull_request THEN 'PR' ELSE 'Issue' END)",
        ),
    ),
    RawSource(
        path_toolkit="calendly",
        entity="events",
        store="typed",
        composio_toolkit="calendly",
        ui_slug="calendly_events",
        snapshot_key="calendly",
        label="Calendly",
        table="pai_raw_calendly_events",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.name, ''), 'Calendly 事件')",
            subtitle="r.location_value",
            summary="COALESCE(r.meeting_url, '')",
            status="r.status",
            chips="jsonb_build_array(r.location_type)",
        ),
    ),
    RawSource(
        path_toolkit="stripe",
        entity="invoices",
        store="typed",
        composio_toolkit="stripe",
        ui_slug="stripe_invoices",
        snapshot_key="stripe",
        label="Stripe",
        table="pai_raw_stripe_invoices",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.number, ''), r.invoice_id, 'Stripe invoice')",
            subtitle="r.customer_email",
            summary="CONCAT_WS(' ', r.amount_due::text, r.currency, r.hosted_invoice_url)",
            status="r.status",
            chips="jsonb_build_array(r.collection_method)",
        ),
    ),
    RawSource(
        path_toolkit="youtube",
        entity="subscriptions",
        store="typed",
        composio_toolkit="youtube",
        ui_slug="youtube_subscriptions",
        snapshot_key="youtube",
        label="YouTube",
        table="pai_raw_youtube_subscriptions",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.channel_title, ''), 'YouTube 订阅')",
            subtitle="r.channel_id",
            summary="LEFT(COALESCE(r.channel_description, ''), 280)",
            status="NULL",
            chips="jsonb_build_array(r.subscription_id)",
        ),
    ),
    RawSource(
        path_toolkit="linkedin",
        entity="profile",
        store="typed",
        composio_toolkit="linkedin",
        ui_slug="linkedin_profile",
        snapshot_key="linkedin",
        label="LinkedIn",
        table="pai_raw_linkedin_profile",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.localized_name, ''), CONCAT_WS(' ', r.first_name, r.last_name), 'LinkedIn profile')",
            subtitle="r.vanity_name",
            summary="COALESCE(r.headline, r.profile_url, '')",
            status="NULL",
            chips="jsonb_build_array(r.linkedin_id)",
        ),
    ),
)

# Device sources (3) — typed tables, no Composio connection behind them.
_TYPED_DEVICE: tuple[RawSource, ...] = (
    RawSource(
        path_toolkit="device",
        entity="apps",
        store="typed",
        composio_toolkit=None,
        ui_slug="device_apps_snapshot",
        snapshot_key="device_apps",
        label="设备应用",
        table="pai_raw_device_apps_snapshot",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.app_name, ''), r.bundle_id, '设备应用')",
            subtitle="r.device_id",
            summary="CONCAT_WS(' ', r.bundle_id, r.version)",
            status="NULL",
            chips="jsonb_build_array(r.snapshot_id)",
        ),
    ),
    RawSource(
        path_toolkit="device",
        entity="contacts",
        store="typed",
        composio_toolkit=None,
        ui_slug="device_contacts_snapshot",
        snapshot_key="device_contacts",
        label="设备联系人",
        table="pai_raw_device_contacts_snapshot",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.display_name, ''), '设备联系人')",
            subtitle="r.device_id",
            summary="LEFT(CONCAT_WS(' ', r.emails::text, r.phones::text), 280)",
            status="NULL",
            chips="jsonb_build_array(r.snapshot_id)",
        ),
    ),
    RawSource(
        path_toolkit="device",
        entity="health",
        store="typed",
        composio_toolkit=None,
        ui_slug="device_health_observations",
        snapshot_key="device_health",
        label="设备健康",
        table="pai_raw_device_health_observations",
        display=DisplaySql(
            title="COALESCE(NULLIF(r.metric, ''), r.observation_type, '健康数据')",
            subtitle="r.device_id",
            summary="CONCAT_WS(' ', r.value::text, r.unit, r.source_app)",
            status="NULL",
            chips="jsonb_build_array(r.local_date::text)",
        ),
    ),
)

# Generic sources (3) — land in pai_raw_events; path_toolkit == the stored
# toolkit column (== Composio slug). No typed table, no display SQL: the
# events store has title/snippet columns the dashboard reads directly.
_GENERIC: tuple[RawSource, ...] = (
    RawSource(
        path_toolkit="googledocs",
        entity="documents",
        store="events",
        composio_toolkit="googledocs",
        ui_slug="gdocs_documents",
        snapshot_key="googledocs",
        label="Google Docs",
    ),
    RawSource(
        path_toolkit="googlesheets",
        entity="spreadsheets",
        store="events",
        composio_toolkit="googlesheets",
        ui_slug="gsheets_spreadsheets",
        snapshot_key="googlesheets",
        label="Google Sheets",
    ),
    RawSource(
        path_toolkit="notion",
        entity="pages",
        store="events",
        composio_toolkit="notion",
        ui_slug="notion_pages",
        snapshot_key="notion",
        label="Notion",
    ),
)

ALL_SOURCES: tuple[RawSource, ...] = _TYPED_COMPOSIO + _TYPED_DEVICE + _GENERIC

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


# ── Dashboard SELECT fragments ──────────────────────────────────────────


def snapshot_fragment(
    source: RawSource, user_id: int, since: object, until: object
) -> tuple[str, list[object]]:
    """One UNION-ALL branch for the personal-data snapshot's raw section,
    plus its positional params. Typed sources read their table with the
    per-source display SQL; generic sources read pai_raw_events filtered
    by toolkit/entity_type, projecting the title/snippet columns."""
    if source.store == "typed":
        assert source.table is not None and source.display is not None
        d = source.display
        sql = f"""
            SELECT
              'raw' AS category,
              r.id AS item_id,
              '{source.snapshot_key}' AS source_key,
              '{source.label}' AS source_label,
              '{source.snapshot_key}' AS kind,
              {d.title} AS title,
              {d.subtitle} AS subtitle,
              {d.summary} AS summary,
              {d.status} AS status,
              NULL::float AS score,
              r.occurred_at,
              r.ingested_at AS updated_at,
              {d.chips} AS chips,
              to_jsonb(r) - 'user_id' AS payload
            FROM {source.table} r
            WHERE r.user_id = %s
              AND (%s::timestamptz IS NULL OR r.occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR r.occurred_at <= %s)
        """
        return sql, [user_id, since, since, until, until]

    sql = f"""
        SELECT
          'raw' AS category,
          r.id AS item_id,
          '{source.snapshot_key}' AS source_key,
          '{source.label}' AS source_label,
          '{source.snapshot_key}' AS kind,
          COALESCE(NULLIF(r.title, ''), '{source.label}') AS title,
          r.external_id AS subtitle,
          LEFT(COALESCE(r.snippet, ''), 280) AS summary,
          NULL::text AS status,
          NULL::float AS score,
          r.occurred_at,
          r.ingested_at AS updated_at,
          jsonb_build_array(r.entity_type) AS chips,
          r.payload AS payload
        FROM pai_raw_events r
        WHERE r.user_id = %s
          AND r.toolkit = %s
          AND r.entity_type = %s
          AND (%s::timestamptz IS NULL OR r.occurred_at >= %s)
          AND (%s::timestamptz IS NULL OR r.occurred_at <= %s)
    """
    return sql, [user_id, source.path_toolkit, source.entity, since, since, until, until]
