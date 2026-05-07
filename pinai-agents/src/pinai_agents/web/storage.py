"""Supabase Storage helper — replaces openclaw's local-FS media writes.

Bucket layout: pai-media/{user_id}/{device_id}/{YYYY-MM-DD}/{item_id}.{ext}
The user_id prefix is the per-user partition; signed URLs grant
per-object read access (TTL controlled by `signed_url_ttl_seconds`).

Storage SDK is sync — every call goes through asyncio.to_thread so the
FastAPI event loop never stalls.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass
from functools import lru_cache

from supabase import Client, create_client

from ..config import get_web_settings

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class UploadedMedia:
    storage_path: str  # bucket-relative
    byte_len: int
    mime: str | None


# ── kind → file extension ──

_MEDIA_EXT: dict[str, str] = {
    "ambient.image_chunk": "jpg",
    "ambient.audio_chunk": "opus",
    "ambient.video_chunk": "mp4",
}


def media_ext_for_kind(kind: str, mime: str | None = None) -> str | None:
    """Returns extension for a known media kind, or None when the item
    isn't binary (signal-only). For generic device.media.* we trust mime
    if present, fall back to .bin."""
    if kind in _MEDIA_EXT:
        return _MEDIA_EXT[kind]
    if kind.startswith("device.media."):
        if mime and "/" in mime:
            ext = mime.split("/", 1)[1].split(";", 1)[0].strip()
            return ext or "bin"
        return "bin"
    return None


@lru_cache(maxsize=1)
def _client() -> Client | None:
    s = get_web_settings()
    if not s.supabase_url or not s.supabase_service_role_key:
        return None
    return create_client(s.supabase_url, s.supabase_service_role_key)


def storage_enabled() -> bool:
    return _client() is not None


async def upload_media(
    *,
    user_id: int,
    device_id: str,
    item_id: str,
    occurred_at_iso: str,
    binary_b64: str,
    mime: str | None,
    kind: str,
) -> UploadedMedia | None:
    """Decode + upload base64 binary. Returns None when no client is
    configured (dev without Supabase Storage) or binary is empty / kind
    doesn't carry media. Caller persists the storage_path back into the
    signal payload."""
    cli = _client()
    if cli is None:
        return None
    if not binary_b64:
        return None
    ext = media_ext_for_kind(kind, mime)
    if not ext:
        return None
    try:
        data = base64.b64decode(binary_b64, validate=False)
    except (ValueError, TypeError):
        logger.warning("device media: bad base64 (user=%s kind=%s)", user_id, kind)
        return None
    if not data:
        return None

    bucket = get_web_settings().supabase_media_bucket
    date_dir = (occurred_at_iso or "")[:10]  # YYYY-MM-DD
    path = f"{user_id}/{device_id}/{date_dir}/{item_id}.{ext}"
    content_type = mime or "application/octet-stream"

    def _put() -> None:
        cli.storage.from_(bucket).upload(
            path=path, file=data,
            file_options={"content-type": content_type, "upsert": "true"},
        )

    await asyncio.to_thread(_put)
    return UploadedMedia(storage_path=path, byte_len=len(data), mime=content_type)


async def signed_url(storage_path: str, *, ttl_seconds: int = 3600) -> str | None:
    """Issue a TTL-bounded signed URL for a storage object. Returns None
    when storage is disabled."""
    cli = _client()
    if cli is None:
        return None
    bucket = get_web_settings().supabase_media_bucket

    def _sign() -> str:
        result = cli.storage.from_(bucket).create_signed_url(storage_path, ttl_seconds)
        # SDK returns dict with 'signedURL' or 'signedUrl' depending on version.
        return (result.get("signedURL") or result.get("signedUrl") or "")

    url = await asyncio.to_thread(_sign)
    return url or None
