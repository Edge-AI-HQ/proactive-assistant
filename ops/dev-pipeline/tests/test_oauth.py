"""Linear OAuth(actor=app)：authorize URL 构造 + code 换 token(mock)。"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest

from dev_pipeline.linear.oauth import LinearOAuth, OAuthError, build_authorize_url


def test_authorize_url_has_actor_app_and_scopes() -> None:
    url = build_authorize_url("cid", "https://x/cb", "st4te")
    q = parse_qs(urlparse(url).query)
    assert q["client_id"] == ["cid"]
    assert q["redirect_uri"] == ["https://x/cb"]
    assert q["response_type"] == ["code"]
    assert q["actor"] == ["app"]
    assert q["state"] == ["st4te"]
    assert "app:assignable" in q["scope"][0]
    assert "app:mentionable" in q["scope"][0]


class FakeOAuth(LinearOAuth):
    def __init__(self, response: dict[str, Any]) -> None:
        super().__init__("cid", "secret", "https://x/cb")
        self._response = response
        self.last_data: dict[str, str] | None = None

    async def _post_token(self, data: dict[str, str]) -> dict[str, Any]:
        self.last_data = data
        if "access_token" not in self._response:
            raise OAuthError(f"token exchange failed: {self._response}")
        return self._response


@pytest.mark.asyncio
async def test_exchange_code_returns_access_token() -> None:
    o = FakeOAuth({"access_token": "tok_123", "token_type": "Bearer"})
    tok = await o.exchange_code("the_code")
    assert tok == "tok_123"
    assert o.last_data is not None
    assert o.last_data["grant_type"] == "authorization_code"
    assert o.last_data["code"] == "the_code"


@pytest.mark.asyncio
async def test_exchange_code_raises_on_error() -> None:
    o = FakeOAuth({"error": "invalid_grant"})
    with pytest.raises(OAuthError):
        await o.exchange_code("bad")
