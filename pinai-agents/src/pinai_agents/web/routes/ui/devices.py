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

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status
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
_LEGACY_IOS_DISPLAY_NAMES = {"ios app", "iphone"}
_LEGACY_IOS_MODELS = {"", "iphone"}


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


def _canonicalize_device_list(rows):
    modern_platforms = {
        r.platform
        for r in rows
        if _device_metadata_value(r.metadata, "hardware_signature")
    }
    seen: set[str] = set()
    out = []
    for row in rows:
        if row.platform in modern_platforms and _is_legacy_ios_app_row(row):
            continue
        group_key = _device_display_group_key(row)
        if group_key and group_key in seen:
            continue
        if group_key:
            seen.add(group_key)
        out.append(row)
    return out


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
        rows = _canonicalize_device_list(await repo.list_active())
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

    is_array = isinstance(body, list)
    wrapper_device_id = (
        ""
        if is_array
        else str(body.get("deviceId") or "").strip()
    )
    items_raw = body if is_array else (body.get("items") or [])
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
            pre_results.append({
                "id": f"unknown_{idx}", "dedupeKey": None,
                "status": "parse_failed", "reason": "item is not an object",
            })
            continue
        src = _parse_source(raw.get("source"))
        target_device = src[1] if src else wrapper_device_id
        if not target_device:
            pre_results.append({
                "id": str(raw.get("id") or f"unknown_{idx}"),
                "dedupeKey": None, "status": "rejected",
                "reason": "no deviceId in wrapper and no source on item",
            })
            continue
        # Cross-device dispatch is not supported for MVP. Surface as
        # ``rejected`` instead of silently dropping (V2 contract).
        if target_device != device.device_id:
            pre_results.append({
                "id": str(raw.get("id") or f"unknown_{idx}"),
                "dedupeKey": None, "status": "rejected",
                "reason": (
                    f"cross-device dispatch not supported: source target "
                    f"{target_device!r} != verified device {device.device_id!r}"
                ),
            })
            continue
        by_device.setdefault(target_device, []).append(raw)

    if not by_device and not pre_results and not wrapper_device_id:
        raise HTTPException(400, "deviceId or signal `source` required")

    item_results: list[dict[str, Any]] = list(pre_results)
    async with user_scoped_tx(pool, device.user_id) as conn:
        signals_repo = PersonalSignalsRepository(device.user_id, conn)
        raw_repo = RawDeviceRepository(device.user_id, conn)
        for did, items in by_device.items():
            r = await _ingest_for_device(
                user_id=device.user_id, device_id=did, raw_items=items,
                signals_repo=signals_repo, raw_repo=raw_repo,
            )
            item_results.extend(r["results"])
    accepted = len(items_raw)
    inserted = sum(1 for r in item_results if r["status"] == "inserted")
    ignored = accepted - inserted
    return {
        "ok": True, "accepted": accepted, "inserted": inserted,
        "ignored": ignored, "results": item_results,
    }


