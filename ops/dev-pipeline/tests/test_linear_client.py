"""LinearClient 测试：monkeypatch `_execute`，验证查询/变量构造 + 结果解析，不打真 API。"""

from __future__ import annotations

from typing import Any

import pytest

from dev_pipeline.linear.client import LinearClient


class RecordingClient(LinearClient):
    """记录最后一次 (query, variables)，按预置返回值应答。"""

    def __init__(self, response: dict[str, Any]) -> None:
        super().__init__(api_key="x")
        self._response = response
        self.last_query: str | None = None
        self.last_vars: dict[str, Any] | None = None

    async def _execute(
        self, query: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.last_query = query
        self.last_vars = variables
        return self._response


@pytest.mark.asyncio
async def test_create_comment() -> None:
    c = RecordingClient({"commentCreate": {"success": True, "comment": {"id": "cmt_9"}}})
    cid = await c.create_comment("issue_1", "hello")
    assert cid == "cmt_9"
    assert c.last_vars == {"input": {"issueId": "issue_1", "body": "hello"}}


@pytest.mark.asyncio
async def test_create_agent_activity() -> None:
    c = RecordingClient(
        {"agentActivityCreate": {"success": True, "agentActivity": {"id": "act_1"}}}
    )
    aid = await c.create_agent_activity("agses_1", "thought", "reading the issue")
    assert aid == "act_1"
    assert c.last_vars is not None
    assert c.last_vars["input"]["agentSessionId"] == "agses_1"
    assert c.last_vars["input"]["content"] == {"type": "thought", "body": "reading the issue"}


@pytest.mark.asyncio
async def test_assign_issue() -> None:
    c = RecordingClient({"issueUpdate": {"success": True}})
    assert await c.assign_issue("issue_1", "user_codex") is True
    assert c.last_vars == {"id": "issue_1", "input": {"assigneeId": "user_codex"}}


@pytest.mark.asyncio
async def test_update_oauth_app_only_sends_set_fields() -> None:
    c = RecordingClient({"oauthApplicationUpdate": {"success": True}})
    await c.update_oauth_app(
        "app_1",
        redirect_uris=["https://x/cb"],
        webhook_url="https://x/webhook/linear",
        webhook_resource_types=["AgentSession", "Issue", "Comment"],
        webhook_enabled=True,
    )
    assert c.last_vars is not None
    inp = c.last_vars["input"]
    assert inp["redirectUris"] == ["https://x/cb"]
    assert inp["webhookUrl"] == "https://x/webhook/linear"
    assert inp["webhookEnabled"] is True
    # 未传的字段不出现在 input 里
    c2 = RecordingClient({"oauthApplicationUpdate": {"success": True}})
    await c2.update_oauth_app("app_1", webhook_url="https://x/webhook/linear")
    assert c2.last_vars is not None
    assert set(c2.last_vars["input"].keys()) == {"webhookUrl"}
