"""/api/devices/* — device registry (Supabase JWT auth) + ingest/media
(device-token auth).

Two distinct auth surfaces share this module:

  * register / list / revoke / rotate         → Supabase JWT (current_user)
    these need the user's identity to bind / list / revoke devices.

  * ingest / media                            → device-token (X-Device-Id +
    X-Device-Token). The device's user_id is resolved by token lookup.
    No user JWT required — devices run in background and don't have one.

Keeping both in one module so the contract sits in one place; the
distinction is enforced by the FastAPI Depends call in each endpoint.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.devices import (
    DeviceOwnerMismatch,
    DevicesRepository,
    DeviceTokenInvalid,
    find_device_by_token,
)
from ...db.repositories.personal_signals import (
    IngestSignalInput,
    PersonalSignalsRepository,
)
from ...db.repositories.raw_device import RawDeviceRepository
from ...db.rls import service_tx, user_scoped_tx
from ...device_ingest import (
    DeviceIngestItem,
    build_default_signal,
    normalize_sync_mode,
    resolve_policy,
)
from ...storage import media_ext_for_kind, signed_url, upload_media

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/devices", tags=["devices"])

_DEFAULT_TTL = timedelta(days=30)
_VALID_PLATFORMS = ("ios", "android", "web", "wearable", "sensor", "embedded")


# ── pydantic models ──


class RegisterRequest(BaseModel):
    deviceId: str = Field(min_length=8, max_length=200)
    platform: str
    displayName: str | None = None
    appVersion: str | None = None
    model: str | None = None
    deviceFingerprint: str | None = None
    metadata: dict[str, Any] | None = None


class RotateRequest(BaseModel):
    deviceId: str
    currentToken: str


class IngestItemIn(BaseModel):
    """Permissive — historical clients send mixed snake/camel + alias names.

    Required: id, kind|itemType, title, summary. Everything else has a
    sensible default. Source override (per-item `source: "device:<id>"`)
    is parsed at the route level, not here.
    """
    id: str
    kind: str | None = None
    itemType: str | None = None  # legacy alias
    title: str
    summary: str
    payload: dict[str, Any] | None = None
    salience: float = 0.0
    confidence: float = 0.0
    dedupeKey: str | None = Field(default=None, alias="dedupe_key")
    occurredAt: str | int | None = Field(default=None, alias="occurred_at")
    availableAt: str | int | None = Field(default=None, alias="available_at")
    expiresAt: str | int | None = Field(default=None, alias="expires_at")
    syncMode: str | None = Field(default=None, alias="sync_mode")
    source: str | None = None

    model_config = {"populate_by_name": True}


# ── helpers ──


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_iso(v: Any, fallback: str) -> str:
    if v is None or (isinstance(v, str) and not v.strip()):
        return fallback
    try:
        if isinstance(v, (int, float)):
            return datetime.fromtimestamp(float(v) / 1000.0, UTC).isoformat()
        # Tolerate trailing Z by replacing with +00:00.
        s = v if not v.endswith("Z") else v[:-1] + "+00:00"
        return datetime.fromisoformat(s).astimezone(UTC).isoformat()
    except (ValueError, TypeError):
        return fallback


def _normalize_expires(occurred_at: str, raw: Any) -> str | None:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        try:
            base = datetime.fromisoformat(
                occurred_at if not occurred_at.endswith("Z") else occurred_at[:-1] + "+00:00",
            )
            return (base + _DEFAULT_TTL).astimezone(UTC).isoformat()
        except ValueError:
            return None
    return _normalize_iso(raw, occurred_at)


def _parse_source(raw: Any) -> tuple[str, str] | None:
    if not isinstance(raw, str) or ":" not in raw:
        return None
    scheme, _, ident = raw.partition(":")
    if scheme not in ("device", "mobile", "connector", "web") or not ident:
        return None
    return scheme, ident


# ── register / list / revoke / rotate (Supabase JWT) ──


@router.post("/register")
async def register_device(
    body: RegisterRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    if body.platform not in _VALID_PLATFORMS:
        raise HTTPException(400, f"unsupported platform: {body.platform}")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        try:
            result = await repo.register(
                device_id=body.deviceId.strip(),
                platform=body.platform,
                display_name=body.displayName,
                app_version=body.appVersion,
                model=body.model,
                device_fingerprint=body.deviceFingerprint,
                metadata=body.metadata,
            )
        except DeviceOwnerMismatch as e:
            raise HTTPException(409, "device_id is registered to a different user") from e
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    return {
        "deviceId": result.row.device_id,
        "deviceToken": result.device_token,
        "platform": result.row.platform,
        "registeredAt": result.row.registered_at.isoformat(),
    }


@router.get("/list")
async def list_devices(
    user: User = Depends(current_user), pool=Depends(get_pool),
) -> dict[str, Any]:
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        rows = await repo.list_active()
    return {"items": [{
        "deviceId": r.device_id, "platform": r.platform,
        "displayName": r.display_name, "appVersion": r.app_version,
        "model": r.model, "registeredAt": r.registered_at.isoformat(),
        "lastSeenAt": r.last_seen_at.isoformat() if r.last_seen_at else None,
        "status": r.status,
    } for r in rows]}


@router.post("/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(
    body: dict, user: User = Depends(current_user), pool=Depends(get_pool),
) -> None:
    device_id = str(body.get("deviceId") or "").strip()
    if not device_id:
        raise HTTPException(400, "deviceId required")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        await repo.revoke(device_id)
    return None


@router.post("/rotate")
async def rotate_device_token(
    body: RotateRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        try:
            new_token = await repo.rotate_token(body.deviceId, body.currentToken)
        except DeviceTokenInvalid as e:
            raise HTTPException(401, "invalid device token") from e
    return {"deviceId": body.deviceId, "deviceToken": new_token}


# ── ingest / media (device-token auth) ──


async def _verify_device(
    pool, device_id: str, device_token: str,
):
    """Service-role lookup — no app.user_id binding (RLS service_role
    fallback policy lets it through). Returns the verified device row.
    Raises HTTPException(401) on any mismatch."""
    if not device_id or not device_token:
        raise HTTPException(401, "missing device credentials")
    async with service_tx(pool) as conn:
        try:
            return await find_device_by_token(conn, device_id, device_token)
        except DeviceTokenInvalid as e:
            raise HTTPException(401, "invalid device credentials") from e


@router.post("/ingest")
async def ingest_devices(
    body: dict,
    pool=Depends(get_pool),
    x_device_id: str = Header(..., alias="X-Device-Id"),
    x_device_token: str = Header(..., alias="X-Device-Token"),
) -> dict[str, Any]:
    """Bulk ingest. Body shapes accepted (1:1 with plugin):
      * Array of items (each may carry `source: "device:<id>"`).
      * { deviceId, items: [...] } — wrapper deviceId is the fallback.

    Items with a parsed `source: "device:<id>"` route to that device.
    Items with no source land on the wrapper deviceId. Items with no
    routable deviceId are dropped silently (with logging).
    """
    device = await _verify_device(pool, x_device_id, x_device_token)

    is_array = isinstance(body, list)
    wrapper_device_id = (
        ""
        if is_array
        else str(body.get("deviceId") or "").strip()
    )
    items_raw = body if is_array else (body.get("items") or [])
    if not isinstance(items_raw, list):
        raise HTTPException(400, "items must be an array")

    by_device: dict[str, list[dict[str, Any]]] = {}
    for raw in items_raw:
        if not isinstance(raw, dict):
            continue
        # Source override per-item: lets one phone bridge multiple sub-devices.
        src = _parse_source(raw.get("source"))
        target_device = src[1] if src else wrapper_device_id
        if not target_device:
            continue
        # Authorization: every routed deviceId MUST belong to the
        # authenticated user. We trust the token-verified row's user_id
        # but check device_id ownership on every batch. The cheap path:
        # require src deviceId == verified deviceId. Cross-device dispatch
        # within the same user is allowed via a fan-out lookup; for the
        # MVP we narrow to "items must target the verified deviceId only"
        # — same posture as the plugin (no fan-out implemented there
        # either; the wrapper case is the common one).
        if target_device != device.device_id:
            continue
        by_device.setdefault(target_device, []).append(raw)

    if not by_device and not wrapper_device_id:
        raise HTTPException(400, "deviceId or signal `source` required")

    accepted, inserted, ignored = 0, 0, 0
    item_results: list[dict[str, Any]] = []
    async with user_scoped_tx(pool, device.user_id) as conn:
        signals_repo = PersonalSignalsRepository(device.user_id, conn)
        raw_repo = RawDeviceRepository(device.user_id, conn)
        for did, items in by_device.items():
            r = await _ingest_for_device(
                user_id=device.user_id, device_id=did, raw_items=items,
                signals_repo=signals_repo, raw_repo=raw_repo,
            )
            accepted += r["accepted"]
            inserted += r["inserted"]
            ignored += r["ignored"]
            item_results.extend(r["results"])
    return {
        "ok": True, "accepted": accepted, "inserted": inserted,
        "ignored": ignored, "results": item_results,
    }


async def _ingest_for_device(
    *, user_id: int, device_id: str, raw_items: list[dict[str, Any]],
    signals_repo: PersonalSignalsRepository, raw_repo: RawDeviceRepository,
) -> dict[str, Any]:
    created_at = _now_iso()
    normalized: list[DeviceIngestItem] = []

    for r in raw_items:
        # Validate via Pydantic loosely; tolerate alias drift.
        try:
            item = IngestItemIn.model_validate(r)
        except Exception as e:
            logger.warning("device ingest: drop unparseable item: %s", e)
            continue

        kind = item.kind or item.itemType
        if not kind or not item.id or not item.title or not item.summary:
            continue

        occurred = _normalize_iso(item.occurredAt, created_at)
        available = _normalize_iso(item.availableAt, occurred)
        expires = _normalize_expires(occurred, item.expiresAt)
        sync_mode = normalize_sync_mode(item.syncMode)
        payload: dict[str, Any] = item.payload or {}

        # Media-bearing kinds: upload binary_b64 → Supabase Storage,
        # rewrite payload to reference storage_path instead of raw bytes.
        b64 = payload.get("binary_b64") if isinstance(payload, dict) else None
        if isinstance(b64, str) and b64:
            ext = media_ext_for_kind(kind, payload.get("mime"))
            if ext:
                try:
                    media = await upload_media(
                        user_id=user_id, device_id=device_id, item_id=item.id,
                        occurred_at_iso=occurred,
                        binary_b64=b64,
                        mime=payload.get("mime"),
                        kind=kind,
                    )
                    if media:
                        payload = {
                            k: v for k, v in payload.items() if k != "binary_b64"
                        }
                        payload["storage_path"] = media.storage_path
                        payload["byte_len"] = media.byte_len
                        if media.mime:
                            payload["mime"] = media.mime
                except Exception as e:
                    logger.warning("device media upload failed (kind=%s): %s", kind, e)

        normalized.append(DeviceIngestItem(
            id=item.id, device_id=device_id, kind=kind, sync_mode=sync_mode,
            title=item.title, summary=item.summary, payload=payload,
            salience=item.salience, confidence=item.confidence,
            dedupe_key=(item.dedupeKey or "").strip() or f"device:{device_id}:{item.id}",
            occurred_at=occurred, available_at=available, expires_at=expires,
        ))

    raw_inserted: dict[str, bool] = {}
    signal_writes: list[tuple[str, dict[str, Any]]] = []
    # Each item runs in its own SAVEPOINT so a single bad row doesn't poison
    # the rest of the batch. psycopg's `conn.transaction()` opens a savepoint
    # when called inside an existing transaction (which user_scoped_tx provides).
    for n in normalized:
        policy = resolve_policy(n.kind)
        raw_succ = False
        raw_failed = False
        if policy.mode in ("raw_only", "dual") and policy.parse_raw:
            raw_writes = policy.parse_raw(n)
            if not raw_writes:
                signal_writes.append((n.id, build_default_signal(
                    n, {"fallback_reason": "raw_parse_failed"},
                )))
                continue
            scope = (
                policy.full_replace_scope(n)
                if (n.sync_mode == "full" and policy.full_replace_scope)
                else None
            )
            if n.sync_mode == "full" and not scope:
                signal_writes.append((n.id, build_default_signal(
                    n, {"fallback_reason": "unsupported_full_sync"},
                )))
                continue
            try:
                async with raw_repo.conn.transaction():
                    for w in raw_writes:
                        r = await _apply_raw_write(raw_repo, w, n.sync_mode, scope)
                        raw_succ = raw_succ or r.inserted > 0
            except Exception as e:
                raw_failed = True
                logger.warning("device ingest: raw policy %s failed: %s", n.kind, e)

        raw_inserted[n.id] = raw_succ

        if raw_failed and policy.mode == "raw_only":
            signal_writes.append((n.id, build_default_signal(
                n, {"fallback_reason": "raw_write_failed"},
            )))
            continue

        if policy.mode in ("signal_only", "dual"):
            sig = (policy.build_signal(n, None) if policy.build_signal
                   else build_default_signal(n))
            if sig:
                signal_writes.append((n.id, sig))

    signal_inserted: dict[str, bool] = {}
    for item_id, sig in signal_writes:
        try:
            async with signals_repo.conn.transaction():
                await signals_repo.ingest_one(IngestSignalInput(
                    id=sig["id"], kind=sig["kind"],
                    title=sig["title"], summary=sig["summary"],
                    occurred_at=datetime.fromisoformat(
                        sig["occurred_at"] if not sig["occurred_at"].endswith("Z")
                        else sig["occurred_at"][:-1] + "+00:00",
                    ),
                    payload=sig["payload"], salience=sig["salience"],
                    confidence=sig["confidence"], dedupe_key=sig["dedupe_key"],
                    source=sig["source"], device_id=sig["device_id"],
                    subject=sig.get("subject"),
                ))
            signal_inserted[item_id] = True
        except Exception as e:
            logger.warning("device ingest: signal write failed (id=%s): %s", item_id, e)

    results: list[dict[str, Any]] = []
    inserted_count = 0
    for n in normalized:
        ok = raw_inserted.get(n.id, False) or signal_inserted.get(n.id, False)
        if ok:
            inserted_count += 1
        results.append({
            "id": n.id, "dedupeKey": n.dedupe_key,
            "status": "inserted" if ok else "duplicate",
        })
    return {
        "accepted": len(raw_items),
        "inserted": inserted_count,
        "ignored": len(raw_items) - inserted_count,
        "results": results,
    }


async def _apply_raw_write(repo: RawDeviceRepository, write, sync_mode, scope):
    """Dispatch a parsed DeviceRawWrite to the right repo method."""
    p = write.payload
    if write.table == "device_apps_snapshot":
        if sync_mode == "full":
            return await repo.replace_apps(
                device_id=p["device_id"], occurred_at=p["occurred_at"],
                snapshot_id=p["snapshot_id"], apps=p["apps"],
            )
        return await repo.ingest_apps(
            device_id=p["device_id"], occurred_at=p["occurred_at"],
            snapshot_id=p["snapshot_id"], apps=p["apps"],
        )
    if write.table == "device_contacts_snapshot":
        if sync_mode == "full":
            return await repo.replace_contacts(
                device_id=p["device_id"], occurred_at=p["occurred_at"],
                snapshot_id=p["snapshot_id"], contacts=p["contacts"],
            )
        return await repo.ingest_contacts(
            device_id=p["device_id"], occurred_at=p["occurred_at"],
            snapshot_id=p["snapshot_id"], contacts=p["contacts"],
        )
    if write.table == "device_health_observations":
        if sync_mode == "full":
            local_date = scope.local_date if scope else None
            return await repo.replace_health(
                device_id=p["device_id"], local_date=local_date,
                observations=p["observations"],
            )
        return await repo.ingest_health(
            device_id=p["device_id"], observations=p["observations"],
        )
    # Unknown table — record as zero-impact.
    from ...db.repositories.raw_device import RawIngestResult
    return RawIngestResult(0, 0, 0)


# ── media access (Supabase JWT auth — user only sees own objects) ──


@router.get("/media/{storage_path:path}")
async def get_media(
    storage_path: str,
    user: User = Depends(current_user),
):
    """Returns a TTL-bounded signed URL for a media object owned by the
    user. Path must start with `<user_id>/` — caller can't probe other
    users' objects."""
    expected_prefix = f"{user.id}/"
    if not storage_path.startswith(expected_prefix):
        raise HTTPException(403, "object not owned by this user")
    url = await signed_url(storage_path)
    if not url:
        raise HTTPException(503, "storage not configured")
    return {"signedUrl": url}
