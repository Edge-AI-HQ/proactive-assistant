from __future__ import annotations

from pinai_agents.web.services.personal_data_snapshot import (
    APP_STATE_VALUE_SUMMARY,
    REDACTED_SECRET,
    _item,
)


def test_item_redacts_sensitive_payload_values() -> None:
    out = _item({
        "item_id": "connector_1",
        "category": "connectors",
        "source_key": "composio",
        "source_label": "Composio",
        "title": "Gmail connector",
        "payload": {
            "accessToken": "secret-access-token",
            "api_key": "secret-api-key",
            "nested": {
                "clientSecret": "secret-client-secret",
                "publicLabel": "visible label",
            },
        },
    })

    assert out["payload"] == {
        "accessToken": REDACTED_SECRET,
        "api_key": REDACTED_SECRET,
        "nested": {
            "clientSecret": REDACTED_SECRET,
            "publicLabel": "visible label",
        },
    }


def test_item_redacts_sensitive_name_value_pairs() -> None:
    out = _item({
        "item_id": "connector_1",
        "category": "connectors",
        "source_key": "composio",
        "source_label": "Composio",
        "title": "Gmail connector",
        "payload": {
            "headers": [
                {
                    "name": "Authorization",
                    "value": "Bearer secret-access-token",
                },
                {
                    "headerName": "X-Refresh-Token",
                    "rawValue": "secret-raw-token",
                },
                {
                    "name": "X-Public-Label",
                    "value": "visible label",
                },
            ],
            "authPair": {
                "name": "sb-refresh-token",
                "value": "secret-refresh-token",
            },
        },
    })

    assert out["payload"]["headers"] == [
        {
            "name": "Authorization",
            "value": REDACTED_SECRET,
        },
        {
            "headerName": "X-Refresh-Token",
            "rawValue": REDACTED_SECRET,
        },
        {
            "name": "X-Public-Label",
            "value": "visible label",
        },
    ]
    assert out["payload"]["authPair"] == {
        "name": "sb-refresh-token",
        "value": REDACTED_SECRET,
    }


def test_item_builds_app_state_summary_from_redacted_payload() -> None:
    out = _item({
        "item_id": "prefs:dashboard",
        "category": "app_state",
        "source_key": "prefs",
        "source_label": "应用状态",
        "kind": "prefs",
        "title": "dashboard",
        "summary": "raw secret-access-token",
        "payload": {
            "namespace": "prefs",
            "key": "dashboard",
            "value": {
                "accessToken": "secret-access-token",
                "publicLabel": "visible label",
            },
        },
    })

    assert "secret-access-token" not in out["summary"]
    assert REDACTED_SECRET in out["summary"]
    assert "visible label" in out["summary"]
    assert out["payload"]["value"] == {
        "accessToken": REDACTED_SECRET,
        "publicLabel": "visible label",
    }


def test_item_redacts_app_state_value_when_key_is_sensitive() -> None:
    out = _item({
        "item_id": "auth:accessToken",
        "category": "app_state",
        "source_key": "auth",
        "source_label": "应用状态",
        "kind": "auth",
        "title": "accessToken",
        "summary": "raw secret-access-token",
        "payload": {
            "namespace": "auth",
            "key": "accessToken",
            "value": "secret-access-token",
        },
    })

    assert out["summary"] == APP_STATE_VALUE_SUMMARY
    assert out["payload"]["value"] == REDACTED_SECRET
