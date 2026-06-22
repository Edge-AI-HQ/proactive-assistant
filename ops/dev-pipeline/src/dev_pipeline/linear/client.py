"""Linear GraphQL client。

单一网络 seam = `_execute`，测试 monkeypatch 它即可，不打真 API。
覆盖编排需要的写操作：评论回写 / agentActivity / assign / 以及 OAuth app 自助
配置（redirectUris + webhookUrl，省去手点 UI）。
docs: https://linear.app/developers/graphql
"""

from __future__ import annotations

from typing import Any

import httpx


class LinearError(RuntimeError):
    """GraphQL 返回 errors，或网络层失败。"""


def _parse_payload(payload: dict[str, Any] | None, status_code: int) -> dict[str, Any]:
    """统一处理响应：Linear 把 scope/权限错误用 HTTP 400 + errors body 返回，
    所以必须先看 body 里的 errors，再看 HTTP 状态——否则会把 GraphQL 错误信息吞掉。"""
    if payload is None:
        raise LinearError(f"non-JSON response (HTTP {status_code})")
    if payload.get("errors"):
        raise LinearError(str(payload["errors"]))
    if status_code >= 400:
        raise LinearError(f"HTTP {status_code}")
    data = payload.get("data")
    if data is None:
        raise LinearError("empty data in response")
    return data  # type: ignore[no-any-return]


class LinearClient:
    def __init__(self, api_key: str, api_url: str = "https://api.linear.app/graphql") -> None:
        self._api_key = api_key
        self._api_url = api_url

    async def _execute(
        self, query: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                self._api_url,
                headers={
                    "Authorization": self._api_key,
                    "Content-Type": "application/json",
                },
                json={"query": query, "variables": variables or {}},
            )
        try:
            payload = resp.json()
        except ValueError:
            payload = None
        return _parse_payload(payload, resp.status_code)

    # --- 读 ---

    async def viewer(self) -> dict[str, Any]:
        data = await self._execute(
            "{ viewer { id name email } organization { name urlKey } }"
        )
        return data

    async def issue_pr_url(self, issue_id: str) -> str | None:
        """读 issue 上关联的 GitHub PR 链接。Codex 开 PR 时 Linear 自动把 PR 挂成 issue
        attachment——比按 issue 标识去 GitHub 搜文本可靠（标识未必出现在 PR 标题/正文里）。"""
        q = "query($id: String!){ issue(id:$id){ attachments{ nodes{ url } } } }"
        data = await self._execute(q, {"id": issue_id})
        issue = data.get("issue") or {}
        nodes = (issue.get("attachments") or {}).get("nodes") or []
        for n in nodes:
            url = str(n.get("url") or "")
            if "github.com" in url and "/pull/" in url:
                return url
        return None

    # --- 写回 issue（进度可观测 + 反复改回执）---

    async def create_comment(self, issue_id: str, body: str) -> str:
        q = (
            "mutation($input: CommentCreateInput!){ "
            "commentCreate(input:$input){ success comment { id } } }"
        )
        data = await self._execute(q, {"input": {"issueId": issue_id, "body": body}})
        return str(data["commentCreate"]["comment"]["id"])

    async def create_agent_activity(
        self, session_id: str, activity_type: str, body: str
    ) -> str:
        """agentActivity：thought / action / elicitation / response / error。"""
        q = (
            "mutation($input: AgentActivityCreateInput!){ "
            "agentActivityCreate(input:$input){ success agentActivity { id } } }"
        )
        data = await self._execute(
            q,
            {
                "input": {
                    "agentSessionId": session_id,
                    "content": {"type": activity_type, "body": body},
                }
            },
        )
        return str(data["agentActivityCreate"]["agentActivity"]["id"])

    async def assign_issue(self, issue_id: str, assignee_id: str) -> bool:
        q = (
            "mutation($id: String!, $input: IssueUpdateInput!){ "
            "issueUpdate(id:$id, input:$input){ success } }"
        )
        data = await self._execute(q, {"id": issue_id, "input": {"assigneeId": assignee_id}})
        return bool(data["issueUpdate"]["success"])

    async def delegate_issue(self, issue_id: str, delegate_id: str) -> bool:
        """把 issue 委派给一个 agent（如 Codex）。设 delegateId 会触发该 agent 的
        AgentSessionEvent（人保留 assignee ownership）。实测这是触发 Codex 的正解——
        assigneeId 不可靠、纯文本 @mention 不是真 mention。"""
        q = (
            "mutation($id: String!, $input: IssueUpdateInput!){ "
            "issueUpdate(id:$id, input:$input){ success } }"
        )
        data = await self._execute(q, {"id": issue_id, "input": {"delegateId": delegate_id}})
        return bool(data["issueUpdate"]["success"])

    # --- OAuth app 自助配置（回调 / webhook，无需手点 UI）---

    async def find_oauth_app_id(self, client_id: str) -> str | None:
        """按 clientId 找 OAuth app 的内部 id（oauthApplicationUpdate 需要）。

        需 `oauth:create` scope；personal key 默认没有，调用会 raise LinearError(FORBIDDEN)。
        """
        data = await self._execute("{ oauthApplications { id clientId name } }")
        for app in data.get("oauthApplications", []):
            if app.get("clientId") == client_id:
                return str(app["id"])
        return None

    async def create_webhook(
        self,
        url: str,
        secret: str,
        resource_types: list[str],
        *,
        all_public_teams: bool = True,
    ) -> str:
        """建数据 webhook（Issue/Comment 等）。需 admin scope。"""
        q = (
            "mutation($input: WebhookCreateInput!){ "
            "webhookCreate(input:$input){ success webhook { id } } }"
        )
        data = await self._execute(
            q,
            {
                "input": {
                    "url": url,
                    "secret": secret,
                    "resourceTypes": resource_types,
                    "allPublicTeams": all_public_teams,
                }
            },
        )
        return str(data["webhookCreate"]["webhook"]["id"])

    async def update_oauth_app(
        self,
        app_id: str,
        *,
        redirect_uris: list[str] | None = None,
        webhook_url: str | None = None,
        webhook_resource_types: list[str] | None = None,
        webhook_enabled: bool | None = None,
    ) -> dict[str, Any]:
        input_obj: dict[str, Any] = {}
        if redirect_uris is not None:
            input_obj["redirectUris"] = redirect_uris
        if webhook_url is not None:
            input_obj["webhookUrl"] = webhook_url
        if webhook_resource_types is not None:
            input_obj["webhookResourceTypes"] = webhook_resource_types
        if webhook_enabled is not None:
            input_obj["webhookEnabled"] = webhook_enabled
        q = (
            "mutation($id: String!, $input: OAuthApplicationUpdateInput!){ "
            "oauthApplicationUpdate(id:$id, input:$input){ success } }"
        )
        return await self._execute(q, {"id": app_id, "input": input_obj})
