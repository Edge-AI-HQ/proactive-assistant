from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pinai_api.domains.connector.device.devices_ui import _canonicalize_device_groups
from pinai_api.platform.db.repositories.devices import UserDeviceRow


def _device_row(
    *,
    row_id: int,
    device_id: str,
    last_seen_at: datetime,
    fingerprint_hash: str,
    hardware_signature: str,
) -> UserDeviceRow:
    return UserDeviceRow(
        id=row_id,
        device_id=device_id,
        user_id=84400,
        platform="ios",
        display_name="iPhone",
        app_version=None,
        model="iPhone16,2",
        registered_at=last_seen_at - timedelta(minutes=5),
        last_seen_at=last_seen_at,
        status="active",
        metadata={"hardware_signature": hardware_signature},
        device_fingerprint_hash=fingerprint_hash,
        push_token=None,
        push_provider=None,
        push_token_updated_at=None,
        push_failure_count=0,
    )


def test_canonical_device_groups_keep_latest_row_and_alias_old_ids() -> None:
    now = datetime(2026, 5, 17, 10, 25, tzinfo=UTC)
    rows = [
        _device_row(
            row_id=14,
            device_id="608aa667-9676-4dfd-8c8a-5d85b4fc2cb8",
            last_seen_at=now,
            fingerprint_hash="c70a3e523d48",
            hardware_signature="hardware-v1:ios:Apple:iPhone16,2:physical",
        ),
        _device_row(
            row_id=12,
            device_id="be155715-48de-42ef-99c0-0e6472aaeec3",
            last_seen_at=now - timedelta(days=1),
            fingerprint_hash="6ee8f4819ae7",
            hardware_signature="hardware-v1:ios:Apple:iPhone16,2:physical",
        ),
        _device_row(
            row_id=10,
            device_id='"4e7e7583-d798-4b30-b4f4-ebbee11e6401"',
            last_seen_at=now - timedelta(days=2),
            fingerprint_hash="4461149e5165",
            hardware_signature="hardware-v1:ios:Apple:iPhone16,2:physical",
        ),
    ]

    groups = _canonicalize_device_groups(rows)

    assert len(groups) == 1
    assert groups[0].row.device_id == "608aa667-9676-4dfd-8c8a-5d85b4fc2cb8"
    assert groups[0].aliased_device_ids == [
        "608aa667-9676-4dfd-8c8a-5d85b4fc2cb8",
        "be155715-48de-42ef-99c0-0e6472aaeec3",
        '"4e7e7583-d798-4b30-b4f4-ebbee11e6401"',
    ]
