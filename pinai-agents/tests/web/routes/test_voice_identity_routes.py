from __future__ import annotations

import struct
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from pinai_agents.web.app import create_app
from pinai_agents.web.auth.deps import current_user, get_pool
from pinai_agents.web.auth.user_service import User
from pinai_agents.web.routes.ui import voice as voice_routes
from pinai_agents.web.storage import UploadedMedia


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


def _wav(duration_ms: int, sample_rate: int = 16_000) -> bytes:
    samples = max(1, sample_rate * duration_ms // 1000)
    data = b"\0\0" * samples
    return b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + len(data)),
            b"WAVEfmt ",
            struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16),
            b"data",
            struct.pack("<I", len(data)),
            data,
        ]
    )


@dataclass(slots=True)
class _Profile:
    enabled: bool = True
    speaker_name: str = "self"
    reference_storage_path: str = "test-sub-123/voice_identity/self_reference.wav"
    reference_mime: str = "audio/wav"
    reference_byte_len: int = 10
    reference_duration_ms: int = 5000
    reference_sha256: str = "a" * 64
    enrolled_at: datetime = datetime(2026, 5, 27, tzinfo=UTC)
    updated_at: datetime = datetime(2026, 5, 27, tzinfo=UTC)


class _Repo:
    profile: _Profile | None = None

    def __init__(self, _user_id: int, _conn: object) -> None:
        pass

    async def get_profile(self) -> _Profile | None:
        return type(self).profile

    async def upsert_profile(self, **kwargs: Any) -> _Profile:
        type(self).profile = _Profile(
            enabled=True,
            reference_storage_path=kwargs["reference_storage_path"],
            reference_mime=kwargs["reference_mime"],
            reference_byte_len=kwargs["reference_byte_len"],
            reference_duration_ms=kwargs["reference_duration_ms"],
            reference_sha256=kwargs["reference_sha256"],
        )
        return type(self).profile

    async def set_enabled(self, enabled: bool) -> _Profile | None:
        if type(self).profile is None:
            return None
        type(self).profile.enabled = enabled
        return type(self).profile

    async def delete_profile(self) -> None:
        type(self).profile = None


@asynccontextmanager
async def _fake_user_scoped_tx(_pool: object, _user_id: int):
    yield object()


@pytest.fixture(autouse=True)
def _patch_repo(monkeypatch):
    _Repo.profile = None
    monkeypatch.setattr(voice_routes, "VoiceIdentityRepository", _Repo)
    monkeypatch.setattr(voice_routes, "user_scoped_tx", _fake_user_scoped_tx)


@pytest.mark.asyncio
async def test_get_voice_identity_returns_null_when_not_enrolled():
    client = await _client()
    async with client:
        response = await client.get("/api/voice/identity")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "profile": None}


@pytest.mark.asyncio
async def test_upload_voice_identity_reference_validates_wav_and_stores_metadata(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_upload_user_media_bytes(**kwargs):
        captured.update(kwargs)
        return UploadedMedia(
            storage_path=kwargs["storage_path"],
            byte_len=len(kwargs["data"]),
            mime=kwargs["content_type"],
        )

    monkeypatch.setattr(voice_routes, "upload_user_media_bytes", fake_upload_user_media_bytes)

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/identity/reference",
            content=_wav(5000),
            headers={"Content-Type": "audio/wav"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["profile"]["enabled"] is True
    assert body["profile"]["speakerName"] == "self"
    assert body["profile"]["referenceDurationMs"] == 5000
    assert captured["storage_path"] == "test-sub-123/voice_identity/self_reference.wav"
    assert captured["content_type"] == "audio/wav"


@pytest.mark.asyncio
async def test_upload_voice_identity_reference_rejects_too_short_audio(monkeypatch):
    monkeypatch.setattr(
        voice_routes,
        "upload_user_media_bytes",
        pytest.fail,
    )

    client = await _client()
    async with client:
        response = await client.post(
            "/api/voice/identity/reference",
            content=_wav(1500),
            headers={"Content-Type": "audio/wav"},
        )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_disable_and_delete_voice_identity(monkeypatch):
    async def fake_upload_user_media_bytes(**kwargs):
        return UploadedMedia(
            storage_path=kwargs["storage_path"],
            byte_len=len(kwargs["data"]),
            mime=kwargs["content_type"],
        )

    deleted: list[str] = []

    async def fake_delete_media(path: str) -> bool:
        deleted.append(path)
        return True

    monkeypatch.setattr(voice_routes, "upload_user_media_bytes", fake_upload_user_media_bytes)
    monkeypatch.setattr(voice_routes, "delete_media", fake_delete_media)

    client = await _client()
    async with client:
        await client.post(
            "/api/voice/identity/reference",
            content=_wav(5000),
            headers={"Content-Type": "audio/wav"},
        )
        disabled = await client.post("/api/voice/identity", json={"enabled": False})
        deleted_response = await client.delete("/api/voice/identity/reference")

    assert disabled.status_code == 200
    assert disabled.json()["profile"]["enabled"] is False
    assert deleted_response.status_code == 200
    assert deleted == ["test-sub-123/voice_identity/self_reference.wav"]
