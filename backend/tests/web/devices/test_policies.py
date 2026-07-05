"""Device ingest recipes + snapshot parsers — no DB needed."""

from __future__ import annotations

from pinai_api.domains.connector.device.device_ingest.health import (
    health_full_replace_scope,
)
from pinai_api.domains.connector.device.device_ingest.policies import (
    DeviceIngestItem,
    _parse_apps,
    _parse_contacts,
    _parse_health,
    normalize_sync_mode,
)
from pinai_api.domains.connector.device.device_ingest.recipes import (
    DEVICE_RECIPES,
    resolve_recipe,
)


def _item(kind: str, payload: dict | None = None) -> DeviceIngestItem:
    return DeviceIngestItem(
        id="i1",
        device_id="d1",
        kind=kind,
        sync_mode="incremental",
        title="t",
        summary="s",
        payload=payload or {},
        salience=0.0,
        confidence=0.0,
        dedupe_key="dk",
        occurred_at="2026-05-05T00:00:00+00:00",
        available_at="2026-05-05T00:00:00+00:00",
        expires_at=None,
    )


def test_normalize_sync_mode():
    assert normalize_sync_mode("full") == "full"
    assert normalize_sync_mode("incremental") == "incremental"
    assert normalize_sync_mode("garbage") == "incremental"
    assert normalize_sync_mode(None) == "incremental"


def test_resolve_recipe_entity_and_snapshot():
    assert resolve_recipe("moment").entity_type == "context"
    assert resolve_recipe("ambient.utterance").entity_type == "utterance"
    assert resolve_recipe("session_summary").entity_type == "utterance"
    assert resolve_recipe("device.visit").entity_type == "visit"
    assert resolve_recipe("device.motion_segment").entity_type == "motion"
    # snapshot kinds route to the typed parser + full-replace path.
    assert resolve_recipe("app_inventory").snapshot == "apps"
    assert resolve_recipe("contact_directory").snapshot == "contacts"
    assert resolve_recipe("health.observation").snapshot == "health"


def test_resolve_recipe_transcript_window_is_latest_wins():
    r = resolve_recipe("ambient.candidate_window")
    assert r.entity_type == "transcript_window"
    assert r.latest_wins is True
    assert r.snapshot is None


def test_resolve_recipe_ambient_signal_routing():
    for kind, entity in (
        ("ambient.visit", "visit"),
        ("device.visit", "visit"),
        ("ambient.calendar_event", "calendar"),
        ("device.calendar_event", "calendar"),
        ("ambient.focus_state", "focus"),
        ("device.audio_route", "focus"),
        ("device.sound_scene_run", "motion"),
        # DATA-FLOW OPEN (2026-06-30): 放开的 sensor → context(投 interaction)。
        ("ambient.location", "context"),
        ("device.location", "context"),
        ("ambient.activity", "context"),
        ("device.activity", "context"),
        ("ambient.sound", "context"),
        ("device.sound_classification", "context"),
        ("ambient.device_state", "context"),
        ("device.device_state", "context"),
    ):
        r = resolve_recipe(kind)
        assert not r.filtered, kind
        assert r.snapshot is None, kind
        assert r.entity_type == entity, kind


def test_resolve_recipe_filters_deprecated_ambient_health_alias():
    # DATA-FLOW OPEN (2026-06-30): 只 ambient.health 保持 filtered —— 真 health 走
    # health.observation(snapshot, typed 解析 + window rollup),放开会双写。
    assert resolve_recipe("ambient.health").filtered is True


def test_resolve_recipe_media_prefix_is_context():
    r = resolve_recipe("device.media.thumbnail")
    assert r.entity_type == "context"
    assert r.snapshot is None


def test_resolve_recipe_unknown_kind_falls_back_to_context():
    r = resolve_recipe("nonsense.kind")
    assert r.entity_type == "context"
    assert r.filtered is False
    assert r.snapshot is None


def test_parse_apps_extracts_under_multiple_aliases():
    item = _item(
        "app_inventory_snapshot",
        payload={
            "apps": [
                {"bundleId": "com.x", "appName": "X", "version": "1.0"},
                # snake variant
                {"bundle_id": "com.y", "app_name": "Y"},
                # missing required field — should drop
                {"bundleId": "", "appName": "Z"},
            ],
        },
    )
    apps = _parse_apps(item)
    assert len(apps) == 2  # third dropped
    assert {a.bundle_id for a in apps} == {"com.x", "com.y"}