async def _ingest_for_device(
    *, user_id: int, device_id: str, raw_items: list[dict[str, Any]],
    signals_repo: PersonalSignalsRepository, raw_repo: RawDeviceRepository,
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
            results.append({
                "id": str(item_id_raw) if item_id_raw else "unknown",
                "dedupeKey": None,
                "status": "parse_failed",
                "reason": str(e)[:200],
            })
            continue

        kind = item.kind or item.itemType
        if not kind or not item.id or not item.title or not item.summary:
            results.append({
                "id": item.id or (str(item_id_raw) if item_id_raw else "unknown"),
                "dedupeKey": None,
                "status": "rejected",
                "reason": "missing required field (kind/id/title/summary)",
            })
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

        dedupe_key = (item.dedupeKey or "").strip() or f"device:{device_id}:{item.id}"
        n = DeviceIngestItem(
            id=item.id, device_id=device_id, kind=kind, sync_mode=sync_mode,
            title=item.title, summary=item.summary, payload=payload,
            salience=item.salience, confidence=item.confidence,
            dedupe_key=dedupe_key,
            occurred_at=occurred, available_at=available, expires_at=expires,
        )
        result_idx = len(results)
        results.append({
            "id": n.id, "dedupeKey": n.dedupe_key, "status": "pending",
        })
        normalized.append((result_idx, n))

    # Write pipeline — per-item SAVEPOINT keeps single-row faults from
    # poisoning the batch.
    for result_idx, n in normalized:
        policy = resolve_policy(n.kind)
        # Per-item state: raw_inserted = raw row actually written;
        # raw_failed = server-side exception during raw writes;
        # signal_payload = signal to attempt (or None);
        # rejected_reason = deterministic semantic failure that should
        #   short-circuit (the result is already set to "rejected").
        raw_inserted = False
        raw_failed_exc: Exception | None = None
        signal_payload: dict[str, Any] | None = None
        rejected_reason: str | None = None

        if policy.mode in ("raw_only", "dual") and policy.parse_raw:
            raw_writes = policy.parse_raw(n)
            if not raw_writes:
                # Parser couldn't pull anything out — record the fallback
                # signal so the data isn't lost. Per-item success will be
                # decided by whether the signal write lands.
                signal_payload = build_default_signal(
                    n, {"fallback_reason": "raw_parse_failed"},
                )
            else:
                scope = (
                    policy.full_replace_scope(n)
                    if (n.sync_mode == "full" and policy.full_replace_scope)
                    else None
                )
                if n.sync_mode == "full" and not scope:
                    # Deterministic client bug: ambiguous full-sync
                    # payload (multi-localDate health, etc.). Don't retry.
                    rejected_reason = "unsupported_full_sync (ambiguous local_date)"
                else:
                    try:
                        async with raw_repo.conn.transaction():
                            for w in raw_writes:
                                r = await _apply_raw_write(
                                    raw_repo, w, n.sync_mode, scope,
                                )
                                raw_inserted = raw_inserted or r.inserted > 0
                    except Exception as e:
                        raw_failed_exc = e
                        logger.warning(
                            "device ingest: raw policy %s failed: %s",
                            n.kind, e,
                        )

        if rejected_reason is not None:
            results[result_idx]["status"] = "rejected"
            results[result_idx]["reason"] = rejected_reason
            continue

        if raw_failed_exc is not None and policy.mode == "raw_only":
            # raw_only kind blew up server-side. Don't fall back to a
            # signal — surface as retryable so outbox keeps the item.
            results[result_idx]["status"] = "retryable_failed"
            results[result_idx]["reason"] = (
                f"raw write failed: {type(raw_failed_exc).__name__}: "
                f"{str(raw_failed_exc)[:160]}"
            )
            continue

        if signal_payload is None and policy.mode in ("signal_only", "dual"):
            signal_payload = (
                policy.build_signal(n, None) if policy.build_signal
                else build_default_signal(n)
            )

        signal_inserted = False
        signal_failed_exc: Exception | None = None
        if signal_payload is not None:
            sig = signal_payload
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
                # ingest_one is an UPSERT (ON CONFLICT DO UPDATE), so a
                # successful return is always either a fresh INSERT or a
                # content-replacing UPDATE. Outbox semantics: both are
                # "remove from queue", so we collapse them into
                # "inserted". A true idempotent no-op only happens on the
                # raw_only path, which uses DO NOTHING.
                signal_inserted = True
            except Exception as e:
                signal_failed_exc = e
                logger.warning(
                    "device ingest: signal write failed (id=%s): %s", n.id, e,
                )

        # Decide per-item status.
        if raw_inserted or signal_inserted:
            results[result_idx]["status"] = "inserted"
        elif raw_failed_exc is not None or signal_failed_exc is not None:
            # raw_only items hit the explicit branch above; this catches
            # signal_only and dual where a server-side write blew up.
            exc = raw_failed_exc or signal_failed_exc
            assert exc is not None
            results[result_idx]["status"] = "retryable_failed"
            results[result_idx]["reason"] = (
                f"{type(exc).__name__}: {str(exc)[:160]}"
            )
        else:
            # Wrote nothing, no exception → ON CONFLICT no-op for every
            # write attempted on this item. True idempotent duplicate.
            results[result_idx]["status"] = "duplicate"

    return {"results": results}


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
            metric = scope.metric if scope else None
            return await repo.replace_health(
                device_id=p["device_id"], local_date=local_date,
                metric=metric, observations=p["observations"],
            )
        return await repo.ingest_health(
            device_id=p["device_id"], observations=p["observations"],
        )
    # Unknown table — record as zero-impact.
    from ...db.repositories.raw_device import RawIngestResult
    return RawIngestResult(0, 0, 0)


# ── unified timeline (Supabase JWT auth) ──


@router.get("/{device_id}/timeline")
async def get_device_timeline(
    device_id: str,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
    before: datetime | None = None,
    limit: int = 30,
) -> dict[str, Any]:
    """Unified device timeline — UNION of pai_personal_signals and
    pai_raw_device_health_observations, ordered by ``occurred_at DESC``
    with a single keyset cursor.

    Health observations live in raw-only land (``_HEALTH_POLICY`` mode is
    ``raw_only``) so the frontend's ``DeviceTimeline`` needs to merge
    them with personal_signals to show health alongside other signals.
    Doing the union server-side keeps the cursor clean (one keyset
    instead of two per-source buffers that drift on skewed streams).

    Envelope:
        {"ok": True,
         "items": [{"type": "signal"|"health", "occurred_at": "...", "row": {...}}, ...],
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
            WITH unified AS (
              SELECT 'signal'::text AS type, id::text AS row_id,
                     occurred_at, to_jsonb(s) AS row
              FROM pai_personal_signals s
              WHERE user_id = %(user_id)s
                AND device_id = %(device_id)s
                AND status <> 'archived'
                AND (%(before)s::timestamptz IS NULL OR occurred_at < %(before)s)
              UNION ALL
              SELECT 'health'::text AS type, id::text AS row_id,
                     occurred_at, to_jsonb(h) AS row
              FROM pai_raw_device_health_observations h
              WHERE user_id = %(user_id)s
                AND device_id = %(device_id)s
                AND (%(before)s::timestamptz IS NULL OR occurred_at < %(before)s)
            )
            SELECT type, row_id, occurred_at, row
            FROM unified
            ORDER BY occurred_at DESC, type ASC, row_id ASC
            LIMIT %(fetch_n)s
            """,
            {
                "user_id": user.id, "device_id": device_id,
                "before": before, "fetch_n": fetch_n,
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
    next_cursor = (
        rows[-1]["occurred_at"].isoformat() if has_more and rows else None
    )
    return {
        "ok": True, "items": items,
        "next_cursor": next_cursor, "has_more": has_more,
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
