"""Device ingest policy registry — port of plugin device-ingest/policies.ts.

Each kind picks one of four modes:
  * signal_only   — only write personal_signals (legacy device events +
    the allowlisted ambient utterance / session_summary voice transcript).
  * raw_only      — only write a typed raw table (health observations).
  * dual          — write raw table + personal_signal in same call (apps,
    contacts directories — agents read raw, generator surfaces signals).
  * filtered      — accept but drop (no write). V3 ambient/device kinds whose
    cloud sink is deferred (location / visit / activity / sound / …): the
    client keeps reporting them, the server just doesn't persist them yet.
    See plan 2026-06-14-proactive-agent-sunset.

The signal/raw split mirrors memory architecture §一:
  signals = increment / consumption layer, raw = source of truth.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from .health import (
    DeviceHealthObservationInput,
    DeviceHealthReplaceScope,
    health_full_replace_scope,
    parse_health_observations,
)

type DeviceIngestMode = Literal["raw_only", "signal_only", "dual", "filtered"]
type DeviceSyncMode = Literal["incremental", "full"]
type DeviceRawTable = Literal[
    "device_apps_snapshot",
    "device_contacts_snapshot",
    "device_health_observations",
]


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


@dataclass(slots=True)
class DeviceRawWrite:
    table: DeviceRawTable
    # Type-erased by design — table picks which dataclass payload comes out.
    payload: Any


@dataclass(slots=True)
class DeviceRawReplaceScope:
    table: DeviceRawTable
    device_id: str
    # Health-only — narrows replace to a (deviceId, localDate) pair, and
    # optionally further to a single metric (the common per-metric path).
    local_date: str | None = None
    metric: str | None = None


@dataclass(slots=True)
class DeviceIngestPolicy:
    mode: DeviceIngestMode
    raw_table: DeviceRawTable | None = None
    parse_raw: Callable[[DeviceIngestItem], list[DeviceRawWrite]] | None = None
    full_replace_scope: Callable[[DeviceIngestItem], DeviceRawReplaceScope | None] | None = None
    build_signal: (
        Callable[[DeviceIngestItem, dict[str, Any] | None], dict[str, Any] | None] | None
    ) = None


def normalize_sync_mode(raw: Any) -> DeviceSyncMode:
    return "full" if raw == "full" else "incremental"


# ── parsers ──


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


def _parse_apps(item: DeviceIngestItem) -> list[DeviceRawWrite]:
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
    if not apps:
        return []
    return [
        DeviceRawWrite(
            table="device_apps_snapshot",
            payload={
                "device_id": item.device_id,
                "occurred_at": item.occurred_at,
                "snapshot_id": item.dedupe_key,
                "apps": apps,
            },
        )
    ]


def _parse_contacts(item: DeviceIngestItem) -> list[DeviceRawWrite]:
    candidates = _coerce_dict_list(item.payload, "contacts", "items", "entries")
    # contacts_json — older clients ship JSON-encoded blob.
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
    if not contacts:
        return []
    return [
        DeviceRawWrite(
            table="device_contacts_snapshot",
            payload={
                "device_id": item.device_id,
                "occurred_at": item.occurred_at,
                "snapshot_id": item.dedupe_key,
                "contacts": contacts,
            },
        )
    ]


def _parse_health(item: DeviceIngestItem) -> list[DeviceRawWrite]:
    obs: list[DeviceHealthObservationInput] = parse_health_observations(item)
    if not obs:
        return []
    return [
        DeviceRawWrite(
            table="device_health_observations",
            payload={
                "device_id": item.device_id,
                "observations": obs,
            },
        )
    ]


# ── signal builders ──


def build_default_signal(
    item: DeviceIngestItem,
    opts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Personal-signal repo input shape. Caller writes via PersonalSignalsRepository.ingest_one."""
    fallback_reason = (opts or {}).get("fallback_reason")
    payload = item.payload
    if fallback_reason:
        payload = {**payload, "ingest_fallback_reason": fallback_reason}
    return {
        "id": item.id,
        "kind": item.kind,
        "title": item.title,
        "summary": item.summary,
        "payload": payload,
        "salience": item.salience,
        "confidence": item.confidence,
        "dedupe_key": item.dedupe_key,
        "occurred_at": item.occurred_at,
        "available_at": item.available_at,
        "expires_at": item.expires_at,
        "source": "device",
        "device_id": item.device_id,
    }


# ── registry ──


_APP_POLICY = DeviceIngestPolicy(
    mode="dual",
    raw_table="device_apps_snapshot",
    parse_raw=_parse_apps,
    full_replace_scope=lambda i: DeviceRawReplaceScope("device_apps_snapshot", i.device_id),
    build_signal=build_default_signal,
)
_CONTACT_POLICY = DeviceIngestPolicy(
    mode="dual",
    raw_table="device_contacts_snapshot",
    parse_raw=_parse_contacts,
    full_replace_scope=lambda i: DeviceRawReplaceScope("device_contacts_snapshot", i.device_id),
    build_signal=build_default_signal,
)


