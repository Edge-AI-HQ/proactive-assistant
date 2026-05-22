from __future__ import annotations

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user, get_pool
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.litellm.client import LiteLLMError
from pinai_agents.web.routes.ui import ambient as ambient_routes
from pinai_agents.web.services.ambient_summary import DEFAULT_AMBIENT_SUMMARY_MODEL


def _user(user_id: int = 123) -> User:
    return User(
        id=user_id,
        supabase_user_id=f"test-sub-{user_id}",
        email=f"user-{user_id}@test.invalid",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )


async def _client() -> httpx.AsyncClient:
    app = create_app()
    app.dependency_overrides[current_user] = lambda: _user()
    app.dependency_overrides[get_pool] = lambda: object()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


def _payload() -> dict[str, object]:
    return {
        "context": {
            "schemaVersion": "ambient_summary.v1",
            "localDate": "2026-05-19",
            "generatedAt": "2026-05-19T10:15:00.000Z",
            "rawEvents": [
                {
                    "id": "raw-1",
                    "sourceType": "calendar",
                    "eventType": "calendar.current",
                    "occurredAt": "2026-05-19T10:00:00.000Z",
                    "text": "Product review with the team",
                    "sensitivity": "normal",
                    "confidence": 0.8,
                }
            ],
            "recentSummaries": [],
        }
    }


@pytest.mark.asyncio
async def test_ambient_summary_posts_context_to_litellm(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_generate(**kwargs):
        captured.update(kwargs)
        return ambient_routes.AmbientSummaryDraft(
            title="Product review",
            summary="You reviewed product work with the team.",
            tags=["meeting"],
            confidence=0.82,
            confidenceLabel="certain",
        )

    async def fake_ensure_user_litellm_key(_pool, user, *, required_models=None):
        captured["required_models"] = required_models
        user.litellm_virtual_key = "sk-test-ambient"
        return user

    monkeypatch.setattr(ambient_routes, "generate_ambient_summary", fake_generate)
    monkeypatch.setattr(
        ambient_routes, "ensure_user_litellm_key", fake_ensure_user_litellm_key,
    )

    client = await _client()
    async with client:
        response = await client.post("/api/ambient/summary", json=_payload())

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "draft": {
            "title": "Product review",
            "summary": "You reviewed product work with the team.",
            "tags": ["meeting"],
            "confidence": 0.82,
            "confidenceLabel": "certain",
        },
        "modelId": DEFAULT_AMBIENT_SUMMARY_MODEL,
    }
    assert captured["bearer_token"] == "sk-test-ambient"
    assert captured["required_models"] == {DEFAULT_AMBIENT_SUMMARY_MODEL}
    assert captured["context"].raw_events[0].text == "Product review with the team"


@pytest.mark.asyncio
async def test_ambient_summary_rejects_empty_context():
    payload = _payload()
    payload["context"]["rawEvents"] = []  # type: ignore[index]
    client = await _client()
    async with client:
        response = await client.post("/api/ambient/summary", json=payload)

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_ambient_summary_returns_502_when_litellm_fails(monkeypatch):
    async def fake_generate(**_kwargs):
        raise LiteLLMError(500, "boom")

    async def fake_ensure_user_litellm_key(_pool, user, *, required_models=None):
        user.litellm_virtual_key = "sk-test-ambient"
        return user

    monkeypatch.setattr(ambient_routes, "generate_ambient_summary", fake_generate)
    monkeypatch.setattr(
        ambient_routes, "ensure_user_litellm_key", fake_ensure_user_litellm_key,
    )

    client = await _client()
    async with client:
        response = await client.post("/api/ambient/summary", json=_payload())

    assert response.status_code == 502
