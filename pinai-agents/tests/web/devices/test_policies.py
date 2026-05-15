"""Device ingest policy registry + parsers — no DB needed."""

from __future__ import annotations

from pinai_agents.web.device_ingest.health import (
    health_full_replace_scope,
)
from pinai_agents.web.device_ingest.policies import (
    DEVICE_INGEST_POLICIES,
    UNKNOWN_KIND_POLICY,
    DeviceIngestItem,
    _parse_apps,
    _parse_contacts,
    _parse_health,
    build_default_signal,
    normalize_sync_mode,
    resolve_policy,
)


def _item(kind: str, payload: dict | None = None) -> DeviceIngestItem:
    return DeviceIngestItem(
        id="i1", device_id="d1", kind=kind, sync_mode="incremental",
        title="t", summary="s", payload=payload or {}, salience=0.0,
        confidence=0.0, dedupe_key="dk", occurred_at="2026-05-05T00:00:00+00:00",
        available_at="2026-05-05T00:00:00+00:00", expires_at=None,
    )


def test_normalize_sync_mode():
    assert normalize_sync_mode("full") == "full"
    assert normalize_sync_mode("incremental") == "incremental"
    assert normalize_sync_mode("garbage") == "incremental"
    assert normalize_sync_mode(None) == "incremental"


def test_resolve_policy_known_kinds():
    assert resolve_policy("moment").mode == "signal_only"
    assert resolve_policy("ambient.timeline_event").mode == "signal_only"
    assert resolve_policy("app_inventory").mode == "dual"
    assert resolve_policy("health.observation").mode == "raw_only"


def test_resolve_policy_media_prefix_falls_back_to_signal_only():
    assert resolve_policy("device.media.thumbnail").mode == "signal_only"


def test_resolve_policy_unknown_kind_uses_unknown_policy():
    p = resolve_policy("nonsense.kind")
    assert p is UNKNOWN_KIND_POLICY
    sig = p.build_signal(_item("nonsense.kind"))  # type: ignore[arg-type]
    assert sig is not None
    assert sig["payload"].get("ingest_fallback_reason") == "unknown_kind"


def test_parse_apps_extracts_under_multiple_aliases():
    item = _item("app_inventory_snapshot", payload={
        "apps": [
            {"bundleId": "com.x", "appName": "X", "version": "1.0"},
            # snake variant
            {"bundle_id": "com.y", "app_name": "Y"},
            # missing required field — should drop
            {"bundleId": "", "appName": "Z"},
        ],
    })
    out = _parse_apps(item)
    assert len(out) == 1
    apps = out[0].payload["apps"]
    assert len(apps) == 2  # third dropped
    assert {a.bundle_id for a in apps} == {"com.x", "com.y"}


def test_parse_apps_returns_empty_when_no_payload():
    assert _parse_apps(_item("app_inventory_snapshot", payload={})) == []


def test_parse_contacts_handles_json_blob_alias():
    import json
    item = _item("contact_directory_snapshot", payload={
        "contacts_json": json.dumps([
            {"displayName": "Alice", "emails": ["a@x"]},
            {"name": "Bob", "phone": "555-1"},
        ]),
    })
    out = _parse_contacts(item)
    assert len(out) == 1
    contacts = out[0].payload["contacts"]
    assert {c.display_name for c in contacts} == {"Alice", "Bob"}
    assert contacts[1].phones == ["555-1"]


def test_parse_health_skips_rows_without_observation_type():
    item = _item("health.observation", payload={"observations": [
        {"observation_type": "heart_rate", "metric": "bpm", "value": 70},
        {"metric": "bpm", "value": 70},  # no observation_type → drop
    ]})
    out = _parse_health(item)
    assert len(out) == 1
    obs = out[0].payload["observations"]
    assert len(obs) == 1


def test_build_default_signal_includes_fallback_reason():
    sig = build_default_signal(_item("moment"), {"fallback_reason": "test"})
    assert sig["payload"]["ingest_fallback_reason"] == "test"


def test_health_full_scope_payload_metric_narrows():
    """Payload-level metric narrows scope (the iOS / Android plugin path)."""
    item = _item("health.observation", payload={
        "local_date": "2026-05-05",
        "metric": "steps",
        "observations": [
            {"observation_type": "daily_summary", "metric": "steps",
             "value": 8120, "local_date": "2026-05-05"},
        ],
    })
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.local_date == "2026-05-05"
    assert scope.metric == "steps"


def test_health_full_scope_infers_metric_from_single_observation():
    """When payload doesn't carry metric but all obs share one, narrow scope."""
    item = _item("health.observation", payload={
        "local_date": "2026-05-05",
        "observations": [
            {"observation_type": "daily_summary", "metric": "heart_rate",
             "value": 70, "local_date": "2026-05-05"},
        ],
    })
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.metric == "heart_rate"


def test_health_full_scope_multi_metric_falls_back_to_date_only():
    """End-of-day batches with multiple metrics → date-only scope."""
    item = _item("health.observation", payload={
        "local_date": "2026-05-05",
        "observations": [
            {"observation_type": "daily_summary", "metric": "steps",
             "value": 8120, "local_date": "2026-05-05"},
            {"observation_type": "sample", "metric": "heart_rate",
             "value": 70, "local_date": "2026-05-05"},
        ],
    })
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.local_date == "2026-05-05"
    assert scope.metric is None


def test_health_full_scope_ambiguous_local_date_returns_none():
    """Multiple local_dates with no payload-level pin → None (triggers fallback)."""
    item = _item("health.observation", payload={
        "observations": [
            {"observation_type": "daily_summary", "metric": "steps",
             "value": 1000, "local_date": "2026-05-04"},
            {"observation_type": "daily_summary", "metric": "steps",
             "value": 2000, "local_date": "2026-05-05"},
        ],
    })
    assert health_full_replace_scope(item) is None


def test_health_full_scope_payload_local_date_used_when_obs_silent():
    """Payload local_date works even when observations don't carry their own."""
    item = _item("health.observation", payload={
        "local_date": "2026-05-05",
        "observations": [
            {"observation_type": "sample", "metric": "steps", "value": 8120},
        ],
    })
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.local_date == "2026-05-05"
    # No payload-level metric, but observations are uniform → infer.
    assert scope.metric == "steps"


def test_known_kinds_are_a_complete_minimum_set():
    """Guard against accidental kind removal — these power the iOS / Android
    clients today. New kinds are fine; removing existing ones must be
    coordinated with mobile releases."""
    expected = {
        "session_summary", "moment", "attention_item",
        "ambient.image_chunk", "ambient.audio_chunk", "ambient.video_chunk",
        "ambient.timeline_event",
        "app_inventory", "app_inventory_bootstrap", "app_inventory_snapshot",
        "contact_directory", "contact_bootstrap", "contact_directory_snapshot",
        "health.observation",
    }
    assert expected.issubset(DEVICE_INGEST_POLICIES.keys())