def test_parse_apps_returns_empty_when_no_payload():
    assert _parse_apps(_item("app_inventory_snapshot", payload={})) == []


def test_parse_contacts_handles_json_blob_alias():
    import json

    item = _item(
        "contact_directory_snapshot",
        payload={
            "contacts_json": json.dumps(
                [
                    {"displayName": "Alice", "emails": ["a@x"]},
                    {"name": "Bob", "phone": "555-1"},
                ]
            ),
        },
    )
    contacts = _parse_contacts(item)
    assert {c.display_name for c in contacts} == {"Alice", "Bob"}
    assert contacts[1].phones == ["555-1"]


def test_parse_health_skips_rows_without_observation_type():
    item = _item(
        "health.observation",
        payload={
            "observations": [
                {"observation_type": "heart_rate", "metric": "bpm", "value": 70},
                {"metric": "bpm", "value": 70},  # no observation_type → drop
            ]
        },
    )
    obs = _parse_health(item)
    assert len(obs) == 1
    assert obs[0].observation_type == "heart_rate"


def test_health_full_scope_payload_metric_narrows():
    """Payload-level metric narrows scope (the iOS / Android plugin path)."""
    item = _item(
        "health.observation",
        payload={
            "local_date": "2026-05-05",
            "metric": "steps",
            "observations": [
                {
                    "observation_type": "daily_summary",
                    "metric": "steps",
                    "value": 8120,
                    "local_date": "2026-05-05",
                },
            ],
        },
    )
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.local_date == "2026-05-05"
    assert scope.metric == "steps"


def test_health_full_scope_infers_metric_from_single_observation():
    """When payload doesn't carry metric but all obs share one, narrow scope."""
    item = _item(
        "health.observation",
        payload={
            "local_date": "2026-05-05",
            "observations": [
                {
                    "observation_type": "daily_summary",
                    "metric": "heart_rate",
                    "value": 70,
                    "local_date": "2026-05-05",
                },
            ],
        },
    )
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.metric == "heart_rate"


def test_health_full_scope_multi_metric_falls_back_to_date_only():
    """End-of-day batches with multiple metrics → date-only scope."""
    item = _item(
        "health.observation",
        payload={
            "local_date": "2026-05-05",
            "observations": [
                {
                    "observation_type": "daily_summary",
                    "metric": "steps",
                    "value": 8120,
                    "local_date": "2026-05-05",
                },
                {
                    "observation_type": "sample",
                    "metric": "heart_rate",
                    "value": 70,
                    "local_date": "2026-05-05",
                },
            ],
        },
    )
    scope = health_full_replace_scope(item)
    assert scope is not None
    assert scope.local_date == "2026-05-05"
    assert scope.metric is None


def test_health_full_scope_ambiguous_local_date_returns_none():
    """Multiple local_dates with no payload-level pin → None (triggers fallback)."""
    item = _item(
        "health.observation",
        payload={
            "observations": [
                {
                    "observation_type": "daily_summary",
                    "metric": "steps",
                    "value": 1000,
                    "local_date": "2026-05-04",
                },
                {
                    "observation_type": "daily_summary",
                    "metric": "steps",
                    "value": 2000,
                    "local_date": "2026-05-05",
                },
            ],
        },
    )
    assert health_full_replace_scope(item) is None


def test_health_full_scope_payload_local_date_used_when_obs_silent():
    """Payload local_date works even when observations don't carry their own."""
    item = _item(
        "health.observation",
        payload={
            "local_date": "2026-05-05",
            "observations": [
                {"observation_type": "sample", "metric": "steps", "value": 8120},
            ],
        },
    )
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
        "session_summary",
        "moment",
        "attention_item",
        "ambient.image_chunk",
        "ambient.audio_chunk",
        "ambient.video_chunk",
        "ambient.timeline_event",
        "ambient.candidate_window",
        "app_inventory",
        "app_inventory_bootstrap",
        "app_inventory_snapshot",
        "contact_directory",
        "contact_bootstrap",
        "contact_directory_snapshot",
        "health.observation",
    }
    assert expected.issubset(DEVICE_RECIPES.keys())
