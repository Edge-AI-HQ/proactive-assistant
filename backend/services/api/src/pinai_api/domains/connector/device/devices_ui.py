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

import asyncio
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status
from pinai_db.rls import service_tx, user_scoped_tx
from pydantic import BaseModel, Field

from ....platform.auth.deps import User, current_user, get_pool
from ....platform.auth.user_service import load_user_by_id
from ....platform.db.repositories.devices import (
    DeviceOwnerMismatch,
    DevicesRepository,
    DeviceTokenInvalid,
    UserDeviceRow,
    find_device_by_token,
)
from ....platform.storage import media_ext_for_kind, signed_url, upload_media
from .device_ingest import (
    DeviceIngestItem,
    _parse_apps,
    _parse_contacts,
    _parse_health,
    normalize_sync_mode,
    resolve_recipe,
)
from .device_ingest.health import health_full_replace_scope
from .raw_device import RawDeviceRepository, RawIngestResult

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/devices", tags=["devices"])

_DEFAULT_TTL = timedelta(days=30)
_VALID_PLATFORMS = ("ios", "android", "web", "wearable", "sensor", "embedded")
_LEGACY_IOS_DISPLAY_NAMES = {"ios app", "iphone"}
_LEGACY_IOS_MODELS = {"", "iphone"}
_TRANSCRIPT_CANDIDATE_KIND = "ambient.candidate_window"
_TRANSCRIPT_SEGMENT_LABEL_RE = re.compile(r"Transcript segment:\s*")


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


class PushTokenRequest(BaseModel):
    pushToken: str = Field(min_length=16, max_length=512)
    pushProvider: str  # 'apns' | 'fcm' | 'web'


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


def _parse_dt(v: Any) -> datetime:
    """ISO string → aware datetime. Tolerates trailing Z. Raises
    ValueError on un-parseable input; callers should catch and surface
    as a per-item rejection."""
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=UTC)
    if isinstance(v, str):
        s = v if not v.endswith("Z") else v[:-1] + "+00:00"
        return datetime.fromisoformat(s).astimezone(UTC)
    raise ValueError(f"unparseable datetime: {v!r}")


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


