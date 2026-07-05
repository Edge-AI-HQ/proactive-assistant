"""Device ingest — kind → DeviceRecipe → 单表 pai_raw_device。

每个 device kind 由 `recipes.DeviceRecipe` 决定入口行为(entity_type / filtered /
latest_wins / snapshot)。snapshot(apps/contacts/health)额外经 `policies` 的解析器
展开成 typed 行,喂 raw_device.ingest_<snapshot>。未知 kind 兜底落 context event
(不丢数据)。历史上的四 mode(signal_only/dual/raw_only/filtered)dispatch 已收敛。
"""

from __future__ import annotations

from .policies import (
    DeviceAppSnapshotItem,
    DeviceContactSnapshotItem,
    DeviceIngestItem,
    DeviceSyncMode,
    _parse_apps,
    _parse_contacts,
    _parse_health,
    normalize_sync_mode,
)
from .recipes import DeviceRecipe, resolve_recipe

__all__ = [
    "DeviceAppSnapshotItem",
    "DeviceContactSnapshotItem",
    "DeviceIngestItem",
    "DeviceRecipe",
    "DeviceSyncMode",
    "_parse_apps",
    "_parse_contacts",
    "_parse_health",
    "normalize_sync_mode",
    "resolve_recipe",
]
