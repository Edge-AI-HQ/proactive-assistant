from __future__ import annotations

import pytest
from fastapi import HTTPException
from pinai_api.domains.connector.apps import composio_agent as agent_composio
from pinai_api.domains.connector.apps import composio_service as cs
from pinai_api.domains.connector.apps import custom_mcp
from pinai_api.platform.auth.user_service import User
from pinai_contracts.composio_policy import is_side_effecting


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


# ── Sandbox side-effect gate (P0-3) ────────────────────────────────────


@pytest.mark.parametrize(
    "slug",
    [
        "GMAIL_SEND_EMAIL",
        "GMAIL_CREATE_EMAIL_DRAFT",
        "GITHUB_DELETE_REPO",
        "STRIPE_CREATE_PAYMENT_INTENT",
        "SLACK_SEND_MESSAGE",
        "WEIRD",  # no VERB segment → fail-closed
        "",  # degenerate → fail-closed
    ],
)
def test_policy_side_effecting(slug):
    assert is_side_effecting(slug) is True


@pytest.mark.parametrize(
    "slug",
    [
        "GMAIL_GET_PROFILE",
        "GITHUB_LIST_ISSUES",
        "SLACK_SEARCH_MESSAGES",
        "DRIVE_DOWNLOAD_FILE",
        "gmail_get_profile",  # case-insensitive
    ],
)
def test_policy_read_only(slug):
    assert is_side_effecting(slug) is False


@pytest.mark.asyncio
async def test_sandbox_execute_blocks_side_effecting_slug():
    body = agent_composio._ExecuteBody(slug="GMAIL_SEND_EMAIL")
    with pytest.raises(HTTPException) as exc:
        await agent_composio.execute(body=body, user=_user(), pool=object())
    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "side_effect_blocked_in_sandbox"
    assert exc.value.detail["slug"] == "GMAIL_SEND_EMAIL"


@pytest.mark.asyncio
async def test_sandbox_execute_allows_read_only_slug(monkeypatch):
    async def fake_execute(_user, slug, _args, connected_account_id=None):
        return cs.ExecuteResult(slug=slug, successful=True, data={"ok": True})

    async def fake_record(*_a, **_k):
        return None

    monkeypatch.setattr(agent_composio.cs, "execute", fake_execute)
    monkeypatch.setattr(agent_composio, "_record_composio_tool_calls", fake_record)
    body = agent_composio._ExecuteBody(slug="GMAIL_GET_PROFILE")
    result = await agent_composio.execute(body=body, user=_user(), pool=object())
    assert result["successful"] is True


@pytest.mark.asyncio
async def test_sandbox_multi_execute_blocks_any_side_effecting_slug():
    body = agent_composio._MultiExecuteBody(
        calls=[
            cs.ExecuteCall(slug="GMAIL_GET_PROFILE"),
            cs.ExecuteCall(slug="GMAIL_SEND_EMAIL"),
        ]
    )
    with pytest.raises(HTTPException) as exc:
        await agent_composio.multi_execute(body=body, user=_user(), pool=object())
    assert exc.value.status_code == 403
    assert "GMAIL_SEND_EMAIL" in exc.value.detail["slugs"]
    assert "GMAIL_GET_PROFILE" not in exc.value.detail["slugs"]
