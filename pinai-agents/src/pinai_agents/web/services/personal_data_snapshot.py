"""Personal data snapshot for the internal dashboard.

This read model is intentionally broad: it mirrors the data surfaces the
generator can draw from, but normalizes them into a single inspectable shape
for humans. It is not used by agents.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import date, datetime
from typing import Any, Literal

from psycopg import AsyncConnection

PersonalDataCategory = Literal[
    "all",
    "profile",
    "goals",
    "settings",
    "memory",
    "skills",
    "signals",
    "world",
    "raw",
    "devices",
    "connectors",
]

CATEGORY_LABELS: dict[str, tuple[str, str]] = {
    "profile": ("画像", "用户画像、长期偏好和约束。"),
    "goals": ("目标", "长期目标和正在推进的方向。"),
    "settings": ("设置", "生成、dreaming、ambient source 等偏好。"),
    "memory": ("记忆", "系统沉淀出的长期事实。"),
    "skills": ("技能", "系统学到的可复用工作方式。"),
    "signals": ("个人信号", "最近从连接器、设备或反馈中提炼出的短期观察。"),
    "world": ("世界信号", "按用户打分后的外部世界信息。"),
    "raw": ("原始数据", "Gmail、日历、文件、设备、Slack、GitHub 等 typed raw 行。"),
    "devices": ("设备", "已注册设备、最近在线状态和端侧 metadata。"),
    "connectors": ("连接器", "Composio 连接标签和同步游标。"),
}
REDACTED_SECRET = "已隐藏敏感值"
SENSITIVE_KEY_RE = re.compile(
    r"(^|[_-])(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session|token)([_-]|$)",
    re.IGNORECASE,
)
CAMEL_BOUNDARY_RE = re.compile(r"([a-z0-9])([A-Z])")
SENSITIVE_VALUE_KEYS = {"raw_value", "secret_value", "token_value", "value"}
SENSITIVE_VALUE_LABEL_KEYS = {
    "field",
    "field_name",
    "header",
    "header_name",
    "key",
    "name",
    "property",
}

RAW_SOURCES: tuple[dict[str, str], ...] = (
    {
        "key": "gmail",
        "label": "Gmail",
        "table": "pai_raw_gmail_messages",
        "title": "COALESCE(NULLIF(r.subject, ''), '无主题邮件')",
        "subtitle": "r.from_addr",
        "summary": "COALESCE(NULLIF(r.snippet, ''), LEFT(COALESCE(r.body, ''), 260))",
        "status": "NULL",
        "chips": "jsonb_build_array(r.thread_id)",
    },
    {
        "key": "gcal",
        "label": "Google Calendar",
        "table": "pai_raw_gcal_events",
        "title": "COALESCE(NULLIF(r.title, ''), '未命名日历事件')",
        "subtitle": "r.location",
        "summary": "LEFT(COALESCE(r.description, ''), 260)",
        "status": "r.status",
        "chips": "jsonb_build_array(r.calendar_id)",
    },
    {
        "key": "gdrive",
        "label": "Google Drive",
        "table": "pai_raw_gdrive_files",
        "title": "COALESCE(NULLIF(r.name, ''), '未命名文件')",
        "subtitle": "r.mime_type",
        "summary": "COALESCE(r.web_view_link, '')",
        "status": "CASE WHEN r.trashed THEN 'trashed' ELSE 'active' END",
        "chips": "jsonb_build_array(r.file_id)",
    },
    {
        "key": "slack",
        "label": "Slack",
        "table": "pai_raw_slack_messages",
        "title": "COALESCE(NULLIF(r.channel_name, ''), 'Slack 消息')",
        "subtitle": "r.slack_user_name",
        "summary": "LEFT(COALESCE(r.text, ''), 280)",
        "status": "NULL",
        "chips": "jsonb_build_array(r.channel_id)",
    },
    {
        "key": "github",
        "label": "GitHub",
        "table": "pai_raw_github_issues",
        "title": "COALESCE(NULLIF(r.title, ''), 'GitHub issue')",
        "subtitle": "CONCAT_WS('#', r.repo_full_name, r.number::text)",
        "summary": "LEFT(COALESCE(r.body_preview, ''), 280)",
        "status": "r.state",
        "chips": "jsonb_build_array(CASE WHEN r.is_pull_request THEN 'PR' ELSE 'Issue' END)",
    },
    {
        "key": "calendly",
        "label": "Calendly",
        "table": "pai_raw_calendly_events",
        "title": "COALESCE(NULLIF(r.name, ''), 'Calendly 事件')",
        "subtitle": "r.location_value",
        "summary": "COALESCE(r.meeting_url, '')",
        "status": "r.status",
        "chips": "jsonb_build_array(r.location_type)",
    },
    {
        "key": "stripe",
        "label": "Stripe",
        "table": "pai_raw_stripe_invoices",
        "title": "COALESCE(NULLIF(r.number, ''), r.invoice_id, 'Stripe invoice')",
        "subtitle": "r.customer_email",
        "summary": "CONCAT_WS(' ', r.amount_due::text, r.currency, r.hosted_invoice_url)",
        "status": "r.status",
        "chips": "jsonb_build_array(r.collection_method)",
    },
    {
        "key": "youtube",
        "label": "YouTube",
        "table": "pai_raw_youtube_subscriptions",
        "title": "COALESCE(NULLIF(r.channel_title, ''), 'YouTube 订阅')",
        "subtitle": "r.channel_id",
        "summary": "LEFT(COALESCE(r.channel_description, ''), 280)",
        "status": "NULL",
        "chips": "jsonb_build_array(r.subscription_id)",
    },
    {
        "key": "linkedin",
        "label": "LinkedIn",
        "table": "pai_raw_linkedin_profile",
        "title": "COALESCE(NULLIF(r.localized_name, ''), CONCAT_WS(' ', r.first_name, r.last_name), 'LinkedIn profile')",
        "subtitle": "r.vanity_name",
        "summary": "COALESCE(r.headline, r.profile_url, '')",
        "status": "NULL",
        "chips": "jsonb_build_array(r.linkedin_id)",
    },
    {
        "key": "device_apps",
        "label": "设备应用",
        "table": "pai_raw_device_apps_snapshot",
        "title": "COALESCE(NULLIF(r.app_name, ''), r.bundle_id, '设备应用')",
        "subtitle": "r.device_id",
        "summary": "CONCAT_WS(' ', r.bundle_id, r.version)",
        "status": "NULL",
        "chips": "jsonb_build_array(r.snapshot_id)",
    },
    {
        "key": "device_contacts",
        "label": "设备联系人",
        "table": "pai_raw_device_contacts_snapshot",
        "title": "COALESCE(NULLIF(r.display_name, ''), '设备联系人')",
        "subtitle": "r.device_id",
        "summary": "LEFT(CONCAT_WS(' ', r.emails::text, r.phones::text), 280)",
        "status": "NULL",
        "chips": "jsonb_build_array(r.snapshot_id)",
    },
    {
        "key": "device_health",
        "label": "设备健康",
        "table": "pai_raw_device_health_observations",
        "title": "COALESCE(NULLIF(r.metric, ''), r.observation_type, '健康数据')",
        "subtitle": "r.device_id",
        "summary": "CONCAT_WS(' ', r.value::text, r.unit, r.source_app)",
        "status": "NULL",
        "chips": "jsonb_build_array(r.local_date::text)",
    },
)


def _iso(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _iso(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_iso(v) for v in value]
    return value


def _is_sensitive_key(value: Any) -> bool:
    if value is None:
        return False
    text = CAMEL_BOUNDARY_RE.sub(r"\1_\2", str(value))
    return bool(SENSITIVE_KEY_RE.search(text))


def _normalized_payload_key(value: Any) -> str:
    text = CAMEL_BOUNDARY_RE.sub(r"\1_\2", str(value))
    return text.replace("-", "_").lower()


def _redact_sensitive_payload(value: Any) -> Any:
    if isinstance(value, dict):
        has_sensitive_value_label = any(
            _normalized_payload_key(k) in SENSITIVE_VALUE_LABEL_KEYS and _is_sensitive_key(v)
            for k, v in value.items()
        )
        return {
            str(k): REDACTED_SECRET
            if _is_sensitive_key(k)
            or (has_sensitive_value_label and _normalized_payload_key(k) in SENSITIVE_VALUE_KEYS)
            else _redact_sensitive_payload(v)
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact_sensitive_payload(v) for v in value]
    return value


def _clean_chip(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower() == "null":
        return None
    return text[:80]


def _chips(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        chip = _clean_chip(item)
        if chip and chip not in out:
            out.append(chip)
    return out[:8]


def _item(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload")
    safe_payload = _redact_sensitive_payload(payload)
    safe_payload = _iso(safe_payload)
    return {
        "id": str(row.get("item_id") or ""),
        "category": str(row.get("category") or ""),
        "sourceKey": str(row.get("source_key") or row.get("category") or ""),
        "sourceLabel": str(row.get("source_label") or ""),
        "kind": row.get("kind"),
        "title": str(row.get("title") or "未命名数据"),
        "subtitle": row.get("subtitle"),
        "summary": row.get("summary"),
        "status": row.get("status"),
        "score": row.get("score"),
        "occurredAt": _iso(row.get("occurred_at")),
        "updatedAt": _iso(row.get("updated_at")),
        "chips": _chips(row.get("chips")),
        "payload": safe_payload,
    }


def _section(key: str, items: list[dict[str, Any]], total: int) -> dict[str, Any]:
    label, description = CATEGORY_LABELS[key]
    return {
        "key": key,
        "label": label,
        "description": description,
        "total": total,
        "items": items,
    }


class PersonalDataSnapshotService:
    def __init__(self, conn: AsyncConnection, user_id: int) -> None:
        self._conn = conn
        self._user_id = user_id

    async def snapshot(
        self,
        *,
        category: PersonalDataCategory = "all",
        since: datetime | None = None,
        until: datetime | None = None,
        query: str | None = None,
        limit: int = 40,
        offset: int = 0,
    ) -> dict[str, Any]:
        requested = [key for key in CATEGORY_LABELS if category == "all" or key == category]
        sections: list[dict[str, Any]] = []
        for key in requested:
            fetcher = getattr(self, f"_fetch_{key}")
            sections.append(
                await fetcher(
                    since=since,
                    until=until,
                    query=query,
                    limit=limit,
                    offset=offset,
                ),
            )

        totals = {section["key"]: section["total"] for section in sections}
        totals["all"] = sum(int(section["total"]) for section in sections)
        return {
            "ok": True,
            "filters": {
                "category": category,
                "since": _iso(since),
                "until": _iso(until),
                "query": query,
                "limit": limit,
                "offset": offset,
            },
            "totals": totals,
            "sections": sections,
        }

    async def _fetch_rows(
        self,
        key: str,
        sql: str,
        params: Sequence[Any],
    ) -> dict[str, Any]:
        async with self._conn.cursor() as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
        total = int(rows[0]["total"]) if rows else 0
        return _section(key, [_item(row) for row in rows], total)

    async def _fetch_profile(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "profile",
            """
            SELECT
              'profile' AS category,
              p.id AS item_id,
              'profile' AS source_key,
              '画像' AS source_label,
              'profile' AS kind,
              COALESCE(NULLIF(p.display_name, ''), '用户画像') AS title,
              CONCAT_WS(' · ', p.locale, p.timezone) AS subtitle,
              p.summary,
              NULL::text AS status,
              NULL::float AS score,
              p.updated_at AS occurred_at,
              p.updated_at,
              jsonb_build_array(p.locale, p.timezone) AS chips,
              to_jsonb(p) - 'user_id' AS payload,
              COUNT(*) OVER() AS total
            FROM pai_profile p
            WHERE p.user_id = %s
              AND (%s::timestamptz IS NULL OR p.updated_at >= %s)
              AND (%s::timestamptz IS NULL OR p.updated_at <= %s)
              AND (
                %s::text IS NULL
                OR p.display_name ILIKE %s
                OR COALESCE(p.summary, '') ILIKE %s
                OR to_jsonb(p)::text ILIKE %s
              )
            ORDER BY p.updated_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_settings(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "settings",
            """
            SELECT
              'settings' AS category,
              'settings' AS item_id,
              'settings' AS source_key,
              '设置' AS source_label,
              'settings' AS kind,
              '生成与采集设置' AS title,
              CONCAT_WS(' · ', s.generation_language, CASE WHEN s.auto_generate THEN '自动生成开启' ELSE '自动生成关闭' END) AS subtitle,
              CONCAT('自动生成间隔 ', s.auto_generate_interval_minutes::text, ' 分钟') AS summary,
              NULL::text AS status,
              NULL::float AS score,
              s.updated_at AS occurred_at,
              s.updated_at,
              jsonb_build_array(
                CASE WHEN s.auto_generate THEN 'auto_generate:on' ELSE 'auto_generate:off' END,
                CASE WHEN s.auto_dreaming THEN 'dreaming:on' ELSE 'dreaming:off' END,
                CASE WHEN s.auto_crystallize THEN 'crystallize:on' ELSE 'crystallize:off' END
              ) AS chips,
              to_jsonb(s) - 'user_id' AS payload,
              COUNT(*) OVER() AS total
            FROM pai_user_settings s
            WHERE s.user_id = %s
              AND (%s::timestamptz IS NULL OR s.updated_at >= %s)
              AND (%s::timestamptz IS NULL OR s.updated_at <= %s)
              AND (%s::text IS NULL OR to_jsonb(s)::text ILIKE %s)
            ORDER BY s.updated_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs, one_text_search=True),
        )

    async def _fetch_goals(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "goals",
            """
            SELECT
              'goals' AS category,
              g.id AS item_id,
              'goals' AS source_key,
              '目标' AS source_label,
              g.key AS kind,
              g.title,
              g.priority AS subtitle,
              g.summary,
              g.status,
              NULL::float AS score,
              g.updated_at AS occurred_at,
              g.updated_at,
              jsonb_build_array(g.priority, g.status, g.key) AS chips,
              to_jsonb(g) - 'user_id' AS payload,
              COUNT(*) OVER() AS total
            FROM pai_goals g
            WHERE g.user_id = %s
              AND (%s::timestamptz IS NULL OR g.updated_at >= %s)
              AND (%s::timestamptz IS NULL OR g.updated_at <= %s)
              AND (
                %s::text IS NULL
                OR g.title ILIKE %s
                OR COALESCE(g.summary, '') ILIKE %s
                OR to_jsonb(g)::text ILIKE %s
              )
            ORDER BY g.updated_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_memory(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "memory",
            """
            SELECT
              'memory' AS category,
              m.id AS item_id,
              'memory' AS source_key,
              '记忆' AS source_label,
              m.subject AS kind,
              COALESCE(NULLIF(m.subject, ''), '记忆') AS title,
              m.source AS subtitle,
              m.text AS summary,
              m.status,
              m.quality::float AS score,
              COALESCE(m.occurred_at, m.created_at) AS occurred_at,
              COALESCE(m.last_referenced_at, m.created_at) AS updated_at,
              jsonb_build_array(m.source, m.status, CONCAT('quality ', ROUND(m.quality::numeric, 2)::text)) AS chips,
              jsonb_build_object(
                'id', m.id,
                'text', m.text,
                'source', m.source,
                'source_run_id', m.source_run_id,
                'subject', m.subject,
                'quality', m.quality,
                'confidence', m.confidence,
                'status', m.status,
                'superseded_by', m.superseded_by,
                'occurred_at', m.occurred_at,
                'created_at', m.created_at,
                'tags', m.tags,
                'related_memory_ids', m.related_memory_ids,
                'reference_count', m.reference_count,
                'last_referenced_at', m.last_referenced_at,
                'referenced_by_runs', m.referenced_by_runs,
                'embedding_model', m.embedding_model,
                'embedded_at', m.embedded_at
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_memory m
            WHERE m.user_id = %s
              AND (%s::timestamptz IS NULL OR COALESCE(m.occurred_at, m.created_at) >= %s)
              AND (%s::timestamptz IS NULL OR COALESCE(m.occurred_at, m.created_at) <= %s)
              AND (
                %s::text IS NULL
                OR m.text ILIKE %s
                OR COALESCE(m.subject, '') ILIKE %s
                OR COALESCE(m.tags::text, '') ILIKE %s
              )
            ORDER BY COALESCE(m.occurred_at, m.created_at) DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_skills(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "skills",
            """
            SELECT
              'skills' AS category,
              s.id AS item_id,
              'skills' AS source_key,
              '技能' AS source_label,
              s.source AS kind,
              s.title,
              s.description AS subtitle,
              LEFT(COALESCE(s.body, ''), 360) AS summary,
              s.status,
              NULL::float AS score,
              s.updated_at AS occurred_at,
              s.updated_at,
              jsonb_build_array(s.status, s.source, CONCAT('rev ', s.revision::text)) AS chips,
              to_jsonb(s) - 'user_id' AS payload,
              COUNT(*) OVER() AS total
            FROM pai_skill_index s
            WHERE s.user_id = %s
              AND (%s::timestamptz IS NULL OR s.updated_at >= %s)
              AND (%s::timestamptz IS NULL OR s.updated_at <= %s)
              AND (
                %s::text IS NULL
                OR s.title ILIKE %s
                OR COALESCE(s.description, '') ILIKE %s
                OR COALESCE(s.body, '') ILIKE %s
              )
            ORDER BY s.updated_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_signals(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "signals",
            """
            SELECT
              'signals' AS category,
              ps.id AS item_id,
              ps.source AS source_key,
              '个人信号' AS source_label,
              ps.kind,
              ps.title,
              ps.subject AS subtitle,
              ps.summary,
              ps.status,
              ps.salience::float AS score,
              ps.occurred_at,
              ps.ingested_at AS updated_at,
              jsonb_build_array(ps.kind, ps.source, ps.status, CONCAT('salience ', ROUND(ps.salience::numeric, 2)::text)) AS chips,
              jsonb_build_object(
                'id', ps.id,
                'kind', ps.kind,
                'title', ps.title,
                'summary', ps.summary,
                'payload', ps.payload,
                'salience', ps.salience,
                'confidence', ps.confidence,
                'dedupe_key', ps.dedupe_key,
                'occurred_at', ps.occurred_at,
                'available_at', ps.available_at,
                'expires_at', ps.expires_at,
                'source', ps.source,
                'device_id', ps.device_id,
                'subject', ps.subject,
                'source_raw_table', ps.source_raw_table,
                'source_raw_ids', ps.source_raw_ids,
                'status', ps.status,
                'consumed_by_run_id', ps.consumed_by_run_id,
                'ingested_at', ps.ingested_at,
                'reference_count', ps.reference_count,
                'last_referenced_at', ps.last_referenced_at,
                'referenced_by_runs', ps.referenced_by_runs,
                'embedding_model', ps.embedding_model,
                'embedded_at', ps.embedded_at
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_personal_signals ps
            WHERE ps.user_id = %s
              AND (%s::timestamptz IS NULL OR ps.occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR ps.occurred_at <= %s)
              AND (
                %s::text IS NULL
                OR ps.title ILIKE %s
                OR ps.summary ILIKE %s
                OR COALESCE(ps.payload::text, '') ILIKE %s
              )
            ORDER BY ps.occurred_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_world(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "world",
            """
            SELECT
              'world' AS category,
              w.id AS item_id,
              w.provider AS source_key,
              '世界信号' AS source_label,
              w.stream_type AS kind,
              w.title,
              w.url AS subtitle,
              w.summary,
              v.status,
              v.salience::float AS score,
              COALESCE(w.published_at, w.created_at) AS occurred_at,
              COALESCE(v.scored_at, w.updated_at) AS updated_at,
              jsonb_build_array(w.provider, w.stream_type, w.importance, v.status) AS chips,
              jsonb_build_object(
                'id', w.id,
                'provider', w.provider,
                'stream_type', w.stream_type,
                'title', w.title,
                'url', w.url,
                'normalized_url', w.normalized_url,
                'external_id', w.external_id,
                'summary', w.summary,
                'published_at', w.published_at,
                'search_queries', w.search_queries,
                'topics', w.topics,
                'regions', w.regions,
                'importance', w.importance,
                'metadata', w.metadata,
                'created_at', w.created_at,
                'updated_at', w.updated_at,
                'embedding_model', w.embedding_model,
                'embedded_at', w.embedded_at,
                'user_view', to_jsonb(v) - 'user_id'
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_world_signal_user_view v
            JOIN pai_world_signals w ON w.id = v.world_signal_id
            WHERE v.user_id = %s
              AND (%s::timestamptz IS NULL OR COALESCE(w.published_at, w.created_at) >= %s)
              AND (%s::timestamptz IS NULL OR COALESCE(w.published_at, w.created_at) <= %s)
              AND (
                %s::text IS NULL
                OR w.title ILIKE %s
                OR COALESCE(w.summary, '') ILIKE %s
                OR COALESCE(w.topics::text, '') ILIKE %s
              )
            ORDER BY COALESCE(w.published_at, w.created_at) DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_devices(self, **kwargs: Any) -> dict[str, Any]:
        return await self._fetch_rows(
            "devices",
            """
            SELECT
              'devices' AS category,
              d.device_id AS item_id,
              d.platform AS source_key,
              '设备' AS source_label,
              d.platform AS kind,
              COALESCE(NULLIF(d.display_name, ''), d.device_id) AS title,
              d.model AS subtitle,
              CONCAT_WS(' ', d.app_version, d.device_id) AS summary,
              d.status,
              NULL::float AS score,
              COALESCE(d.last_seen_at, d.registered_at) AS occurred_at,
              COALESCE(d.last_seen_at, d.registered_at) AS updated_at,
              jsonb_build_array(d.platform, d.status, d.app_version) AS chips,
              to_jsonb(d) - 'user_id' - 'device_token_hash' AS payload,
              COUNT(*) OVER() AS total
            FROM pai_user_devices d
            WHERE d.user_id = %s
              AND (%s::timestamptz IS NULL OR COALESCE(d.last_seen_at, d.registered_at) >= %s)
              AND (%s::timestamptz IS NULL OR COALESCE(d.last_seen_at, d.registered_at) <= %s)
              AND (
                %s::text IS NULL
                OR d.device_id ILIKE %s
                OR COALESCE(d.display_name, '') ILIKE %s
                OR to_jsonb(d)::text ILIKE %s
              )
            ORDER BY COALESCE(d.last_seen_at, d.registered_at) DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_connectors(self, **kwargs: Any) -> dict[str, Any]:
        since = kwargs.get("since")
        until = kwargs.get("until")
        query = kwargs.get("query")
        like = f"%{query}%" if query else None
        limit = kwargs.get("limit")
        offset = kwargs.get("offset")
        return await self._fetch_rows(
            "connectors",
            """
            SELECT *, COUNT(*) OVER() AS total
            FROM (
              SELECT
                'connectors' AS category,
                l.connected_account_id AS item_id,
                l.toolkit AS source_key,
                '连接器标签' AS source_label,
                l.toolkit AS kind,
                COALESCE(NULLIF(l.label, ''), l.connected_account_id) AS title,
                l.connected_account_id AS subtitle,
                COALESCE(l.last_attempt_error, '') AS summary,
                NULL::text AS status,
                NULL::float AS score,
                COALESCE(l.updated_at, l.created_at) AS occurred_at,
                COALESCE(l.updated_at, l.created_at) AS updated_at,
                jsonb_build_array(l.toolkit, CONCAT('attempts ', l.resolve_attempts::text)) AS chips,
                to_jsonb(l) - 'user_id' AS payload
              FROM pai_connector_labels l
              WHERE l.user_id = %s
                AND (%s::timestamptz IS NULL OR COALESCE(l.updated_at, l.created_at) >= %s)
                AND (%s::timestamptz IS NULL OR COALESCE(l.updated_at, l.created_at) <= %s)
              UNION ALL
              SELECT
                'connectors' AS category,
                CONCAT(c.toolkit, ':', c.connected_account_id) AS item_id,
                c.toolkit AS source_key,
                '同步游标' AS source_label,
                c.toolkit AS kind,
                CONCAT(c.toolkit, ' 同步游标') AS title,
                c.connected_account_id AS subtitle,
                COALESCE(c.last_synced_at::text, '尚未同步') AS summary,
                NULL::text AS status,
                NULL::float AS score,
                COALESCE(c.last_synced_at, c.updated_at) AS occurred_at,
                c.updated_at,
                jsonb_build_array(c.toolkit) AS chips,
                to_jsonb(c) - 'user_id' AS payload
              FROM pai_connector_sync_cursors c
              WHERE c.user_id = %s
                AND (%s::timestamptz IS NULL OR COALESCE(c.last_synced_at, c.updated_at) >= %s)
                AND (%s::timestamptz IS NULL OR COALESCE(c.last_synced_at, c.updated_at) <= %s)
            ) items
            WHERE (
              %s::text IS NULL
              OR title ILIKE %s
              OR COALESCE(summary, '') ILIKE %s
              OR payload::text ILIKE %s
            )
            ORDER BY occurred_at DESC NULLS LAST
            LIMIT %s
            OFFSET %s
            """,
            (
                self._user_id,
                since,
                since,
                until,
                until,
                self._user_id,
                since,
                since,
                until,
                until,
                query,
                like,
                like,
                like,
                limit,
                offset,
            ),
        )

    async def _fetch_raw(self, **kwargs: Any) -> dict[str, Any]:
        since = kwargs.get("since")
        until = kwargs.get("until")
        query = kwargs.get("query")
        like = f"%{query}%" if query else None
        limit = kwargs.get("limit")
        offset = kwargs.get("offset")
        selects = []
        params: list[Any] = []
        for source in RAW_SOURCES:
            selects.append(
                f"""
                SELECT
                  'raw' AS category,
                  r.id AS item_id,
                  '{source["key"]}' AS source_key,
                  '{source["label"]}' AS source_label,
                  '{source["key"]}' AS kind,
                  {source["title"]} AS title,
                  {source["subtitle"]} AS subtitle,
                  {source["summary"]} AS summary,
                  {source["status"]} AS status,
                  NULL::float AS score,
                  r.occurred_at,
                  r.ingested_at AS updated_at,
                  {source["chips"]} AS chips,
                  to_jsonb(r) - 'user_id' AS payload
                FROM {source["table"]} r
                WHERE r.user_id = %s
                  AND (%s::timestamptz IS NULL OR r.occurred_at >= %s)
                  AND (%s::timestamptz IS NULL OR r.occurred_at <= %s)
                """,
            )
            params.extend([self._user_id, since, since, until, until])

        sql = f"""
            SELECT *, COUNT(*) OVER() AS total
            FROM (
              {" UNION ALL ".join(selects)}
            ) raw_items
            WHERE (
              %s::text IS NULL
              OR title ILIKE %s
              OR COALESCE(summary, '') ILIKE %s
              OR payload::text ILIKE %s
            )
            ORDER BY occurred_at DESC NULLS LAST, updated_at DESC NULLS LAST
            LIMIT %s
            OFFSET %s
        """
        params.extend([query, like, like, like, limit, offset])
        return await self._fetch_rows("raw", sql, params)

    def _params(self, kwargs: dict[str, Any], *, one_text_search: bool = False) -> tuple[Any, ...]:
        since = kwargs.get("since")
        until = kwargs.get("until")
        query = kwargs.get("query")
        like = f"%{query}%" if query else None
        limit = kwargs.get("limit")
        offset = kwargs.get("offset")
        if one_text_search:
            return (
                self._user_id,
                since,
                since,
                until,
                until,
                query,
                like,
                limit,
                offset,
            )
        return (
            self._user_id,
            since,
            since,
            until,
            until,
            query,
            like,
            like,
            like,
            limit,
            offset,
        )
