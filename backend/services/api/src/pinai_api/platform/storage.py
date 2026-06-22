"""Supabase Storage helper — replaces openclaw's local-FS media writes.

Bucket layout:
    pai-media/{supabase_user_id}/{device_id}/{YYYY-MM-DD}/{item_id}.{ext}

The per-user partition is the **Supabase UUID**, not the internal BIGINT
— `pai-media` is a Supabase-project-level bucket shared across local
docker / dev / prod, so a BIGSERIAL prefix would let env A's user_id=153
read/write env B's user_id=153 directory. See AGENTS.md "用户标识规约".

Signed URLs grant per-object read access (TTL controlled by
`signed_url_ttl_seconds`).

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

from pinai_api.config import get_web_settings

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
    if not s.supabase_url or not s.supabase_secret_key:
        return None
    return create_client(s.supabase_url, s.supabase_secret_key)


async def upload_media(
    *,
    supabase_user_id: str,
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
        logger.warning(
            "device media: bad base64 (user=%s kind=%s)",
            supabase_user_id,
            kind,
        )
        return None
    if not data:
        return None

    bucket = get_web_settings().supabase_media_bucket
    date_dir = (occurred_at_iso or "")[:10]  # YYYY-MM-DD
    path = f"{supabase_user_id}/{device_id}/{date_dir}/{item_id}.{ext}"
    content_type = mime or "application/octet-stream"

    def _put() -> None:
        cli.storage.from_(bucket).upload(
            path=path,
            file=data,
            file_options={"content-type": content_type, "upsert": "true"},
        )

    await asyncio.to_thread(_put)
    return UploadedMedia(storage_path=path, byte_len=len(data), mime=content_type)


async def upload_user_media_bytes(
    *,
    supabase_user_id: str,
    storage_path: str,
    data: bytes,
    content_type: str,
) -> UploadedMedia | None:
    """Upload user-owned bytes under pai-media/{supabase_user_id}/.

    This is for non-device media such as voice identity references. The
    caller chooses the bucket-relative path, but it must stay under the
    Supabase UUID partition.
    """
    cli = _client()
    if cli is None:
        return None
    if not data:
        return None
    expected_prefix = f"{supabase_user_id}/"
    if not storage_path.startswith(expected_prefix):
        msg = f"storage_path must be under {expected_prefix}"
        raise ValueError(msg)
    bucket = get_web_settings().supabase_media_bucket
    media_type = content_type or "application/octet-stream"

    def _put() -> None:
        cli.storage.from_(bucket).upload(
            path=storage_path,
            file=data,
            file_options={"content-type": media_type, "upsert": "true"},
        )

    await asyncio.to_thread(_put)
    return UploadedMedia(
        storage_path=storage_path,
        byte_len=len(data),
        mime=media_type,
    )


async def download_media_bytes(storage_path: str) -> bytes | None:
    """Download a bucket-relative media object. Returns None when storage
    is not configured."""
    cli = _client()
    if cli is None:
        return None
    bucket = get_web_settings().supabase_media_bucket
    data = await asyncio.to_thread(cli.storage.from_(bucket).download, storage_path)
    return bytes(data)


async def delete_media(storage_path: str) -> bool:
    """Delete one bucket-relative media object. Returns False when storage
    is not configured."""
    cli = _client()
    if cli is None:
        return False
    bucket = get_web_settings().supabase_media_bucket
    await asyncio.to_thread(cli.storage.from_(bucket).remove, [storage_path])
    return True


async def delete_all_user_media(supabase_user_id: str) -> int:
    """Recursively delete every file under pai-media/{supabase_user_id}/.
    Returns the number of files removed (0 when storage is disabled or
    the user has no media).

    Supabase's list endpoint isn't recursive — folders surface as bare
    entries without `metadata.size`. DFS through them, then batch-remove.
    Used by the account-deletion flow; the per-user prefix is the only
    user-scoped partition we have on the bucket, so this is sufficient
    to wipe everything they uploaded.
    """
    cli = _client()
    if cli is None:
        return 0
    bucket = get_web_settings().supabase_media_bucket
    user_prefix = supabase_user_id

    files: list[str] = []
    stack = [user_prefix]
    while stack:
        path = stack.pop()
        entries = await asyncio.to_thread(cli.storage.from_(bucket).list, path)
        for entry in entries:
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                continue
            full = f"{path}/{name}"
            meta = entry.get("metadata")
            if isinstance(meta, dict) and meta.get("size") is not None:
                files.append(full)
            else:
                stack.append(full)

    if not files:
        return 0
    # 1000 is Supabase's documented per-request cap on `remove`.
    chunk = 1000
    for i in range(0, len(files), chunk):
        await asyncio.to_thread(
            cli.storage.from_(bucket).remove,
            files[i : i + chunk],
        )
    return len(files)


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
        return result.get("signedURL") or result.get("signedUrl") or ""

    url = await asyncio.to_thread(_sign)
    return url or None