def _payload_text(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _is_transcript_candidate_window(kind: str, payload: dict[str, Any]) -> bool:
    return kind == _TRANSCRIPT_CANDIDATE_KIND and payload.get("window_type") == "transcript_session"


def _canonical_transcript_candidate_key(
    *,
    device_id: str,
    payload: dict[str, Any],
) -> str | None:
    local_date = _payload_text(payload, "local_date")
    local_window_id = _payload_text(payload, "local_window_id")
    if not local_date or not local_window_id:
        return None
    return f"ambient:candidate_window:{device_id}:{local_date}:transcript_session:{local_window_id}"


def _valid_raw_ref_count(payload: dict[str, Any]) -> bool:
    value = payload.get("raw_ref_count")
    if isinstance(value, int) and value >= 0:
        return True
    return bool(isinstance(value, str) and value.isdigit())


def _clean_transcript_summary(value: str) -> str:
    cleaned = _TRANSCRIPT_SEGMENT_LABEL_RE.sub("", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or value.strip()


def _clean_transcript_candidate_payload(
    payload: dict[str, Any],
    *,
    summary_changed: bool,
) -> dict[str, Any]:
    compact_context = payload.get("compact_context")
    if not isinstance(compact_context, str):
        return (
            {k: v for k, v in payload.items() if k != "content_hash"}
            if summary_changed
            else payload
        )
    cleaned = _clean_transcript_summary(compact_context)
    compact_changed = cleaned != compact_context
    if not compact_changed and not summary_changed:
        return payload
    next_payload = {k: v for k, v in payload.items() if k != "content_hash"}
    if compact_changed:
        next_payload["compact_context"] = cleaned
    return next_payload


def _device_metadata_value(metadata: dict[str, Any], key: str) -> str | None:
    value = metadata.get(key)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _norm_device_text(value: str | None) -> str:
    return (value or "").strip().lower()


def _is_legacy_ios_app_row(row) -> bool:
    """Older iOS clients only sent app-install identity, not hardware-ish
    metadata. Treat those generic rows as one display device so stale
    canonical/dev app installs do not show as multiple iPhones."""
    if row.platform != "ios":
        return False
    return (
        _norm_device_text(row.display_name) in _LEGACY_IOS_DISPLAY_NAMES
        and _norm_device_text(row.model) in _LEGACY_IOS_MODELS
    )


def _device_display_group_key(row) -> str | None:
    hardware_signature = _device_metadata_value(row.metadata, "hardware_signature")
    if hardware_signature:
        return f"{row.platform}:hardware:{hardware_signature}"
    if _is_legacy_ios_app_row(row):
        return "ios:legacy-generic-phone"
    if row.device_fingerprint_hash:
        return f"{row.platform}:fingerprint:{row.device_fingerprint_hash}"
    return None


@dataclass(slots=True)
class CanonicalDeviceGroup:
    row: UserDeviceRow
    aliased_device_ids: list[str]


def _canonicalize_device_groups(rows: list[UserDeviceRow]) -> list[CanonicalDeviceGroup]:
    modern_platforms = {
        r.platform for r in rows if _device_metadata_value(r.metadata, "hardware_signature")
    }
    modern_group_by_platform = {
        r.platform: _device_display_group_key(r)
        for r in rows
        if _device_metadata_value(r.metadata, "hardware_signature")
    }
    groups: dict[str, CanonicalDeviceGroup] = {}
    order: list[str] = []

    for row in rows:
        group_key = _device_display_group_key(row)
        # Once a platform has hardware-identifying registrations, legacy
        # generic rows from the same platform are aliases of that physical
        # device for display/raw-source purposes.
        if row.platform in modern_platforms and _is_legacy_ios_app_row(row):
            group_key = modern_group_by_platform.get(row.platform) or group_key
        if not group_key:
            group_key = f"{row.platform}:device:{row.device_id}"

        group = groups.get(group_key)
        if group is None:
            group = CanonicalDeviceGroup(row=row, aliased_device_ids=[])
            groups[group_key] = group
            order.append(group_key)
        group.aliased_device_ids.append(row.device_id)

    return [groups[key] for key in order]


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
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        groups = _canonicalize_device_groups(await repo.list_active())
    return {
        "items": [
            {
                "deviceId": group.row.device_id,
                "platform": group.row.platform,
                "displayName": group.row.display_name,
                "appVersion": group.row.app_version,
                "model": group.row.model,
                "registeredAt": group.row.registered_at.isoformat(),
                "lastSeenAt": group.row.last_seen_at.isoformat()
                if group.row.last_seen_at
                else None,
                "status": group.row.status,
                "metadata": group.row.metadata,
                "aliasedDeviceIds": group.aliased_device_ids,
            }
            for group in groups
        ]
    }


@router.post("/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_device(
    body: dict,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> None:
    device_id = str(body.get("deviceId") or "").strip()
    if not device_id:
        raise HTTPException(400, "deviceId required")
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        await repo.revoke(device_id)
    return None


_TEST_PUSH_DELAY_SECONDS = 5


@router.post("/test-push")
async def test_push(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """Debug: schedule a notification ~5s in the future so the developer
    can background the app between tap and delivery, verifying the push
    arrives via APNs (not via the in-app foreground event surface).

    Goes through the same code path as a real new-cards trigger — so a
    failing test_push surfaces in the same `push.skip` / `push.failed`
    / `push.sent` log lines as the production path. No bypass of
    settings.notify_new_cards or device.push_token gating; if those are
    off the test correctly fails (and the log line tells you why).
    """

    async def _delayed() -> None:
        try:
            await asyncio.sleep(_TEST_PUSH_DELAY_SECONDS)
            from ...platform.notification import notify_new_cards  # noqa: PLC0415

            await notify_new_cards(pool, user_id=user.id, card_count=1)
        except Exception:
            logger.exception("test_push delayed task failed user=%s", user.id)

    # Detach the task — request returns immediately. The 5s window is
    # short enough that we don't bother tracking the handle; if api
    # restarts mid-wait, the test just doesn't fire (acceptable for debug).
    asyncio.create_task(_delayed())
    return {"ok": True, "scheduledInSeconds": _TEST_PUSH_DELAY_SECONDS}


@router.put("/{device_id}/push-token")
async def set_push_token(
    device_id: str,
    body: PushTokenRequest,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, Any]:
    """Upsert APNs/FCM/web push token for a registered device. Clients
    re-PUT this on every app launch; the repo resets push_failure_count
    to 0 so a previously-soft-disabled token can be revived in place."""
    async with user_scoped_tx(pool, user.id) as conn:
        repo = DevicesRepository(user.id, conn)
        try:
            row = await repo.set_push_token(
                device_id=device_id,
                push_token=body.pushToken,
                push_provider=body.pushProvider,
            )
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    if row is None:
        raise HTTPException(404, "device not found or revoked")
    return {
        "deviceId": row.device_id,
        "pushProvider": row.push_provider,
        "pushTokenUpdatedAt": (
            row.push_token_updated_at.isoformat() if row.push_token_updated_at else None
        ),
    }


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


def _payload_has_binary(raw_item: Any) -> bool:
    """Cheap pre-scan: does this raw ingest item carry a binary_b64
    payload? Used to decide whether the batch needs a User hydration
    (only media uploads need the Supabase Storage path prefix)."""
    if not isinstance(raw_item, dict):
        return False
    payload = raw_item.get("payload")
    if not isinstance(payload, dict):
        return False
    b64 = payload.get("binary_b64")
    return isinstance(b64, str) and bool(b64)


async def _verify_device(
    pool,
    device_id: str,
    device_token: str,
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
    body: list | dict = Body(...),
    pool=Depends(get_pool),
    x_device_id: str | None = Header(None, alias="X-Device-Id"),
    x_device_token: str | None = Header(None, alias="X-Device-Token"),
) -> dict[str, Any]:
    """Bulk ingest. Body shapes accepted (1:1 with plugin):
      * Array of items (each may carry `source: "device:<id>"`).
      * { deviceId, items: [...] } — wrapper deviceId is the fallback.

    Per-item ``results[i].status`` is one of five values; see contract in
    ``docs/plans/2026-05-12-v2-to-v3-migration.mdx``:
      * ``inserted`` — raw or signal actually written.
      * ``duplicate`` — ON CONFLICT no-op (server already had this key).
      * ``rejected`` — deterministic client-side bug (missing required
        field / cross-device dispatch / unsupported_full_sync). Outbox
        should drop, not retry.
      * ``parse_failed`` — ``IngestItemIn`` validation threw. Outbox
        should drop, not retry.
      * ``retryable_failed`` — server-side write raised an exception
        (DB blip, storage outage). Outbox must retry, not drop.
    """
    device = await _verify_device(pool, x_device_id or "", x_device_token or "")

    wrapper_device_id = "" if isinstance(body, list) else str(body.get("deviceId") or "").strip()
    items_raw = body if isinstance(body, list) else (body.get("items") or [])
    if not isinstance(items_raw, list):
        raise HTTPException(400, "items must be an array")

    # Pre-route items by device. Items with `source: "device:<id>"`
    # routing somewhere other than the verified device are tracked as
    # ``rejected`` so the client knows why a item disappeared. Non-dict
    # items get a ``parse_failed`` placeholder.
    pre_results: list[dict[str, Any]] = []
    by_device: dict[str, list[dict[str, Any]]] = {}
    for idx, raw in enumerate(items_raw):
        if not isinstance(raw, dict):
            pre_results.append(
                {
                    "id": f"unknown_{idx}",
                    "dedupeKey": None,
                    "status": "parse_failed",
                    "reason": "item is not an object",
                }
            )
            continue
        src = _parse_source(raw.get("source"))
        target_device = src[1] if src else wrapper_device_id
        if not target_device:
            pre_results.append(
                {
                    "id": str(raw.get("id") or f"unknown_{idx}"),
                    "dedupeKey": None,
                    "status": "rejected",
                    "reason": "no deviceId in wrapper and no source on item",
                }
            )
            continue
        # Cross-device dispatch is not supported for MVP. Surface as
        # ``rejected`` instead of silently dropping (V2 contract).
        if target_device != device.device_id:
            pre_results.append(
                {
                    "id": str(raw.get("id") or f"unknown_{idx}"),
                    "dedupeKey": None,
                    "status": "rejected",
                    "reason": (
                        f"cross-device dispatch not supported: source target "
                        f"{target_device!r} != verified device {device.device_id!r}"
                    ),
                }
            )
            continue
        by_device.setdefault(target_device, []).append(raw)

    if not by_device and not pre_results and not wrapper_device_id:
        raise HTTPException(400, "deviceId or signal `source` required")

    # Lazy User hydration: device ingest is a hot path and most batches
    # carry no media (signal-only items). Only resolve the device owner's
    # Supabase UUID when a payload actually carries binary_b64 — that's
    # the one place we need the external namespace (Storage path prefix
    # per AGENTS.md "用户标识规约"). One extra DB roundtrip on
    # media-bearing batches; zero on the common case.
    device_user: User | None = None
    if any(_payload_has_binary(r) for r in items_raw):
        device_user = await load_user_by_id(pool, device.user_id)
        if device_user is None:
            raise HTTPException(404, f"device user {device.user_id} not found")

    item_results: list[dict[str, Any]] = list(pre_results)
    async with user_scoped_tx(pool, device.user_id) as conn:
        raw_repo = RawDeviceRepository(device.user_id, conn)
        for did, items in by_device.items():
            r = await _ingest_for_device(
                user=device_user,
                device_id=did,
                platform=device.platform,
                raw_items=items,
                raw_repo=raw_repo,
            )
            item_results.extend(r["results"])
        # Project freshly-ingested device raw → the L1 event stream (pending),
        # same tx. Idempotent (skips raws already projected via source_ref).
        from ...memory.projection import project_unprojected  # noqa: PLC0415

        await project_unprojected(conn, device.user_id)
    accepted = len(items_raw)
    inserted = sum(1 for r in item_results if r["status"] == "inserted")
    ignored = accepted - inserted
    return {
        "ok": True,
        "accepted": accepted,
        "inserted": inserted,
        "ignored": ignored,
        "results": item_results,
    }


async def _ingest_for_device(
    *,
    user: User | None,
    device_id: str,
    platform: str,
    raw_items: list[dict[str, Any]],
    raw_repo: RawDeviceRepository,
) -> dict[str, Any]:
    """Per-device leg of the ingest. Returns ``{"results": [...]}`` only —
    the caller aggregates accepted/inserted/ignored across all legs."""
    created_at = _now_iso()
    results: list[dict[str, Any]] = []
    # (result_index, DeviceIngestItem) — only items that survive
    # validation make it into the write pipeline.
    normalized: list[tuple[int, DeviceIngestItem]] = []

    for r in raw_items:
        item_id_raw = r.get("id") if isinstance(r, dict) else None
        # Validate via Pydantic loosely; tolerate alias drift.
        try:
            item = IngestItemIn.model_validate(r)
        except Exception as e:
            logger.warning("device ingest: drop unparseable item: %s", e)
            results.append(
                {
                    "id": str(item_id_raw) if item_id_raw else "unknown",
                    "dedupeKey": None,
                    "status": "parse_failed",
                    "reason": str(e)[:200],
                }
            )
            continue

        kind = item.kind or item.itemType
        if not kind or not item.id or not item.title or not item.summary:
            results.append(
                {
                    "id": item.id or (str(item_id_raw) if item_id_raw else "unknown"),
                    "dedupeKey": None,
                    "status": "rejected",
                    "reason": "missing required field (kind/id/title/summary)",
                }
            )
            continue

        occurred = _normalize_iso(item.occurredAt, created_at)
        available = _normalize_iso(item.availableAt, occurred)
        expires = _normalize_expires(occurred, item.expiresAt)
        sync_mode = normalize_sync_mode(item.syncMode)
        payload: dict[str, Any] = item.payload or {}
        summary = item.summary

        # Media-bearing kinds: upload binary_b64 → Supabase Storage,
        # rewrite payload to reference storage_path instead of raw bytes.
        b64 = payload.get("binary_b64") if isinstance(payload, dict) else None
        if isinstance(b64, str) and b64 and user is None:
            # Caller's pre-scan said no media in this batch, yet we found
            # binary_b64 here. Log and skip the upload (signal still
            # ingests) — never crash the batch on an internal invariant.
            logger.warning(
                "device ingest: binary payload arrived but user not "
                "hydrated (device=%s kind=%s) — skipping media upload",
                device_id,
                kind,
            )
        elif isinstance(b64, str) and b64 and user is not None:
            ext = media_ext_for_kind(kind, payload.get("mime"))
            if ext:
                try:
                    media = await upload_media(
                        supabase_user_id=user.supabase_user_id,
                        device_id=device_id,
                        item_id=item.id,
                        occurred_at_iso=occurred,
                        binary_b64=b64,
                        mime=payload.get("mime"),
                        kind=kind,
                    )
                    if media:
                        payload = {k: v for k, v in payload.items() if k != "binary_b64"}
                        payload["storage_path"] = media.storage_path
                        payload["byte_len"] = media.byte_len
                        if media.mime:
                            payload["mime"] = media.mime
                except Exception as e:
                    logger.warning("device media upload failed (kind=%s): %s", kind, e)

        dedupe_key = (item.dedupeKey or "").strip() or f"device:{device_id}:{item.id}"
        if _is_transcript_candidate_window(kind, payload):
            canonical_key = _canonical_transcript_candidate_key(
                device_id=device_id,
                payload=payload,
            )
            if canonical_key is None:
                results.append(
                    {
                        "id": item.id,
                        "dedupeKey": None,
                        "status": "rejected",
                        "reason": (
                            "transcript candidate window requires "
                            "payload.local_date and payload.local_window_id"
                        ),
                    }
                )
                continue
            if not _valid_raw_ref_count(payload):
                logger.warning(
                    "device ingest: transcript candidate raw_ref_count invalid "
                    "(device_id=%s id=%s)",
                    device_id,
                    item.id,
                )
            cleaned_summary = _clean_transcript_summary(summary)
            payload = _clean_transcript_candidate_payload(
                payload,
                summary_changed=cleaned_summary != summary,
            )
            summary = cleaned_summary
            dedupe_key = canonical_key
        n = DeviceIngestItem(
            id=item.id,
            device_id=device_id,
            platform=platform,
            kind=kind,
            entity_type=resolve_recipe(kind).entity_type,
            sync_mode=sync_mode,
            title=item.title,
            summary=summary,
            payload=payload,
            salience=item.salience,
            confidence=item.confidence,
            dedupe_key=dedupe_key,
            occurred_at=occurred,
            available_at=available,
            expires_at=expires,
        )
        result_idx = len(results)
        results.append(
            {
                "id": n.id,
                "dedupeKey": n.dedupe_key,
                "status": "pending",
            }
        )
        normalized.append((result_idx, n))

    # Write pipeline — one recipe per kind decides where the row lands, each in
    # its own transaction so a single-row fault doesn't poison the batch:
    #   filtered    → accepted-but-dropped (卡子)
    #   snapshot    → typed parse + pai_raw_device (full-sync replaces the
    #                 device's slice; parse-empty falls back to context event)
    #   latest_wins → transcript window upsert (grows with more audio)
    #   else        → generic context event the projector turns into an L1 event
    for result_idx, n in normalized:
        recipe = resolve_recipe(n.kind)

        if recipe.filtered:
            # Accepted but intentionally not persisted. The client keeps
            # reporting; we drop server-side so it doesn't pile up in the outbox.
            # To enable a kind, flip its recipe in device_ingest/recipes.py.
            results[result_idx]["status"] = "filtered"
            continue

        try:
            async with raw_repo.conn.transaction():
                if recipe.snapshot is not None:
                    res = await _write_snapshot(raw_repo, recipe.snapshot, n)
                elif recipe.latest_wins:
                    res = await raw_repo.upsert_transcript_window(n)
                else:
                    res = await raw_repo.ingest_context_event(n)
        except _UnsupportedFullSync:
            # Deterministic client bug: ambiguous full-sync payload
            # (multi-localDate health). Don't retry.
            results[result_idx]["status"] = "rejected"
            results[result_idx]["reason"] = "unsupported_full_sync (ambiguous local_date)"
            continue
        except Exception as e:
            logger.warning("device ingest: write failed (kind=%s id=%s): %s", n.kind, n.id, e)
            results[result_idx]["status"] = "retryable_failed"
            results[result_idx]["reason"] = f"{type(e).__name__}: {str(e)[:160]}"
            continue

        # inserted vs idempotent duplicate (every write was an ON CONFLICT no-op).
        results[result_idx]["status"] = "inserted" if res.inserted > 0 else "duplicate"

    return {"results": results}


class _UnsupportedFullSync(Exception):
    """Full-sync payload too ambiguous to scope a safe replace (a health
    multi-localDate batch). Surfaces as a deterministic 'rejected' — the client
    should split the payload per date, not retry."""


async def _write_snapshot(
    repo: RawDeviceRepository, snapshot: str, n: DeviceIngestItem
) -> RawIngestResult:
    """Snapshot kind (apps / contacts / health) → parse + write pai_raw_device.

    Full-sync replaces the device's slice (health narrows by local_date / metric
    so a steps push doesn't wipe a sibling heart_rate row); incremental upserts.
    Parse-empty falls back to a context event so the data isn't lost. Raises
    _UnsupportedFullSync when a health full-sync can't be scoped safely."""
    full = n.sync_mode == "full"
    if snapshot == "apps":
        apps = _parse_apps(n)
        if not apps:
            return await repo.ingest_context_event(n)
        if full:
            return await repo.replace_apps(
                device_id=n.device_id,
                occurred_at=n.occurred_at,
                snapshot_id=n.dedupe_key,
                apps=apps,
            )
        return await repo.ingest_apps(
            device_id=n.device_id,
            occurred_at=n.occurred_at,
            snapshot_id=n.dedupe_key,
            apps=apps,
        )
    if snapshot == "contacts":
        contacts = _parse_contacts(n)
        if not contacts:
            return await repo.ingest_context_event(n)
        if full:
            return await repo.replace_contacts(
                device_id=n.device_id,
                occurred_at=n.occurred_at,
                snapshot_id=n.dedupe_key,
                contacts=contacts,
            )
        return await repo.ingest_contacts(
            device_id=n.device_id,
            occurred_at=n.occurred_at,
            snapshot_id=n.dedupe_key,
            contacts=contacts,
        )
    # health
    obs = _parse_health(n)
    if not obs:
        return await repo.ingest_context_event(n)
    if full:
        scope = health_full_replace_scope(n)
        if scope is None:
            raise _UnsupportedFullSync
        return await repo.replace_health(
            device_id=n.device_id,
            local_date=scope.local_date,
            metric=scope.metric,
            observations=obs,
        )
    return await repo.ingest_health(device_id=n.device_id, observations=obs)


# ── unified timeline (Supabase JWT auth) ──


@router.get("/{device_id}/timeline")
async def get_device_timeline(
    device_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    before: datetime | None = None,
    limit: int = 30,
) -> dict[str, Any]:
    """Unified device timeline — the device's pai_raw_device rows (health +
    ambient / device context events), ordered by ``occurred_at DESC`` with a
    single keyset cursor.

    Every device source — health observations, apps / contacts snapshots, and
    ambient / device context events (utterance / visit / calendar / motion /
    focus / transcript_window / context) — lands in pai_raw_device with
    external_id = device_id. ``type`` carries the row's kind so the frontend's
    ``DeviceTimeline`` can render each source.

    Envelope:
        {"ok": True,
         "items": [{"type": "<entity_type>", "occurred_at": "...", "row": {...}}, ...],
         "next_cursor": "..." | null,
         "has_more": bool}

    ``before`` is an ISO-8601 timestamp; clients pass the last item's
    ``occurred_at`` to page backward in time.
    """
    if limit < 1 or limit > 200:
        raise HTTPException(400, "limit must be between 1 and 200")

    # Fetch one more than asked so we can detect has_more without a
    # second COUNT(*).
    fetch_n = limit + 1
    # Cursor: paginate by occurred_at DESC. NULL `before` == start from
    # newest; non-null filters to rows strictly older than the cursor.
    async with user_scoped_tx(pool, user.id) as conn:
        cur = await conn.execute(
            """
            SELECT kind::text AS type, id::text AS row_id,
                   occurred_at,
                   payload || jsonb_build_object(
                     'id', id, 'occurred_at', occurred_at,
                     'device_id', external_id, 'reference_count', reference_count,
                     'title', title, 'snippet', snippet
                   ) AS row
            FROM pai_raw_device
            WHERE user_id = %(user_id)s
              AND external_id = %(device_id)s
              AND (%(before)s::timestamptz IS NULL OR occurred_at < %(before)s)
            ORDER BY occurred_at DESC, type ASC, row_id ASC
            LIMIT %(fetch_n)s
            """,
            {
                "user_id": user.id,
                "device_id": device_id,
                "before": before,
                "fetch_n": fetch_n,
            },
        )
        rows = await cur.fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]
    # psycopg v3 + dict_row deserializes jsonb → dict directly, so the
    # ``row`` field is already a plain dict per the unified-timeline
    # contract (see /api/devices/{deviceId}/timeline in
    # docs/modules/data-connectors.mdx).
    items = [
        {
            "type": r["type"],
            "occurred_at": r["occurred_at"].isoformat(),
            "row": r["row"],
        }
        for r in rows
    ]
    next_cursor = rows[-1]["occurred_at"].isoformat() if has_more and rows else None
    return {
        "ok": True,
        "items": items,
        "next_cursor": next_cursor,
        "has_more": has_more,
    }


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
