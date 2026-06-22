"""find_oauth_app_id + create_webhook（wire_linear.py 用），mock _execute。"""

from __future__ import annotations

from typing import Any

import pytest

from dev_pipeline.linear.client import LinearClient


class Canned(LinearClient):
    def __init__(self, response: dict[str, Any]) -> None:
        super().__init__(api_key="x")
        self._response = response
        self.last_vars: dict[str, Any] | None = None

    async def _execute(
        self, query: str, variables: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.last_vars = variables
        return self._response


@pytest.mark.asyncio
async def test_find_oauth_app_id_matches_client_id() -> None:
    c = Canned(
        {
            "oauthApplications": [
                {"id": "app_a", "clientId": "other", "name": "x"},
                {"id": "app_b", "clientId": "f8a7f0d0", "name": "proactive-ai-dev"},
            ]
        }
    )
    assert await c.find_oauth_app_id("f8a7f0d0") == "app_b"
    assert await c.find_oauth_app_id("missing") is None


@pytest.mark.asyncio
async def test_create_webhook() -> None:
    c = Canned({"webhookCreate": {"success": True, "webhook": {"id": "wh_1"}}})
    wid = await c.create_webhook(
        "https://x/webhook/linear", "secret", ["Issue", "Comment", "AgentSession"]
    )
    assert wid == "wh_1"
    assert c.last_vars is not None
    inp = c.last_vars["input"]
    assert inp["url"] == "https://x/webhook/linear"
    assert inp["resourceTypes"] == ["Issue", "Comment", "AgentSession"]
