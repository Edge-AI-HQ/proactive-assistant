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

from pinai_db import raw_sources
from psycopg import AsyncConnection
from psycopg.rows import DictRow

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
    "profile": ("画像", "身份字段（语言/时区）加上 L2 画像 USER 段 markdown。"),
    "goals": ("目标", "L2 画像 GOALS 段 markdown，由 agent 维护。"),
    "settings": ("设置", "生成、dreaming、ambient source 等偏好。"),
    "memory": ("记忆", "L1 事件时间线（pai_events，curated active/pending）。"),
    "skills": ("技能", "系统学到的可复用工作方式。"),
    "signals": ("个人信号", "L1 事件里来自设备的观察（source='device'）。"),
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
    def __init__(self, conn: AsyncConnection[DictRow], user_id: int) -> None:
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
        # pai_profile retired (DROP migration 114). Identity now lives in
        # pai_user_settings — timezone (113) + generation_language (the locale
        # successor); display_name has no new home and is gone. The persona —
        # summary / facts / preferences / constraints — moved to the L2 portrait
        # (pai_user_strings slot 'USER', markdown). So this section is identity
        # (from settings) + the USER-slot markdown surfaced as `summary`; the
        # structured persona buckets the old snapshot carried are gone. Driven
        # from pai_user_settings (every user has a row) LEFT JOIN the USER slot
        # so the section still renders before the agent writes a portrait.
        return await self._fetch_rows(
            "profile",
            """
            SELECT
              'profile' AS category,
              s.user_id AS item_id,
              'profile' AS source_key,
              '画像' AS source_label,
              'profile' AS kind,
              '用户画像' AS title,
              CONCAT_WS(' · ', s.generation_language, s.timezone) AS subtitle,
              us.content AS summary,
              NULL::text AS status,
              NULL::float AS score,
              GREATEST(s.updated_at, COALESCE(us.updated_at, s.updated_at)) AS occurred_at,
              GREATEST(s.updated_at, COALESCE(us.updated_at, s.updated_at)) AS updated_at,
              jsonb_build_array(s.generation_language, s.timezone) AS chips,
              jsonb_build_object(
                'user_id', s.user_id,
                'locale', s.generation_language,
                'timezone', s.timezone,
                'portrait_user', us.content,
                'portrait_version', us.version,
                'updated_at', GREATEST(s.updated_at, COALESCE(us.updated_at, s.updated_at))
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_user_settings s
            LEFT JOIN pai_user_strings us
              ON us.user_id = s.user_id AND us.slot = 'USER'
            WHERE s.user_id = %s
              AND (
                %s::timestamptz IS NULL
                OR GREATEST(s.updated_at, COALESCE(us.updated_at, s.updated_at)) >= %s
              )
              AND (
                %s::timestamptz IS NULL
                OR GREATEST(s.updated_at, COALESCE(us.updated_at, s.updated_at)) <= %s
              )
              AND (
                %s::text IS NULL
                OR COALESCE(us.content, '') ILIKE %s
                OR CONCAT_WS(' ', s.generation_language, s.timezone) ILIKE %s
                OR COALESCE(us.content, '') ILIKE %s
              )
            ORDER BY GREATEST(s.updated_at, COALESCE(us.updated_at, s.updated_at)) DESC
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
                CASE WHEN s.auto_dreaming THEN 'dreaming:on' ELSE 'dreaming:off' END
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
        # Goals retired into the L2 portrait: pai_goals (structured rows) is
        # replaced by the GOALS markdown slot in pai_user_strings, maintained by
        # the agent. One item — the GOALS slot — surfaced as a markdown summary.
        return await self._fetch_rows(
            "goals",
            """
            SELECT
              'goals' AS category,
              us.slot AS item_id,
              'goals' AS source_key,
              '目标' AS source_label,
              us.slot AS kind,
              '长期目标' AS title,
              CONCAT('版本 ', us.version::text) AS subtitle,
              us.content AS summary,
              NULL::text AS status,
              NULL::float AS score,
              us.updated_at AS occurred_at,
              us.updated_at,
              jsonb_build_array(us.slot, CONCAT('v', us.version::text)) AS chips,
              jsonb_build_object(
                'slot', us.slot,
                'content', us.content,
                'version', us.version,
                'char_budget', us.char_budget,
                'updated_at', us.updated_at
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_user_strings us
            WHERE us.user_id = %s
              AND us.slot = 'GOALS'
              AND (%s::timestamptz IS NULL OR us.updated_at >= %s)
              AND (%s::timestamptz IS NULL OR us.updated_at <= %s)
              AND (
                %s::text IS NULL
                OR us.content ILIKE %s
                OR us.slot ILIKE %s
                OR us.content ILIKE %s
              )
            ORDER BY us.updated_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_memory(self, **kwargs: Any) -> dict[str, Any]:
        # pai_memory retired into the L1 event stream (pai_events). This section
        # is now the semantic timeline: every event_type, the live rows only
        # (superseded_by_id IS NULL; superseded rows hidden). status reflects the
        # curated_at handoff (pending / curated); score is reference_count — the
        # objective usage signal that replaced the importance column. The
        # bi-temporal occurred_at / recorded_at both ride along in the payload.
        # since/until filter on occurred_at; query matches title / body / event_type.
        return await self._fetch_rows(
            "memory",
            """
            SELECT
              'memory' AS category,
              e.id AS item_id,
              e.source AS source_key,
              '记忆' AS source_label,
              e.event_type AS kind,
              COALESCE(NULLIF(e.title, ''), e.event_type, '事件') AS title,
              e.source AS subtitle,
              e.body AS summary,
              CASE WHEN e.curated_at IS NULL THEN 'pending' ELSE 'curated' END AS status,
              e.reference_count::float AS score,
              e.occurred_at,
              e.recorded_at AS updated_at,
              jsonb_build_array(e.source, e.event_type, CASE WHEN e.curated_at IS NULL THEN 'pending' ELSE 'curated' END, CONCAT('refs ', e.reference_count::text)) AS chips,
              jsonb_build_object(
                'id', e.id,
                'source', e.source,
                'event_type', e.event_type,
                'title', e.title,
                'body', e.body,
                'structured', e.structured,
                'source_ref', e.source_ref,
                'curated_at', e.curated_at,
                'occurred_at', e.occurred_at,
                'end_at', e.end_at,
                'recorded_at', e.recorded_at,
                'supersedes_id', e.supersedes_id,
                'superseded_by_id', e.superseded_by_id,
                'dedupe_key', e.dedupe_key,
                'reference_count', e.reference_count,
                'last_referenced_at', e.last_referenced_at,
                'embedding_model', e.embedding_model,
                'embedded_at', e.embedded_at
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_events e
            WHERE e.user_id = %s
              AND e.superseded_by_id IS NULL
              AND (%s::timestamptz IS NULL OR e.occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR e.occurred_at <= %s)
              AND (
                %s::text IS NULL
                OR COALESCE(e.title, '') ILIKE %s
                OR COALESCE(e.body, '') ILIKE %s
                OR e.event_type ILIKE %s
              )
            ORDER BY e.occurred_at DESC
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
        # pai_personal_signals retired into pai_events. Device observations now
        # land as events with source='device', so this section is the device
        # slice of the L1 stream (the memory section above is the whole stream —
        # device events appear in both; this one keeps the historical "device /
        # short-term observation" lens). Live rows only (superseded_by_id IS NULL).
        return await self._fetch_rows(
            "signals",
            """
            SELECT
              'signals' AS category,
              e.id AS item_id,
              e.source AS source_key,
              '个人信号' AS source_label,
              e.event_type AS kind,
              COALESCE(NULLIF(e.title, ''), e.event_type, '设备信号') AS title,
              e.source AS subtitle,
              e.body AS summary,
              CASE WHEN e.curated_at IS NULL THEN 'pending' ELSE 'curated' END AS status,
              e.reference_count::float AS score,
              e.occurred_at,
              e.recorded_at AS updated_at,
              jsonb_build_array(e.source, e.event_type, CASE WHEN e.curated_at IS NULL THEN 'pending' ELSE 'curated' END, CONCAT('refs ', e.reference_count::text)) AS chips,
              jsonb_build_object(
                'id', e.id,
                'source', e.source,
                'event_type', e.event_type,
                'title', e.title,
                'body', e.body,
                'structured', e.structured,
                'source_ref', e.source_ref,
                'curated_at', e.curated_at,
                'occurred_at', e.occurred_at,
                'end_at', e.end_at,
                'recorded_at', e.recorded_at,
                'dedupe_key', e.dedupe_key,
                'reference_count', e.reference_count,
                'last_referenced_at', e.last_referenced_at,
                'embedding_model', e.embedding_model,
                'embedded_at', e.embedded_at
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_events e
            WHERE e.user_id = %s
              AND e.source = 'device'
              AND e.superseded_by_id IS NULL
              AND (%s::timestamptz IS NULL OR e.occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR e.occurred_at <= %s)
              AND (
                %s::text IS NULL
                OR COALESCE(e.title, '') ILIKE %s
                OR COALESCE(e.body, '') ILIKE %s
                OR e.event_type ILIKE %s
              )
            ORDER BY e.occurred_at DESC
            LIMIT %s
            OFFSET %s
            """,
            self._params(kwargs),
        )

    async def _fetch_world(self, **kwargs: Any) -> dict[str, Any]:
        # World news is an L1 event now (event_type='world_news', source='world';
        # W6: pai_world_signal_user_view is dropped). Per-user salience lives in
        # the event's structured; recency is occurred_at.
        return await self._fetch_rows(
            "world",
            """
            SELECT
              'world' AS category,
              e.id AS item_id,
              COALESCE(e.structured->>'provider', e.source) AS source_key,
              '世界信号' AS source_label,
              e.event_type AS kind,
              COALESCE(NULLIF(e.title, ''), '世界信号') AS title,
              e.structured->>'url' AS subtitle,
              e.body AS summary,
              CASE WHEN e.curated_at IS NULL THEN 'pending' ELSE 'curated' END AS status,
              (e.structured->>'salience')::float AS score,
              e.occurred_at,
              e.recorded_at AS updated_at,
              jsonb_build_array(e.structured->>'provider', e.structured->>'importance', CASE WHEN e.curated_at IS NULL THEN 'pending' ELSE 'curated' END) AS chips,
              jsonb_build_object(
                'id', e.id,
                'source', e.source,
                'event_type', e.event_type,
                'title', e.title,
                'body', e.body,
                'structured', e.structured,
                'source_ref', e.source_ref,
                'curated_at', e.curated_at,
                'occurred_at', e.occurred_at,
                'recorded_at', e.recorded_at,
                'dedupe_key', e.dedupe_key,
                'reference_count', e.reference_count,
                'last_referenced_at', e.last_referenced_at,
                'embedding_model', e.embedding_model,
                'embedded_at', e.embedded_at
              ) AS payload,
              COUNT(*) OVER() AS total
            FROM pai_events e
            WHERE e.user_id = %s
              AND e.event_type = 'world_news'
              AND e.superseded_by_id IS NULL
              AND (%s::timestamptz IS NULL OR e.occurred_at >= %s)
              AND (%s::timestamptz IS NULL OR e.occurred_at <= %s)
              AND (
                %s::text IS NULL
                OR COALESCE(e.title, '') ILIKE %s
                OR COALESCE(e.body, '') ILIKE %s
                OR COALESCE(e.structured->>'topics', '') ILIKE %s
              )
            ORDER BY e.occurred_at DESC
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
        # One UNION-ALL branch per registered raw source — each routed to its L0
        # domain table (pai_raw_apps / pai_raw_device) by snapshot_fragment; the
        # registry is the single source of truth for that routing.
        selects = []
        params: list[Any] = []
        for source in raw_sources.ALL_SOURCES:
            fragment, frag_params = raw_sources.snapshot_fragment(
                source, self._user_id, since, until
            )
            selects.append(fragment)
            params.extend(frag_params)

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
