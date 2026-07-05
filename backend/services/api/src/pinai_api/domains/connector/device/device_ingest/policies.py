"""Device ingest item + snapshot parsers.

一个 device kind 的入口行为由 device_ingest/recipes.py 的 `DeviceRecipe` 决定
(entity_type / filtered / latest_wins / snapshot)。本模块只留数据形状 + 解析工具:
  * `DeviceIngestItem` — 归一化后的单条 ingest 项(devices_ui 构造,喂 raw_device 写入)。
  * snapshot 解析器 `_parse_apps` / `_parse_contacts` / `_parse_health` — 把一个 push
    item 的 payload 展开成 typed 行列表,喂 raw_device.ingest_<snapshot>。

所有 device 数据落单表 pai_raw_device(kind 判别 + payload JSONB)。历史上曾有 per-source
typed 表 + 四 mode(signal_only/dual/raw_only/filtered)dispatch;typed 表已在 118 删、
统一表在 119 拆出,四 mode dispatch 在本次 recipe 化(recipes.py)收敛掉。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .health import (
    DeviceHealthObservationInput,
    parse_health_observations,
)

type DeviceSyncMode = Literal["incremental", "full"]


@dataclass(slots=True)
class DeviceIngestItem:
    id: str
    device_id: str
    kind: str
    sync_mode: DeviceSyncMode
    title: str
    summary: str
    payload: dict[str, Any]
    salience: float
    confidence: float
    dedupe_key: str
    occurred_at: str  # ISO8601
    available_at: str
    expires_at: str | None
    # Normalized pai_raw_device.kind, filled from the item's DeviceRecipe at
    # ingest (recipes.resolve_recipe). Default keeps existing constructors
    # working; the ingest handler always sets it.
    entity_type: str = "context"
    # Source platform (ios/android/wearable/…), denormalized from the verified
    # device row at ingest so it rides into pai_raw_device.platform.
    platform: str | None = None


@dataclass(slots=True)
class DeviceAppSnapshotItem:
    bundle_id: str
    app_name: str
    version: str | None
    last_used_at: str | None


@dataclass(slots=True)
class DeviceContactSnapshotItem:
    display_name: str | None
    emails: list[str]
    phones: list[str]
    last_modified: str | None


def normalize_sync_mode(raw: Any) -> DeviceSyncMode:
    return "full" if raw == "full" else "incremental"


# ── snapshot parsers ──
# Each expands one push item's payload into a list of typed rows; the ingest
# handler feeds the list straight to raw_device.ingest_<snapshot>. Empty list
# when the payload carries nothing parseable (handler falls back to a context
# event so the data isn't lost).


def _coerce_dict_list(payload: dict[str, Any], *keys: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for k in keys:
        v = payload.get(k)
        if isinstance(v, list):
            out.extend(x for x in v if isinstance(x, dict))
    return out


def _str_or(row: dict[str, Any], *keys: str) -> str | None:
    for k in keys:
        v = row.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _parse_apps(item: DeviceIngestItem) -> list[DeviceAppSnapshotItem]:
    rows = _coerce_dict_list(item.payload, "apps", "installedApps", "items", "entries")
    apps: list[DeviceAppSnapshotItem] = []
    for row in rows:
        bundle_id = _str_or(row, "bundleId", "bundle_id", "packageName")
        app_name = _str_or(row, "appName", "app_name", "name")
        if not bundle_id or not app_name:
            continue
        apps.append(
            DeviceAppSnapshotItem(
                bundle_id=bundle_id,
                app_name=app_name,
                version=_str_or(row, "version"),
                last_used_at=_str_or(row, "lastUsedAt", "last_used_at"),
            )
        )
    return apps


def _parse_contacts(item: DeviceIngestItem) -> list[DeviceContactSnapshotItem]:
    candidates = _coerce_dict_list(item.payload, "contacts", "items", "entries")
    # contacts_json — older clients ship a JSON-encoded blob.
    for k in ("contacts_json", "contactsJson"):
        s = item.payload.get(k)
        if isinstance(s, str) and s.strip():
            import json

            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    candidates.extend(x for x in parsed if isinstance(x, dict))
            except (ValueError, TypeError):
                continue

    contacts: list[DeviceContactSnapshotItem] = []
    for row in candidates:
        emails = row.get("emails")
        if not isinstance(emails, list):
            single = _str_or(row, "email")
            emails = [single] if single else []
        phones = row.get("phones") or row.get("phoneNumbers")
        if not isinstance(phones, list):
            single = _str_or(row, "phone")
            phones = [single] if single else []
        contacts.append(
            DeviceContactSnapshotItem(
                display_name=_str_or(row, "displayName", "display_name", "name"),
                emails=[e for e in emails if isinstance(e, str)],
                phones=[p for p in phones if isinstance(p, str)],
                last_modified=_str_or(row, "lastModified", "last_modified"),
            )
        )
    return contacts


def _parse_health(item: DeviceIngestItem) -> list[DeviceHealthObservationInput]:
    return parse_health_observations(item)
