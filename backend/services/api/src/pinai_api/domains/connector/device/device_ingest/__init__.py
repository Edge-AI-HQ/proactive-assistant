"""Device ingest policy registry — port of plugin device-ingest/.

Each ingest item carries a `kind` field that picks how it lands:
  * signal_only — write into pai_personal_signals
  * raw_only    — write into a typed pai_raw_device_* table
  * dual        — both

`UNKNOWN_KIND_POLICY` falls back to signal_only with a fallback_reason
tag so we don't silently drop unrecognized payloads.
"""

from __future__ import annotations

from .policies import (
    DEVICE_INGEST_POLICIES,
    UNKNOWN_KIND_POLICY,
    DeviceIngestItem,
    DeviceIngestPolicy,
    DeviceRawWrite,
    DeviceSyncMode,
    build_default_signal,
    normalize_sync_mode,
    resolve_policy,
)

__all__ = [
    "DEVICE_INGEST_POLICIES",
    "UNKNOWN_KIND_POLICY",
    "DeviceIngestItem",
    "DeviceIngestPolicy",
    "DeviceRawWrite",
    "DeviceSyncMode",
    "build_default_signal",
    "normalize_sync_mode",
    "resolve_policy",
]
