"""Remote MCP custom connectors.

Custom connectors are intentionally narrow for now: validate a Remote MCP
HTTP endpoint, pull server/tool/resource metadata, and store that data in
the generic pai_raw_events table so existing agent context reads it.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from psycopg import AsyncConnection
from psycopg.rows import DictRow
from psycopg_pool import AsyncConnectionPool

from ..auth.user_service import User
from ..db.repositories.scheduled_tasks import requeue_once
from ..db.rls import user_scoped_tx
from .generic_ingest import upsert_generic
from .ingest_runner import Recipe

CUSTOM_MCP_ENTITY = "items"
DEFAULT_PULL_LIMIT = 100
MAX_RESOURCE_READS = 10
MAX_TOOL_CALLS = 5
PULL_DEADLINE_SECONDS = 25.0
_CLIENT_INFO = {"name": "pin-ai", "version": "0.1"}
_MCP_PROTOCOL_VERSION = "2025-03-26"


class CustomMcpError(Exception):
    """User-facing custom MCP setup failure."""

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class CustomMcpConnector:
    id: str
    slug: str
    name: str
    url: str
    status: str
    last_fetched_count: int
    last_raw_inserted_count: int
    last_evolve_task_id: str | None
    last_error: str | None
    raw_sources: list[dict[str, str]]


@dataclass(frozen=True)
class CreateCustomMcpResult:
    connector: CustomMcpConnector
    fetched: int
    raw_inserted: int
    evolve_task_id: str | None


def slug_for_url(url: str) -> str:
    return f"mcp_{hashlib.sha256(url.encode()).hexdigest()[:12]}"


def _connector_id_for_slug(slug: str) -> str:
    return f"custom_{slug}"


def _validate_url(url: str) -> str:
    parsed = urlparse(url.strip())
    if parsed.scheme != "https" or not parsed.netloc:
        raise CustomMcpError("Remote MCP server URL must use https")
    if parsed.username or parsed.password:
        raise CustomMcpError("Remote MCP server URL must not include credentials")
    return parsed.geturl()


def _as_text(value: Any, *, max_len: int = 2000) -> str | None:
    if not isinstance(value, str):
        return None
    value = re.sub(r"\s+", " ", value).strip()
    return value[:max_len] if value else None


def _parse_rpc_payload(response: httpx.Response) -> dict[str, Any]:
    content_type = response.headers.get("content-type", "")
    text = response.text.strip()
    if "text/event-stream" in content_type:
        for line in text.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            data = line.removeprefix("data:").strip()
            if not data or data == "[DONE]":
                continue
            payload = json.loads(data)
            if isinstance(payload, dict):
                return payload
        raise CustomMcpError("Remote MCP server returned no JSON-RPC payload", status_code=502)
    payload = response.json()
    if not isinstance(payload, dict):
        raise CustomMcpError("Remote MCP server returned malformed JSON", status_code=502)
    return payload


async def _jsonrpc(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": method, "method": method}
    if params is not None:
        body["params"] = params
    try:
        response = await client.post(
            url,
            json=body,
            headers={
                "accept": "application/json, text/event-stream",
                "content-type": "application/json",
            },
        )
    except httpx.HTTPError as e:
        raise CustomMcpError(f"Remote MCP server is unreachable: {e}", status_code=502) from e
    if response.status_code >= 400:
        raise CustomMcpError(
            f"Remote MCP server returned HTTP {response.status_code}",
            status_code=400 if response.status_code < 500 else 502,
        )
    try:
        payload = _parse_rpc_payload(response)
    except (json.JSONDecodeError, ValueError) as e:
        raise CustomMcpError("Remote MCP server returned invalid JSON", status_code=502) from e
    if isinstance(payload.get("error"), dict):
        error = payload["error"]
        message = _as_text(error.get("message"), max_len=300) or "Remote MCP JSON-RPC error"
        raise CustomMcpError(message, status_code=502)
    result = payload.get("result")
    return result if isinstance(result, dict) else {}


async def _optional_jsonrpc(
    client: httpx.AsyncClient,
    url: str,
    method: str,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        return await _jsonrpc(client, url, method, params)
    except CustomMcpError:
        return {}


def _metadata_item(
    *,
    item_id: str,
    kind: str,
    title: str,
    snippet: str | None,
    payload: dict[str, Any],
    timestamp: str,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "kind": kind,
        "title": title,
        "snippet": snippet,
        "timestamp": timestamp,
        "payload": payload,
    }


def _tool_is_read_only(tool: dict[str, Any]) -> bool:
    annotations = tool.get("annotations")
    return isinstance(annotations, dict) and annotations.get("readOnlyHint") is True


def _pick_enum_value(values: list[Any]) -> Any | None:
    preferred = ("top", "new", "latest", "news", "front_page")
    string_values = [v for v in values if isinstance(v, str)]
    for value in preferred:
        if value in string_values:
            return value
    return values[0] if values else None


def _sample_args_from_schema(tool: dict[str, Any]) -> dict[str, Any] | None:
    schema = tool.get("inputSchema")
    if not isinstance(schema, dict):
        return {}
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return {}
    required_raw = schema.get("required")
    required = (
        [v for v in required_raw if isinstance(v, str)] if isinstance(required_raw, list) else []
    )
    args: dict[str, Any] = {}
    for field in required:
        prop = properties.get(field)
        if not isinstance(prop, dict):
            return None
        if field in {"count", "limit", "pageSize", "maxResults"}:
            args[field] = _bounded_limit(prop)
            continue
        if "default" in prop:
            args[field] = prop["default"]
            continue
        enum = prop.get("enum")
        if isinstance(enum, list):
            value = _pick_enum_value(enum)
            if value is None:
                return None
            args[field] = value
            continue
        return None
    for field in ("count", "limit", "pageSize", "maxResults"):
        prop = properties.get(field)
        if not isinstance(prop, dict) or field in args:
            continue
        args[field] = _bounded_limit(prop)
    for field in ("offset", "page"):
        prop = properties.get(field)
        if isinstance(prop, dict) and field not in args:
            args[field] = prop.get("default", 0)
    return args


def _bounded_limit(prop: dict[str, Any]) -> int:
    maximum = prop.get("maximum")
    upper = int(maximum) if isinstance(maximum, (int, float)) else DEFAULT_PULL_LIMIT
    minimum = prop.get("minimum")
    lower = int(minimum) if isinstance(minimum, (int, float)) else 1
    return max(lower, min(DEFAULT_PULL_LIMIT, upper))


def _text_content_rows(
    tool_name: str,
    args: dict[str, Any],
    content_item: dict[str, Any],
    idx: int,
    timestamp: str,
) -> list[dict[str, Any]]:
    raw_text = content_item.get("text")
    text = _as_text(raw_text, max_len=20_000)
    if not text:
        return []
    if isinstance(raw_text, str):
        blocks = [
            block.strip()
            for block in re.split(r"(?m)(?=^\s*\[\d+\]\s+)", raw_text)
            if block.strip()
        ]
        story_blocks = [block for block in blocks if re.match(r"^\s*\[\d+\]\s+", block)]
        rows: list[dict[str, Any]] = []
        for block_idx, block in enumerate(story_blocks[:DEFAULT_PULL_LIMIT]):
            normalized = _as_text(block, max_len=2000)
            first_line = next((line.strip() for line in block.splitlines() if line.strip()), "")
            title = (
                re.sub(r"^\[\d+\]\s*", "", first_line).strip()
                or f"{tool_name} item {block_idx + 1}"
            )
            id_match = re.search(r"(?im)\b(?:id|story_id)\s*[:=]\s*([A-Za-z0-9_.:-]+)", block)
            external_id = id_match.group(1) if id_match else str(block_idx)
            rows.append(
                _metadata_item(
                    item_id=f"tool:{tool_name}:content:{idx}:{external_id}",
                    kind="tool_result",
                    title=title[:512],
                    snippet=normalized,
                    payload={
                        "tool": tool_name,
                        "arguments": args,
                        "resultKey": "content",
                        "content": content_item,
                        "textItem": block,
                    },
                    timestamp=timestamp,
                )
            )
        if rows:
            return rows
        raw_lines = raw_text.splitlines()
        title = next((line.lstrip("# ").strip() for line in raw_lines if line.strip()), "")
    else:
        title = ""
    return [
        _metadata_item(
            item_id=f"tool:{tool_name}:content:{idx}",
            kind="tool_result",
            title=(title or f"{tool_name} result")[:512],
            snippet=text[:2000],
            payload={
                "tool": tool_name,
                "arguments": args,
                "resultKey": "content",
                "content": content_item,
            },
            timestamp=timestamp,
        )
    ]


def _tool_result_rows(
    tool_name: str,
    args: dict[str, Any],
    result: dict[str, Any],
    timestamp: str,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key in ("stories", "items", "results", "hits", "data"):
        value = result.get(key)
        if not isinstance(value, list):
            continue
        for idx, item in enumerate(value[:DEFAULT_PULL_LIMIT]):
            if not isinstance(item, dict):
                continue
            external_id = _as_text(
                item.get("id") or item.get("objectID") or item.get("url"),
                max_len=512,
            )
            title = (
                _as_text(item.get("title"), max_len=512)
                or _as_text(item.get("storyTitle"), max_len=512)
                or f"{tool_name} item {idx + 1}"
            )
            snippet = _as_text(
                item.get("text")
                or item.get("url")
                or item.get("domain")
                or item.get("description"),
            )
            item_time = item.get("time") or item.get("createdAt") or timestamp
            rows.append(
                _metadata_item(
                    item_id=f"tool:{tool_name}:{key}:{external_id or idx}",
                    kind="tool_result",
                    title=title,
                    snippet=snippet,
                    payload={
                        "tool": tool_name,
                        "arguments": args,
                        "resultKey": key,
                        "item": item,
                    },
                    timestamp=str(item_time),
                )
            )
        if rows:
            return rows
    content = result.get("content")
    if isinstance(content, list):
        for idx, item in enumerate(content):
            if not isinstance(item, dict) or item.get("type") != "text":
                continue
            rows.extend(_text_content_rows(tool_name, args, item, idx, timestamp))
    return rows


def _resource_read_snippet(read_payload: dict[str, Any]) -> str | None:
    contents = read_payload.get("contents")
    if not isinstance(contents, list):
        return None
    text_parts: list[str] = []
    for item in contents:
        if not isinstance(item, dict):
            continue
        text = _as_text(item.get("text"), max_len=2000)
        if text:
            text_parts.append(text)
    return _as_text(" ".join(text_parts), max_len=2000)


async def pull_mcp_metadata(url: str, name: str) -> list[dict[str, Any]]:
    timestamp = datetime.now(UTC).isoformat()
    deadline = time.monotonic() + PULL_DEADLINE_SECONDS
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        initialize = await _jsonrpc(
            client,
            url,
            "initialize",
            {
                "protocolVersion": _MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": _CLIENT_INFO,
            },
        )
        tools_payload = await _optional_jsonrpc(client, url, "tools/list")
        resources_payload = await _optional_jsonrpc(client, url, "resources/list")
        resources_raw = resources_payload.get("resources")
        resources: list[Any] = resources_raw if isinstance(resources_raw, list) else []
        resource_reads: dict[str, dict[str, Any]] = {}
        for resource in resources[:MAX_RESOURCE_READS]:
            if time.monotonic() >= deadline:
                break
            if not isinstance(resource, dict):
                continue
            uri = _as_text(resource.get("uri"), max_len=512)
            if not uri:
                continue
            resource_reads[uri] = await _optional_jsonrpc(
                client,
                url,
                "resources/read",
                {"uri": uri},
            )
        tools_raw = tools_payload.get("tools")
        tools: list[Any] = tools_raw if isinstance(tools_raw, list) else []
        tool_results: list[dict[str, Any]] = []
        tool_calls = 0
        for tool in tools:
            if tool_calls >= MAX_TOOL_CALLS or time.monotonic() >= deadline:
                break
            if not isinstance(tool, dict):
                continue
            tool_name = _as_text(tool.get("name"), max_len=160)
            if not tool_name or not _tool_is_read_only(tool):
                continue
            args = _sample_args_from_schema(tool)
            if args is None:
                continue
            result = await _optional_jsonrpc(
                client,
                url,
                "tools/call",
                {"name": tool_name, "arguments": args},
            )
            tool_calls += 1
            tool_results.extend(_tool_result_rows(tool_name, args, result, timestamp))
            if len(tool_results) >= DEFAULT_PULL_LIMIT:
                tool_results = tool_results[:DEFAULT_PULL_LIMIT]
                break

    server_info_raw = initialize.get("serverInfo")
    server_info: dict[str, Any] = server_info_raw if isinstance(server_info_raw, dict) else {}
    server_name = _as_text(server_info.get("name"), max_len=160) or name
    out = [
        _metadata_item(
            item_id="server",
            kind="server",
            title=f"MCP server: {server_name}",
            snippet=_as_text(server_info.get("version"), max_len=300),
            payload=initialize,
            timestamp=timestamp,
        )
    ]
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        tool_name = _as_text(tool.get("name"), max_len=160)
        if not tool_name:
            continue
        out.append(
            _metadata_item(
                item_id=f"tool:{tool_name}",
                kind="tool",
                title=f"Tool: {tool_name}",
                snippet=_as_text(tool.get("description")),
                payload=tool,
                timestamp=timestamp,
            )
        )
    out.extend(tool_results)
    for resource in resources:
        if not isinstance(resource, dict):
            continue
        uri = _as_text(resource.get("uri"), max_len=512)
        if not uri:
            continue
        read_payload = resource_reads.get(uri) or {}
        title = _as_text(resource.get("name"), max_len=200) or uri
        out.append(
            _metadata_item(
                item_id=f"resource:{uri}",
                kind="resource",
                title=title,
                snippet=(
                    _resource_read_snippet(read_payload)
                    or _as_text(resource.get("description") or resource.get("mimeType"))
                ),
                payload={
                    **resource,
                    **({"read": read_payload} if read_payload else {}),
                },
                timestamp=timestamp,
            )
        )
    return out


def _row_to_connector(row: dict[str, Any]) -> CustomMcpConnector:
    slug = str(row["slug"])
    return CustomMcpConnector(
        id=str(row["id"]),
        slug=slug,
        name=str(row["name"]),
        url=str(row["server_url"]),
        status=str(row["status"]),
        last_fetched_count=int(row.get("last_fetched_count") or 0),
        last_raw_inserted_count=int(row.get("last_raw_inserted_count") or 0),
        last_evolve_task_id=row.get("last_evolve_task_id"),
        last_error=row.get("last_error"),
        raw_sources=[{"toolkit": slug, "entity": CUSTOM_MCP_ENTITY}],
    )


def connector_to_connection_payload(connector: CustomMcpConnector) -> dict[str, Any]:
    return {
        "toolkit": connector.slug,
        "status": connector.status,
        "connectedAccountId": connector.id,
        "label": connector.name,
        "userInfo": {
            "type": "custom_mcp",
            "url": connector.url,
            "rawSources": connector.raw_sources,
            "lastFetchedCount": connector.last_fetched_count,
            "lastRawInsertedCount": connector.last_raw_inserted_count,
            "lastEvolveTaskId": connector.last_evolve_task_id,
            "lastError": connector.last_error,
        },
    }


async def list_custom_mcp_connectors(
    pool: AsyncConnectionPool,
    user_id: int,
) -> list[CustomMcpConnector]:
    async with user_scoped_tx(pool, user_id) as conn:
        cur = await conn.execute(
            """
            SELECT id, slug, name, server_url, status,
                   last_fetched_count, last_raw_inserted_count,
                   last_evolve_task_id, last_error
            FROM pai_custom_mcp_connectors
            WHERE user_id = %s AND status = 'ACTIVE'
            ORDER BY updated_at DESC
            """,
            (user_id,),
        )
        rows = await cur.fetchall()
    return [_row_to_connector(r) for r in rows]


async def is_custom_mcp_active(
    pool: AsyncConnectionPool,
    user_id: int,
    toolkit: str,
) -> bool:
    async with user_scoped_tx(pool, user_id) as conn:
        cur = await conn.execute(
            """
            SELECT 1
            FROM pai_custom_mcp_connectors
            WHERE user_id = %s AND slug = %s AND status = 'ACTIVE'
            LIMIT 1
            """,
            (user_id, toolkit),
        )
        return await cur.fetchone() is not None


async def create_custom_mcp_connector(
    pool: AsyncConnectionPool,
    user: User,
    *,
    name: str,
    url: str,
) -> CreateCustomMcpResult:
    return await _upsert_custom_mcp_connector(
        pool,
        user,
        connector_id=None,
        name=name,
        url=url,
    )


async def update_custom_mcp_connector(
    pool: AsyncConnectionPool,
    user: User,
    connector_id: str,
    *,
    name: str,
    url: str,
) -> CreateCustomMcpResult:
    connector_id = connector_id.strip()
    if not connector_id:
        raise CustomMcpError("Missing connector id")
    return await _upsert_custom_mcp_connector(
        pool,
        user,
        connector_id=connector_id,
        name=name,
        url=url,
    )


async def _upsert_custom_mcp_connector(
    pool: AsyncConnectionPool,
    user: User,
    *,
    connector_id: str | None,
    name: str,
    url: str,
) -> CreateCustomMcpResult:
    name = name.strip()
    if not name:
        raise CustomMcpError("Missing connector name")
    server_url = _validate_url(url)
    slug = slug_for_url(server_url)
    saved_connector_id = connector_id or _connector_id_for_slug(slug)
    items = await pull_mcp_metadata(server_url, name)
    fetched = _fetched_item_count(items)
    recipe = Recipe(
        toolkit=slug,
        slug="CUSTOM_MCP_METADATA",
        entity_type=CUSTOM_MCP_ENTITY,
        id_field="id",
        timestamp_path=["timestamp"],
        title_path=["title"],
        snippet_path=["snippet"],
        description="Remote MCP custom connector metadata",
    )
    async with user_scoped_tx(pool, user.id) as conn:
        existing_id = await _resolve_existing_connector_id(
            conn,
            user_id=user.id,
            connector_id=saved_connector_id,
            slug=slug,
            allow_slug_match=connector_id is None,
        )
        saved_connector_id = existing_id or saved_connector_id
        raw_inserted = await upsert_generic(
            conn,
            user.id,
            slug,
            CUSTOM_MCP_ENTITY,
            recipe,
            items,
        )
        evolve_task_id = (
            await _enqueue_custom_mcp_evolve(
                conn,
                user_id=user.id,
                slug=slug,
                connector_id=saved_connector_id,
            )
            if fetched > 0
            else None
        )
        cur = await conn.execute(
            """
            INSERT INTO pai_custom_mcp_connectors (
              user_id, id, slug, name, server_url,
              status, last_fetched_count,
              last_raw_inserted_count, last_evolve_task_id, last_error
            ) VALUES (
              %s, %s, %s, %s, %s,
              'ACTIVE', %s, %s, %s, NULL
            )
            ON CONFLICT (user_id, id) DO UPDATE SET
              slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              server_url = EXCLUDED.server_url,
              status = 'ACTIVE',
              last_fetched_count = EXCLUDED.last_fetched_count,
              last_raw_inserted_count = EXCLUDED.last_raw_inserted_count,
              last_evolve_task_id = EXCLUDED.last_evolve_task_id,
              last_error = NULL,
              updated_at = NOW()
            RETURNING id, slug, name, server_url, status,
                      last_fetched_count, last_raw_inserted_count,
                      last_evolve_task_id, last_error
            """,
            (
                user.id,
                saved_connector_id,
                slug,
                name,
                server_url,
                fetched,
                raw_inserted,
                evolve_task_id,
            ),
        )
        row = await cur.fetchone()
    if row is None:
        raise CustomMcpError("Failed to save custom connector", status_code=500)
    return CreateCustomMcpResult(
        connector=_row_to_connector(row),
        fetched=fetched,
        raw_inserted=raw_inserted,
        evolve_task_id=evolve_task_id,
    )


async def delete_custom_mcp_connector(
    pool: AsyncConnectionPool,
    user_id: int,
    connector_id: str,
) -> bool:
    connector_id = connector_id.strip()
    if not connector_id:
        raise CustomMcpError("Missing connector id")
    async with user_scoped_tx(pool, user_id) as conn:
        cur = await conn.execute(
            """
            UPDATE pai_custom_mcp_connectors
            SET status = 'DELETED', updated_at = NOW()
            WHERE user_id = %s AND id = %s AND status = 'ACTIVE'
            """,
            (user_id, connector_id),
        )
        return (cur.rowcount or 0) > 0


async def _resolve_existing_connector_id(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    connector_id: str,
    slug: str,
    allow_slug_match: bool,
) -> str | None:
    if not allow_slug_match:
        cur = await conn.execute(
            """
            SELECT id
            FROM pai_custom_mcp_connectors
            WHERE user_id = %s AND id = %s
            LIMIT 1
            """,
            (user_id, connector_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise CustomMcpError("Custom connector not found", status_code=404)
        return str(row["id"])
    cur = await conn.execute(
        """
        SELECT id
        FROM pai_custom_mcp_connectors
        WHERE user_id = %s AND (id = %s OR slug = %s)
        ORDER BY CASE WHEN id = %s THEN 0 ELSE 1 END
        LIMIT 1
        """,
        (user_id, connector_id, slug, connector_id),
    )
    row = await cur.fetchone()
    return str(row["id"]) if row else None


async def _enqueue_custom_mcp_evolve(
    conn: AsyncConnection[DictRow],
    *,
    user_id: int,
    slug: str,
    connector_id: str,
) -> str:
    task_id = f"evolve.{slug}.{connector_id}"
    await requeue_once(
        conn,
        user_id=user_id,
        task_id=task_id,
        kind="connector.evolve",
        payload={
            "connector": slug,
            "connectedAccountId": connector_id,
            "rawSources": [{"toolkit": slug, "entity": CUSTOM_MCP_ENTITY}],
        },
        max_attempts=2,
    )
    return task_id


def _fetched_item_count(items: list[dict[str, Any]]) -> int:
    data_count = sum(1 for item in items if item.get("kind") == "tool_result")
    return data_count or len(items)
