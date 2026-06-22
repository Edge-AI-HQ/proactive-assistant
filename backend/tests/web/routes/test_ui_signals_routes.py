from __future__ import annotations

from datetime import UTC, datetime

from pinai_api.domains.user_model.personal_signals import PersonalSignalRow
from pinai_api.domains.user_model.signals_ui import _to_item


def test_signal_item_includes_raw_source_refs():
    item = _to_item(
        PersonalSignalRow(
            id="sig_with_raw_ref",
            kind="calendar",
            title="Calendar signal",
            summary="Has raw source",
            payload={},
            salience=0.8,
            confidence=0.9,
            dedupe_key="signal-dedupe",
            occurred_at=datetime(2026, 5, 17, 3, 17, tzinfo=UTC),
            available_at=datetime(2026, 5, 17, 3, 17, tzinfo=UTC),
            expires_at=None,
            source="connector",
            device_id=None,
            subject=None,
            source_raw_table="pai_raw_gcal_events",
            source_raw_ids=["raw_event_1"],
            status="open",
            consumed_by_run_id=None,
            ingested_at=datetime(2026, 5, 17, 3, 18, tzinfo=UTC),
            reference_count=0,
        ),
    )

    payload = item.model_dump(by_alias=True, mode="json")

    assert payload["sourceRawTable"] == "pai_raw_gcal_events"
    assert payload["sourceRawIds"] == ["raw_event_1"]
