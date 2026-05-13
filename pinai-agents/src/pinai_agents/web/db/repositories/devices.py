"""User devices Repository.

Schema: 026_pai_user_devices.sql.

Owns the device-token lifecycle:
  * register: client-generated UUID + Supabase JWT → bcrypt(token) stored,
    plaintext returned ONCE. Subsequent ingest auths via X-Device-Token.
  * rotate: caller authenticates with current token, gets a fresh one.
  * find_by_token: ingest-side lookup; verifies bcrypt and returns the
    device row (without the hash).

Two ownership-aware writes that the route layer must understand:
  * If `device_id` already exists for the same user → token rotated +
    metadata refreshed.
  * If `device_id` exists for a *different* user → CONFLICT (the route
    surfaces a 409 — never let one user's deviceId hijack another's row).
  * Fingerprint dedupe (sha256(platform + hardwareFingerprint)): a fresh
    app install on the same physical device may propose a new deviceId;
    we detect via the fingerprint hash and reuse the existing server
    device_id instead of stranding old rows or moving the registry away
    from already-ingested evidence.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import bcrypt

from .base import UserScopedRepository

_TOKEN_BYTES = 32
_BCRYPT_ROUNDS = 10
_VALID_PLATFORMS = ("ios", "android", "web", "wearable", "sensor", "embedded")


@dataclass(slots=True)
class UserDeviceRow:
    id: int
    device_id: str
    user_id: int
    platform: str
    display_name: str | None
    app_version: str | None
    model: str | None
    registered_at: datetime
    last_seen_at: datetime | None
    status: str
    metadata: dict[str, Any]
    device_fingerprint_hash: str | None

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> UserDeviceRow:
        return cls(
            id=int(row["id"]),
            device_id=row["device_id"],
            user_id=int(row["user_id"]),
            platform=row["platform"],
            display_name=row.get("display_name"),
            app_version=row.get("app_version"),
            model=row.get("model"),
            registered_at=row["registered_at"],
            last_seen_at=row.get("last_seen_at"),
            status=row["status"],
            metadata=(
                row["metadata"] if isinstance(row.get("metadata"), dict)
                else json.loads(row["metadata"]) if row.get("metadata") else {}
            ),
            device_fingerprint_hash=row.get("device_fingerprint_hash"),
        )


@dataclass(slots=True)
class RegisterResult:
    """Plaintext token in `device_token` is returned to the client ONCE."""
    row: UserDeviceRow
    device_token: str


def _generate_token() -> str:
    """256-bit base64url token. crypto-strength random."""
    return secrets.token_urlsafe(_TOKEN_BYTES)


def _hash_token(token: str) -> str:
    return bcrypt.hashpw(token.encode(), bcrypt.gensalt(_BCRYPT_ROUNDS)).decode()


def _verify_token(token: str, hashed: str) -> bool:
    if not token or not hashed:
        return False
    try:
        return bcrypt.checkpw(token.encode(), hashed.encode())
    except (ValueError, TypeError):
        return False


def _fingerprint_hash(platform: str, fingerprint: str | None) -> str | None:
    """sha256(platform:fingerprint). None when fingerprint is too short to
    be useful — guards against e.g. empty-string drift."""
    if not fingerprint:
        return None
    s = fingerprint.strip()
    if len(s) < 8:
        return None
    return hashlib.sha256(f"{platform}:{s}".encode()).hexdigest()


class DeviceTokenInvalid(Exception):
    """Raised when X-Device-Token doesn't match any active device."""


class DeviceOwnerMismatch(Exception):
    """Raised when a deviceId is already owned by another user."""


