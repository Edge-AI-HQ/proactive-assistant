"""Shared raw-data source registry: the fixed, known raw sources, which L0
domain table each lands in, and how each shows up in the dashboard.

L0 storage is split by **domain** (doc §三「L0·Raw:契约,不是表」), not unified:

  * pai_raw_apps   — every Composio app / generic connector (gmail / slack /
    github / notion …); discriminator = `toolkit` + `entity_type`.
  * pai_raw_device — on-device data (apps / contacts / health snapshots +
    ambient utterance / transcript windows); discriminator = `kind`, no toolkit
    column, external_id = device_id.

The unification doc §62 原则 7 asks for happens one layer up — a single retrieval
interface (raw_agent) + a source→table registry — NOT a single physical table.
This module owns that registry: each RawSource carries its `domain` so readers /
the dashboard route to the right table + discriminator column.

This lives in the db leaf because *more than one* trust-isolated service needs
the same source→table knowledge:

  * pinai_api (connector domain) owns the authoritative registry plus the
    agent-reader lookups (by_path / path_composio_map) layered on top — see
    `pinai_api.domains.connector.apps.raw_sources`.
  * pinai_reward_dashboard renders the personal-data snapshot from `ALL_SOURCES`
    + the `snapshot_fragment` projection.

Putting the registry + projection here keeps a single source of truth without
either service importing the other (which the trust boundary forbids). Split of
responsibility (do not blur):
  * Recipes (db/ingest_recipes/*.yaml) own *fetch + projection* semantics — slug,
    since, entity_type, timestamp/title/snippet paths.
  * This registry owns *display + routing metadata* — domain (→ table), composio
    slug for connection checks, the dashboard grouping/label.
  They reference each other by toolkit; neither duplicates the other.

Scope: the fixed, known sources (9 Composio app + 3 device + 3 generic). Per-user
dynamic sources (custom MCP, inferred long-tail) are NOT here — they're all apps
domain, and the agent reader serves them by passing toolkit/entity as SQL params
to pai_raw_apps. See the api-side `raw_agent.py` for that path.
"""

from __future__ import annotations

from dataclasses import dataclass

# L0 domain → physical table. Routing SSOT for readers + the dashboard.
TABLE_APPS = "pai_raw_apps"
TABLE_DEVICE = "pai_raw_device"


@dataclass(frozen=True)
class RawSource:
    """One raw source: which L0 table it lands in + everywhere it shows up.

    domain: "apps" | "device" — routes to pai_raw_apps (toolkit + entity_type
      discriminator) or pai_raw_device (kind discriminator).
    path_toolkit/entity: the /api/agent/raw/{path_toolkit}/{entity} pair. For
      Composio sources path_toolkit is the short alias (gmail, gcal, gdrive…)
      that resolves to the stored Composio slug; for generic sources it equals
      the slug; for device it's "device" and entity is the kind (apps/contacts/
      health).
    composio_toolkit: Composio slug for the connection-active check + the stored
      pai_raw_apps.toolkit value; None for device (no Composio connection behind
      it, lands in pai_raw_device).
    snapshot_key/label: dashboard grouping key and human label.
    """

    domain: str
    path_toolkit: str
    entity: str
    composio_toolkit: str | None
    snapshot_key: str
    label: str

    @property
    def table(self) -> str:
        """The L0 table this source's rows live in."""
        return TABLE_DEVICE if self.domain == "device" else TABLE_APPS


# ── The registry ────────────────────────────────────────────────────────
# Composio app sources (9) — the high-frequency toolkits. domain=apps.
_COMPOSIO: tuple[RawSource, ...] = (
    RawSource("apps", "gmail", "messages", "gmail", "gmail", "Gmail"),
    RawSource("apps", "gcal", "events", "googlecalendar", "gcal", "Google Calendar"),
    RawSource("apps", "gdrive", "files", "googledrive", "gdrive", "Google Drive"),
    RawSource("apps", "slack", "messages", "slack", "slack", "Slack"),
    RawSource("apps", "github", "issues", "github", "github", "GitHub"),
    RawSource("apps", "calendly", "events", "calendly", "calendly", "Calendly"),
    RawSource("apps", "stripe", "invoices", "stripe", "stripe", "Stripe"),
    RawSource("apps", "youtube", "subscriptions", "youtube", "youtube", "YouTube"),
    RawSource("apps", "linkedin", "profile", "linkedin", "linkedin", "LinkedIn"),
)

# Device sources (3) — no Composio connection (domain=device, kind discriminator).
_DEVICE: tuple[RawSource, ...] = (
    RawSource("device", "device", "apps", None, "device_apps", "设备应用"),
    RawSource("device", "device", "contacts", None, "device_contacts", "设备联系人"),
    RawSource("device", "device", "health", None, "device_health", "设备健康"),
)

# Generic long-tail sources (3) — path_toolkit == the stored Composio slug.
_GENERIC: tuple[RawSource, ...] = (
    RawSource("apps", "googledocs", "documents", "googledocs", "googledocs", "Google Docs"),
    RawSource(
        "apps", "googlesheets", "spreadsheets", "googlesheets", "googlesheets", "Google Sheets"
    ),
    RawSource("apps", "notion", "pages", "notion", "notion", "Notion"),
)

ALL_SOURCES: tuple[RawSource, ...] = _COMPOSIO + _DEVICE + _GENERIC


# ── Dashboard SELECT fragments ──────────────────────────────────────────


def snapshot_fragment(
    source: RawSource, user_id: int, since: object, until: object
) -> tuple[str, list[object]]:
    """One UNION-ALL branch for the personal-data snapshot's raw section, plus
    its positional params. Routes to the source's domain table + discriminator:
    apps → pai_raw_apps WHERE toolkit/entity_type, device → pai_raw_device WHERE
    kind. Source-specific columns live in payload JSONB; the dashboard shows the
    recipe-projected title/snippet."""
    if source.domain == "device":
        # pai_raw_device: discriminator = kind (= the source's entity), no toolkit.
        where = "r.kind = %s"
        disc_params: list[object] = [source.entity]
    else:
        # pai_raw_apps: discriminator = toolkit (Composio slug) + entity_type.
        stored_toolkit = source.composio_toolkit or source.path_toolkit
        where = "r.toolkit = %s AND r.entity_type = %s"
        disc_params = [stored_toolkit, source.entity]
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
          jsonb_build_array('{source.entity}') AS chips,
          r.payload AS payload
        FROM {source.table} r
        WHERE r.user_id = %s
          AND {where}
          AND (%s::timestamptz IS NULL OR r.occurred_at >= %s)
          AND (%s::timestamptz IS NULL OR r.occurred_at <= %s)
    """
    return sql, [user_id, *disc_params, since, since, until, until]
