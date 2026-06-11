from __future__ import annotations

import pytest

from pinai_agents.web.auth.user_service import User
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.services import custom_mcp


@pytest.mark.asyncio
async def test_create_custom_mcp_lands_metadata_in_generic_raw(
    pool,
    user_ids,
    monkeypatch,
):
    user_id, _ = user_ids
    user = User(
        id=user_id,
        supabase_user_id="11111111-1111-1111-1111-111111111111",
        email="user@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )

    async def fake_pull(url: str, name: str) -> list[dict]:
        assert url == "https://news.example.com/mcp"
        assert name == "News MCP"
        return [
            {
                "id": "server",
                "kind": "server",
                "title": "MCP server: News MCP",
                "snippet": "test",
                "timestamp": "2026-06-11T00:00:00+00:00",
                "payload": {"serverInfo": {"name": "News MCP"}},
            },
            {
                "id": "tool:search_news",
                "kind": "tool",
                "title": "Tool: search_news",
                "snippet": "Search news articles",
                "timestamp": "2026-06-11T00:00:00+00:00",
                "payload": {"name": "search_news"},
            },
        ]

    monkeypatch.setattr(custom_mcp, "pull_mcp_metadata", fake_pull)

    result = await custom_mcp.create_custom_mcp_connector(
        pool,
        user,
        name="News MCP",
        url="https://news.example.com/mcp",
    )

    assert result.fetched == 2
    assert result.raw_inserted == 2
    assert result.evolve_task_id == f"evolve.{result.connector.slug}.{result.connector.id}"
    assert result.connector.slug.startswith("mcp_")
    assert result.connector.last_fetched_count == 2
    assert result.connector.last_raw_inserted_count == 2
    assert result.connector.raw_sources == [{"toolkit": result.connector.slug, "entity": "items"}]
    assert await custom_mcp.is_custom_mcp_active(pool, user_id, result.connector.slug)

    connectors = await custom_mcp.list_custom_mcp_connectors(pool, user_id)
    assert [c.slug for c in connectors] == [result.connector.slug]

    async with user_scoped_tx(pool, user_id) as conn:
        cur = await conn.execute(
            """
            SELECT title, snippet
            FROM pai_raw_events
            WHERE user_id = %s AND toolkit = %s AND entity_type = 'items'
            ORDER BY external_id
            """,
            (user_id, result.connector.slug),
        )
        rows = await cur.fetchall()
        cur = await conn.execute(
            """
            SELECT payload
            FROM pai_scheduled_tasks
            WHERE user_id = %s AND id = %s
            """,
            (user_id, result.evolve_task_id),
        )
        task_row = await cur.fetchone()
    assert rows == [
        {"title": "MCP server: News MCP", "snippet": "test"},
        {"title": "Tool: search_news", "snippet": "Search news articles"},
    ]
    assert task_row is not None
    assert task_row["payload"]["rawSources"] == [
        {"toolkit": result.connector.slug, "entity": "items"}
    ]


def test_connector_payload_exposes_agent_raw_source():
    connector = custom_mcp.CustomMcpConnector(
        id="custom_mcp_abc",
        slug="mcp_abc",
        name="News MCP",
        url="https://news.example.com/mcp",
        status="ACTIVE",
        last_fetched_count=100,
        last_raw_inserted_count=102,
        last_evolve_task_id="evolve.mcp_abc.custom_mcp_abc",
        last_error=None,
        raw_sources=[{"toolkit": "mcp_abc", "entity": "items"}],
    )

    payload = custom_mcp.connector_to_connection_payload(connector)

    assert payload["toolkit"] == "mcp_abc"
    assert payload["userInfo"]["type"] == "custom_mcp"
    assert payload["userInfo"]["rawSources"] == [{"toolkit": "mcp_abc", "entity": "items"}]
    assert payload["userInfo"]["lastFetchedCount"] == 100
    assert payload["userInfo"]["lastRawInsertedCount"] == 102


def test_tool_result_rows_preserve_mcp_content_text():
    rows = custom_mcp._tool_result_rows(
        "hn_get_stories",
        {"feed": "top", "count": 100, "offset": 0},
        {
            "content": [
                {
                    "type": "text",
                    "text": "## top stories\n\n[1] Example story\nid:1 | story",
                }
            ]
        },
        "2026-06-11T00:00:00+00:00",
    )

    assert rows == [
        {
            "id": "tool:hn_get_stories:content:0:1",
            "kind": "tool_result",
            "title": "Example story",
            "snippet": "[1] Example story id:1 | story",
            "timestamp": "2026-06-11T00:00:00+00:00",
            "payload": {
                "tool": "hn_get_stories",
                "arguments": {"feed": "top", "count": 100, "offset": 0},
                "resultKey": "content",
                "content": {
                    "type": "text",
                    "text": "## top stories\n\n[1] Example story\nid:1 | story",
                },
                "textItem": "[1] Example story\nid:1 | story",
            },
        }
    ]


@pytest.mark.asyncio
async def test_pull_mcp_metadata_caps_resource_reads_and_tool_calls(monkeypatch):
    resource_reads = 0
    tool_calls = 0

    async def fake_jsonrpc(_client, _url, method: str, params=None):
        assert method == "initialize"
        return {"serverInfo": {"name": "News MCP", "version": "1"}}

    async def fake_optional_jsonrpc(_client, _url, method: str, params=None):
        nonlocal resource_reads, tool_calls
        if method == "resources/list":
            return {
                "resources": [
                    {"uri": f"news://resource/{i}", "name": f"Resource {i}"}
                    for i in range(custom_mcp.MAX_RESOURCE_READS + 5)
                ]
            }
        if method == "resources/read":
            resource_reads += 1
            return {"contents": [{"text": "resource text"}]}
        if method == "tools/list":
            return {
                "tools": [
                    {
                        "name": f"read_news_{i}",
                        "description": "Read news",
                        "annotations": {"readOnlyHint": True},
                        "inputSchema": {"type": "object", "properties": {}},
                    }
                    for i in range(custom_mcp.MAX_TOOL_CALLS + 5)
                ]
            }
        if method == "tools/call":
            tool_calls += 1
            return {"items": [{"id": str(tool_calls), "title": "Story"}]}
        return {}

    monkeypatch.setattr(custom_mcp, "_jsonrpc", fake_jsonrpc)
    monkeypatch.setattr(custom_mcp, "_optional_jsonrpc", fake_optional_jsonrpc)

    rows = await custom_mcp.pull_mcp_metadata("https://news.example.com/mcp", "News MCP")

    assert resource_reads == custom_mcp.MAX_RESOURCE_READS
    assert tool_calls == custom_mcp.MAX_TOOL_CALLS
    assert any(row["kind"] == "resource" for row in rows)
    assert any(row["kind"] == "tool_result" for row in rows)