def _health_full_scope(i: DeviceIngestItem) -> DeviceRawReplaceScope | None:
    s: DeviceHealthReplaceScope | None = health_full_replace_scope(i)
    if s is None:
        return None
    return DeviceRawReplaceScope(
        table="device_health_observations",
        device_id=s.device_id,
        local_date=s.local_date,
        metric=s.metric,
    )


_HEALTH_POLICY = DeviceIngestPolicy(
    mode="raw_only",
    raw_table="device_health_observations",
    parse_raw=_parse_health,
    full_replace_scope=_health_full_scope,
)
_SIGNAL_POLICY = DeviceIngestPolicy(mode="signal_only", build_signal=build_default_signal)

# Accepted-but-dropped: the ingest route short-circuits these to status
# 'filtered' (no raw / signal / timeline write). Used for V3 ambient/device
# kinds whose cloud sink is deferred — the client keeps reporting them, the
# server just doesn't persist them yet. Flip a kind to _SIGNAL_POLICY to enable
# it. See plan 2026-06-14-proactive-agent-sunset.
_FILTERED_POLICY = DeviceIngestPolicy(mode="filtered")


DEVICE_INGEST_POLICIES: dict[str, DeviceIngestPolicy] = {
    # V3 ambient → pai_personal_signals, allowlisted. Only the voice transcript
    # (utterance) is surfaced to signals for now so main chat / memory can read
    # the user's offline life; every other ambient/device kind is accepted but
    # filtered (no cloud sink). To enable a kind later, point it at
    # _SIGNAL_POLICY. See plan 2026-06-14-proactive-agent-sunset.
    "ambient.utterance": _SIGNAL_POLICY,
    # `session_summary` carries the V3 voice transcript (speaker_segments +
    # full text in `summary`) — the primary utterance path.
    "session_summary": _SIGNAL_POLICY,
    # Other V3 ambient/device kinds: accepted but filtered. `device.*` is what
    # the V3 client actually emits (services/ambient/kinds.ts); the `ambient.*`
    # aliases cover older builds. health.observation stays raw+timeline (see
    # _HEALTH_POLICY in the block below); ambient.health (legacy alias) filters.
    "ambient.location": _FILTERED_POLICY,
    "ambient.visit": _FILTERED_POLICY,
    "ambient.activity": _FILTERED_POLICY,
    "ambient.sound": _FILTERED_POLICY,
    "ambient.audio_route": _FILTERED_POLICY,
    "ambient.calendar_event": _FILTERED_POLICY,
    "ambient.focus_state": _FILTERED_POLICY,
    "ambient.device_state": _FILTERED_POLICY,
    "ambient.health": _FILTERED_POLICY,
    "device.location": _FILTERED_POLICY,
    "device.visit": _FILTERED_POLICY,
    "device.activity": _FILTERED_POLICY,
    "device.motion_segment": _FILTERED_POLICY,
    "device.sound_classification": _FILTERED_POLICY,
    "device.sound_scene_run": _FILTERED_POLICY,
    "device.calendar_event": _FILTERED_POLICY,
    "device.focus_state": _FILTERED_POLICY,
    "device.audio_route": _FILTERED_POLICY,
    "device.device_state": _FILTERED_POLICY,
    # Legacy device events (signal layer) — kept for any client still on
    # the V2 ambient pipeline / older builds.
    "moment": _SIGNAL_POLICY,
    "attention_item": _SIGNAL_POLICY,
    "ambient.image_chunk": _SIGNAL_POLICY,
    "ambient.audio_chunk": _SIGNAL_POLICY,
    "ambient.video_chunk": _SIGNAL_POLICY,
    "ambient.timeline_event": _SIGNAL_POLICY,
    "ambient.candidate_window": _SIGNAL_POLICY,
    "app_inventory": _APP_POLICY,
    "app_inventory_bootstrap": _APP_POLICY,
    "app_inventory_snapshot": _APP_POLICY,
    "contact_directory": _CONTACT_POLICY,
    "contact_bootstrap": _CONTACT_POLICY,
    "contact_directory_snapshot": _CONTACT_POLICY,
    "health.observation": _HEALTH_POLICY,
}


def _unknown_kind_signal(
    item: DeviceIngestItem,
    _opts: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return build_default_signal(item, {"fallback_reason": "unknown_kind"})


UNKNOWN_KIND_POLICY = DeviceIngestPolicy(
    mode="signal_only",
    build_signal=_unknown_kind_signal,
)


def resolve_policy(kind: str) -> DeviceIngestPolicy:
    if kind.startswith("device.media."):
        return _SIGNAL_POLICY
    return DEVICE_INGEST_POLICIES.get(kind, UNKNOWN_KIND_POLICY)
