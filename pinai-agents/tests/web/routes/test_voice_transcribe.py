from __future__ import annotations

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user, get_pool
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.routes.ui import voice as voice_routes
from pinai_agents.web.services.voice_transcription import (
    DiarizedTranscriptionResult,
    SpeakerSegment,
)


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
        voice_routes,
        "ensure_user_litellm_key",
        fake_ensure_user_litellm_key,
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
    assert captured["language"] is None
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
        voice_routes,
        "ensure_user_litellm_key",
        fake_ensure_user_litellm_key,
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
async def test_voice_transcribe_accepts_chinese_language_hint(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_transcribe_audio(**kwargs):
        captured.update(kwargs)
        return "测试"

    async def fake_ensure_user_litellm_key(_pool, user, *, required_models=None):
        user.litellm_virtual_key = "sk-test-voice"
        return user

    monkeypatch.setattr(voice_routes, "transcribe_audio", fake_transcribe_audio)
    monkeypatch.setattr(
        voice_routes,
        "ensure_user_litellm_key",
        fake_ensure_user_litellm_key,
    )

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe?language=zh-Hans",
            content=b"fake-audio",
            headers={"Content-Type": "audio/wav"},
        )

    assert response.status_code == 200
    assert captured["language"] == "zh"


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


@pytest.mark.asyncio
async def test_voice_transcribe_diarized_uses_litellm_virtual_key_and_reference(monkeypatch):
    captured: dict[str, object] = {}

    class FakeProfile:
        enabled = True
        speaker_name = "self"
        reference_storage_path = "test-sub-123/voice_identity/self_reference.wav"
        reference_mime = "audio/wav"

    class FakeRepo:
        def __init__(self, _user_id, _conn):
            pass

        async def get_profile(self):
            return FakeProfile()

    async def fake_transcribe_audio_diarized(**kwargs):
        captured.update(kwargs)
        return DiarizedTranscriptionResult(
            text="Self hello.\nSpeaker one replies.",
            segments=[
                SpeakerSegment(speaker="self", text="Self hello.", start_ms=0, end_ms=1200),
                SpeakerSegment(
                    speaker="speaker_1", text="Speaker one replies.", start_ms=1300, end_ms=2800
                ),
            ],
        )

    async def fake_ensure_user_litellm_key(_pool, user, *, required_models=None):
        captured["required_models"] = required_models
        user.litellm_virtual_key = "sk-test-diarize"
        return user

    class FakeTx:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr(voice_routes, "VoiceIdentityRepository", FakeRepo)
    monkeypatch.setattr(voice_routes, "user_scoped_tx", lambda _pool, _user_id: FakeTx())

    async def fake_download_media_bytes(_path):
        return b"reference-wav"

    monkeypatch.setattr(voice_routes, "download_media_bytes", fake_download_media_bytes)
    monkeypatch.setattr(voice_routes, "ensure_user_litellm_key", fake_ensure_user_litellm_key)
    monkeypatch.setattr(voice_routes, "transcribe_audio_diarized", fake_transcribe_audio_diarized)

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe-diarized?language=en-US",
            content=b"meeting-wav",
            headers={"Content-Type": "audio/wav", "X-Audio-Filename": "meeting.wav"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "text": "Self hello.\nSpeaker one replies.",
        "model": "gpt-4o-transcribe-diarize",
        "segments": [
            {"speaker": "self", "text": "Self hello.", "startMs": 0, "endMs": 1200},
            {
                "speaker": "speaker_1",
                "text": "Speaker one replies.",
                "startMs": 1300,
                "endMs": 2800,
            },
        ],
        "selfText": "Self hello.",
        "speakerLabels": ["self", "speaker_1"],
        "diarizationModel": "gpt-4o-transcribe-diarize",
        "diarizationStatus": "matched_reference",
    }
    assert captured["audio"] == b"meeting-wav"
    assert captured["known_speaker_reference"] == b"reference-wav"
    assert captured["known_speaker_reference_mime"] == "audio/wav"
    assert captured["bearer_token"] == "sk-test-diarize"
    assert captured["language"] == "en"
    assert captured["required_models"] == {"gpt-4o-transcribe-diarize"}


@pytest.mark.asyncio
async def test_voice_transcribe_diarized_returns_conflict_when_not_enrolled(monkeypatch):
    class FakeRepo:
        def __init__(self, _user_id, _conn):
            pass

        async def get_profile(self):
            return None

    class FakeTx:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr(voice_routes, "VoiceIdentityRepository", FakeRepo)
    monkeypatch.setattr(voice_routes, "user_scoped_tx", lambda _pool, _user_id: FakeTx())

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/transcribe-diarized",
            content=b"meeting-wav",
            headers={"Content-Type": "audio/wav"},
        )

    assert response.status_code == 409
