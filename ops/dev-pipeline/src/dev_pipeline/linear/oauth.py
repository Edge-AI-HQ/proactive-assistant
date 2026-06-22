"""Linear OAuth（actor=app）—— 拿到 app access token，才能以 agent 身份发 agentActivity。

方案 1 必需：personal key 不能代表 app 在 AgentSession 里应答。
docs: https://linear.app/developers/oauth-2-0-authentication
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

import httpx

AUTHORIZE_URL = "https://linear.app/oauth/authorize"
TOKEN_URL = "https://api.linear.app/oauth/token"
# agent 需要：读写 + 可被 assign + 可被 @mention
AGENT_SCOPES = ["read", "write", "app:assignable", "app:mentionable"]


def build_authorize_url(
    client_id: str, redirect_uri: str, state: str, scopes: list[str] | None = None
) -> str:
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": ",".join(scopes or AGENT_SCOPES),
        "state": state,
        "actor": "app",  # 关键：以 app 身份装，actions 归属 app 而非用户
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


class OAuthError(RuntimeError):
    pass


class LinearOAuth:
    def __init__(self, client_id: str, client_secret: str, redirect_uri: str) -> None:
        self._client_id = client_id
        self._client_secret = client_secret
        self._redirect_uri = redirect_uri

    def authorize_url(self, state: str) -> str:
        return build_authorize_url(self._client_id, self._redirect_uri, state)

    async def _post_token(self, data: dict[str, str]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(TOKEN_URL, data=data)
        try:
            payload: dict[str, Any] = resp.json()
        except ValueError as e:
            raise OAuthError(f"non-JSON token response (HTTP {resp.status_code})") from e
        if resp.status_code >= 400 or "access_token" not in payload:
            raise OAuthError(f"token exchange failed: {payload}")
        return payload

    async def exchange_code(self, code: str) -> str:
        """用 authorization code 换 app access token（浏览器授权流程，已被下面的
        client_credentials 取代——后者无需浏览器/回调/revoke，保留仅为兼容旧入口）。"""
        payload = await self._post_token(
            {
                "code": code,
                "redirect_uri": self._redirect_uri,
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "grant_type": "authorization_code",
            }
        )
        return str(payload["access_token"])

    async def mint_app_token(self, scopes: list[str] | None = None) -> str:
        """client_credentials grant：服务端直接用 client_id+secret 换 actor=app token。

        这是拿 agent token 的正解——**无需浏览器授权、无需回调、无需 revoke**。Linear 给
        的是 30 天 token（无 refresh token），过期或失效后再调一次即可，所以调用方在 401
        时重新 mint 就能自愈（见 service._agent_client 的 force_refresh）。
        docs: linear.app/developers/oauth-2-0-authentication（actor=app + client_credentials）
        """
        payload = await self._post_token(
            {
                "grant_type": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "actor": "app",
                "scope": ",".join(scopes or AGENT_SCOPES),
            }
        )
        return str(payload["access_token"])
