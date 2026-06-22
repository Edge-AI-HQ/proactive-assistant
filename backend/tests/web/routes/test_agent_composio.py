from __future__ import annotations

import pytest
from pinai_api.domains.connector.apps import composio_agent as agent_composio
from pinai_api.domains.connector.apps import composio_service as cs
from pinai_api.domains.connector.apps import custom_mcp
from pinai_api.platform.auth.user_service import User


def _user() -> User:
    return User(
        id=7,
        supabase_user_id="11111111-1111-1111-1111-111111111111",
        email="user@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


@pytest.mark.asyncio
async def test_agent_connections_include_custom_mcp_raw_sources(monkeypatch):
    async def fake_composio_connections(_user: User) -> list[cs.Connection]:
        return [
            cs.Connection(
                toolkit="gmail",
                status="ACTIVE",
                connected_account_id="gmail-account",
            )
        ]

    async def fake_custom_connectors(_pool, user_id: int) -> list[custom_mcp.CustomMcpConnector]:
        assert user_id == 7
        return [
            custom_mcp.CustomMcpConnector(
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
        ]

    monkeypatch.setattr(agent_composio.cs, "list_connections", fake_composio_connections)
    monkeypatch.setattr(
        agent_composio.custom_mcp,
        "list_custom_mcp_connectors",
        fake_custom_connectors,
    )

    payload = await agent_composio.list_connections(user=_user(), pool=object())

    assert payload["items"][0]["rawSources"] == [{"toolkit": "gmail", "entity": "messages"}]
    assert payload["items"][1]["toolkit"] == "mcp_abc"
    assert payload["items"][1]["rawSources"] == [{"toolkit": "mcp_abc", "entity": "items"}]
