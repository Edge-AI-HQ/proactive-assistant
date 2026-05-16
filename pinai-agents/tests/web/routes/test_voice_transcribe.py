from __future__ import annotations

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user, get_pool
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.routes.ui import voice as voice_routes


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


@pytest.mark.asyncio
async def test_voice_transcribe_posts_raw_audio(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_transcribe_audio(**kwargs):
        captured.update(kwargs)
        return "测试文本"

    async def fake_ensure_user_litellm_key(_pool, user, *, required_models=None):
        captured["required_models"] = required_models
        user.litellm_virtual_key = "sk-test-voice"
        return user

    monkeypatch.setattr(voice_routes, "transcribe_audio", fake_transcribe_audio)
    monkeypatch.setattr(
        voice_routes, "ensure_user_litellm_key", fake_ensure_user_litellm_key,
    )

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe",
            content=b"fake-audio",
            headers={
                "Content-Type": "audio/wav",
                "X-Audio-Filename": "input.wav",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "text": "测试文本",
        "model": "gpt-4o-transcribe",
    }
    assert captured["audio"] == b"fake-audio"
    assert captured["content_type"] == "audio/wav"
    assert captured["filename"] == "input.wav"
    assert captured["bearer_token"] == "sk-test-voice"
    assert captured["model"] == "gpt-4o-transcribe"
    assert captured["language"] == "zh"
    assert captured["required_models"] == {"gpt-4o-transcribe"}


@pytest.mark.asyncio
async def test_voice_transcribe_accepts_language_hint(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_transcribe_audio(**kwargs):
        captured.update(kwargs)
        return "hello"

    async def fake_ensure_user_litellm_key(_pool, user, *, required_models=None):
        user.litellm_virtual_key = "sk-test-voice"
        return user

    monkeypatch.setattr(voice_routes, "transcribe_audio", fake_transcribe_audio)
    monkeypatch.setattr(
        voice_routes, "ensure_user_litellm_key", fake_ensure_user_litellm_key,
    )

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe?language=en-US",
            content=b"fake-audio",
            headers={"Content-Type": "audio/wav"},
        )

    assert response.status_code == 200
    assert captured["language"] == "en"


@pytest.mark.asyncio
async def test_voice_transcribe_rejects_unknown_model():
    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe?model=random-model",
            content=b"fake-audio",
            headers={"Content-Type": "audio/webm"},
        )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_voice_transcribe_rejects_non_audio_payload():
    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe",
            content=b"not-audio",
            headers={"Content-Type": "text/plain"},
        )

    assert response.status_code == 415


@pytest.mark.asyncio
async def test_voice_transcribe_rejects_oversized_payload(monkeypatch):
    monkeypatch.setattr(voice_routes, "MAX_AUDIO_BYTES", 3)
    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe",
            content=b"1234",
            headers={"Content-Type": "audio/webm"},
        )

    assert response.status_code == 413
