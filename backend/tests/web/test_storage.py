from __future__ import annotations

import pytest
from pinai_api.platform import storage


class _Bucket:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, dict[str, str]]] = {}
        self.removed: list[str] = []

    def upload(self, *, path: str, file: bytes, file_options: dict[str, str]) -> None:
        self.objects[path] = (file, file_options)

    def download(self, path: str) -> bytes:
        return self.objects[path][0]

    def remove(self, paths: list[str]) -> None:
        self.removed.extend(paths)
        for path in paths:
            self.objects.pop(path, None)


class _Storage:
    def __init__(self, bucket: _Bucket) -> None:
        self.bucket = bucket

    def from_(self, _bucket_name: str) -> _Bucket:
        return self.bucket


class _Client:
    def __init__(self, bucket: _Bucket) -> None:
        self.storage = _Storage(bucket)


@pytest.mark.asyncio
async def test_user_media_byte_helpers_roundtrip(monkeypatch):
    bucket = _Bucket()
    monkeypatch.setattr(storage, "_client", lambda: _Client(bucket))

    uploaded = await storage.upload_user_media_bytes(
        supabase_user_id="supabase-user",
        storage_path="supabase-user/voice_identity/self_reference.wav",
        data=b"wav-bytes",
        content_type="audio/wav",
    )

    assert uploaded is not None
    assert uploaded.storage_path == "supabase-user/voice_identity/self_reference.wav"
    assert uploaded.byte_len == 9
    assert bucket.objects["supabase-user/voice_identity/self_reference.wav"][1] == {
        "content-type": "audio/wav",
        "upsert": "true",
    }
    assert await storage.download_media_bytes(uploaded.storage_path) == b"wav-bytes"

    assert await storage.delete_media(uploaded.storage_path) is True
    assert bucket.removed == ["supabase-user/voice_identity/self_reference.wav"]


@pytest.mark.asyncio
async def test_user_media_upload_rejects_cross_user_path(monkeypatch):
    monkeypatch.setattr(storage, "_client", lambda: _Client(_Bucket()))

    with pytest.raises(ValueError, match="storage_path must be under"):
        await storage.upload_user_media_bytes(
            supabase_user_id="supabase-user",
            storage_path="other-user/voice_identity/self_reference.wav",
            data=b"wav-bytes",
            content_type="audio/wav",
        )
