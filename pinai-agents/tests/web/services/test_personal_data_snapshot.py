from __future__ import annotations

from pinai_agents.web.services.personal_data_snapshot import (
    REDACTED_SECRET,
    _item,
)


def test_item_redacts_sensitive_payload_values() -> None:
    out = _item(
        {
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
        }
    )

    assert out["payload"] == {
        "accessToken": REDACTED_SECRET,
        "api_key": REDACTED_SECRET,
        "nested": {
            "clientSecret": REDACTED_SECRET,
            "publicLabel": "visible label",
        },
    }


def test_item_redacts_sensitive_name_value_pairs() -> None:
    out = _item(
        {
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
        }
    )

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