class DevicesRepository(UserScopedRepository):
    async def register(
        self,
        *,
        device_id: str,
        platform: str,
        display_name: str | None = None,
        app_version: str | None = None,
        model: str | None = None,
        device_fingerprint: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> RegisterResult:
        """Insert or rotate. Returns plaintext token (only this once)."""
        if not device_id or len(device_id.strip()) < 8:
            msg = "deviceId must be at least 8 characters"
            raise ValueError(msg)
        if platform not in _VALID_PLATFORMS:
            msg = f"unsupported platform: {platform}"
            raise ValueError(msg)

        token = _generate_token()
        token_hash = _hash_token(token)
        fp_hash = _fingerprint_hash(platform, device_fingerprint)
        meta_json = json.dumps(metadata or {})

        # First: ownership check by device_id.
        async with self._conn.cursor() as cur:
            await cur.execute(
                "SELECT * FROM pai_user_devices WHERE device_id = %s",
                (device_id,),
            )
            existing = await cur.fetchone()
        if existing is not None:
            if int(existing["user_id"]) != self._user_id:
                raise DeviceOwnerMismatch
            refreshed = await self._refresh(
                row_id=int(existing["id"]),
                platform=platform, token_hash=token_hash,
                display_name=display_name, app_version=app_version,
                model=model, metadata_json=meta_json,
                fingerprint_hash=fp_hash,
            )
            return RegisterResult(row=refreshed, device_token=token)

        # Fingerprint dedupe: same physical device, fresh app install.
        if fp_hash:
            async with self._conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT * FROM pai_user_devices
                    WHERE user_id = %s AND platform = %s AND device_fingerprint_hash = %s
                    ORDER BY (CASE status WHEN 'active' THEN 0 ELSE 1 END),
                             last_seen_at DESC NULLS LAST,
                             registered_at DESC
                    LIMIT 1
                    """,
                    (self._user_id, platform, fp_hash),
                )
                fp_match = await cur.fetchone()
            if fp_match is not None:
                refreshed = await self._refresh(
                    row_id=int(fp_match["id"]),
                    platform=platform, token_hash=token_hash,
                    display_name=display_name, app_version=app_version,
                    model=model, metadata_json=meta_json,
                    fingerprint_hash=fp_hash,
                )
                return RegisterResult(row=refreshed, device_token=token)

        # Fresh insert.
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO pai_user_devices
                  (user_id, device_id, device_token_hash, platform,
                   display_name, app_version, model, metadata,
                   device_fingerprint_hash)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
                RETURNING *
                """,
                (
                    self._user_id, device_id, token_hash, platform,
                    display_name, app_version, model, meta_json, fp_hash,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = "device register returned no row"
            raise RuntimeError(msg)
        return RegisterResult(row=UserDeviceRow.from_record(row), device_token=token)

    async def _refresh(
        self, *, row_id: int, platform: str, token_hash: str,
        display_name: str | None, app_version: str | None, model: str | None,
        metadata_json: str, fingerprint_hash: str | None,
        new_device_id: str | None = None,
    ) -> UserDeviceRow:
        # device_id is the server canonical identifier used by raw/signal
        # rows. Fingerprint dedupe must not rotate it, otherwise old
        # evidence becomes detached from the visible device every time a
        # native app reinstall proposes a fresh UUID.
        async with self._conn.cursor() as cur:
            # Fingerprint dedupe also revokes other active rows with the
            # same fingerprint that aren't this row — a phone can only
            # have one active row per fingerprint.
            if fingerprint_hash:
                await cur.execute(
                    """
                    UPDATE pai_user_devices SET status = 'revoked'
                    WHERE user_id = %s AND platform = %s
                      AND device_fingerprint_hash = %s
                      AND status = 'active' AND id <> %s
                    """,
                    (self._user_id, platform, fingerprint_hash, row_id),
                )
            await cur.execute(
                """
                UPDATE pai_user_devices SET
                  device_id = COALESCE(%s, device_id),
                  device_token_hash = %s,
                  platform = %s,
                  display_name = %s,
                  app_version = %s,
                  model = %s,
                  metadata = %s::jsonb,
                  device_fingerprint_hash = COALESCE(%s, device_fingerprint_hash),
                  status = 'active',
                  registered_at = NOW(),
                  last_seen_at = NOW()
                WHERE id = %s
                RETURNING *
                """,
                (
                    new_device_id, token_hash, platform,
                    display_name, app_version, model,
                    metadata_json, fingerprint_hash, row_id,
                ),
            )
            row = await cur.fetchone()
        if row is None:
            msg = f"device refresh returned no row (id={row_id})"
            raise RuntimeError(msg)
        return UserDeviceRow.from_record(row)

    async def list_active(self) -> list[UserDeviceRow]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT * FROM pai_user_devices
                WHERE user_id = %s AND status = 'active'
                ORDER BY last_seen_at DESC NULLS LAST, registered_at DESC
                """,
                (self._user_id,),
            )
            rows = await cur.fetchall()
        return [UserDeviceRow.from_record(r) for r in rows]

    async def revoke(self, device_id: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_user_devices SET status = 'revoked'
                WHERE user_id = %s AND device_id = %s AND status <> 'revoked'
                """,
                (self._user_id, device_id),
            )
            return (cur.rowcount or 0) > 0

    async def rotate_token(self, device_id: str, current_token: str) -> str:
        """Verify current_token; on success replace with a fresh token and
        return the plaintext."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, device_token_hash FROM pai_user_devices
                WHERE user_id = %s AND device_id = %s AND status = 'active'
                """,
                (self._user_id, device_id),
            )
            row = await cur.fetchone()
        if row is None or not _verify_token(current_token, row["device_token_hash"]):
            raise DeviceTokenInvalid

        new_token = _generate_token()
        new_hash = _hash_token(new_token)
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_user_devices SET
                  device_token_hash = %s, last_seen_at = NOW()
                WHERE id = %s
                """,
                (new_hash, int(row["id"])),
            )
        return new_token


# ── service-role lookups (no user_id binding) ──
# These are called from the ingest path BEFORE the user is known. The
# caller MUST run them under a service-role connection (no app.user_id
# set), so RLS's service_role fallback policy lets the SELECT through.


async def find_device_by_token(conn, device_id: str, token: str) -> UserDeviceRow:
    """Verify (device_id, token) pair via bcrypt. Touches last_seen_at on
    success.

    Raises DeviceTokenInvalid on any mismatch (do NOT leak which check
    failed — same shape for missing device, wrong token, revoked device).
    """
    if not device_id or not token:
        raise DeviceTokenInvalid
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT * FROM pai_user_devices
            WHERE device_id = %s AND status = 'active'
            """,
            (device_id,),
        )
        row = await cur.fetchone()
    if row is None or not _verify_token(token, row["device_token_hash"]):
        raise DeviceTokenInvalid
    # Touch last_seen_at — best-effort; ingest itself is the audit trail.
    async with conn.cursor() as cur:
        await cur.execute(
            "UPDATE pai_user_devices SET last_seen_at = NOW() WHERE id = %s",
            (int(row["id"]),),
        )
    return UserDeviceRow.from_record(row)
