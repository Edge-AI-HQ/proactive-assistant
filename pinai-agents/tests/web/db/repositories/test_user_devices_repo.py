"""DevicesRepository — push token + failure bookkeeping.

The bcrypt-token / fingerprint-dedupe register/rotate path is exercised
indirectly via tests/web/devices/test_*. This file covers the push
channel added in migration 043:

  * set_push_token: upsert APNs/FCM token onto an existing active row
  * find_push_targets: partial-index lookup with the soft-disable cap
  * clear_push_token: terminal-failure response (BadDeviceToken etc.)
  * bump_push_failure: transient-failure counter that feeds the cap
"""

from __future__ import annotations

import pytest

from pinai_agents.web.db.repositories.devices import DevicesRepository
from pinai_agents.web.db.rls import user_scoped_tx

# Long enough to satisfy the >= 16 char minimum in set_push_token;
# real APNs device tokens are 64 hex chars but the repo only enforces a
# lower bound.
_TOKEN_A = "apns-device-token-" + "a" * 64
_TOKEN_B = "apns-device-token-" + "b" * 64


async def _register(repo: DevicesRepository, device_id: str) -> None:
    await repo.register(
        device_id=device_id, platform="ios",
        display_name="Test iPhone", model="iPhone15,3",
    )


@pytest.mark.asyncio
async def test_set_push_token_upserts_onto_existing_row(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        await _register(repo, "device-aaaaaaaa")
        row = await repo.set_push_token(
            device_id="device-aaaaaaaa",
            push_token=_TOKEN_A, push_provider="apns",
        )
    assert row is not None
    assert row.push_token == _TOKEN_A
    assert row.push_provider == "apns"
    assert row.push_token_updated_at is not None
    assert row.push_failure_count == 0


@pytest.mark.asyncio
async def test_set_push_token_resets_failure_count(pool, user_ids):
    """A fresh registration revives a previously-soft-disabled token —
    push_failure_count drops back to 0."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        await _register(repo, "device-aaaaaaaa")
        await repo.set_push_token(
            device_id="device-aaaaaaaa",
            push_token=_TOKEN_A, push_provider="apns",
        )
        await repo.bump_push_failure("device-aaaaaaaa")
        await repo.bump_push_failure("device-aaaaaaaa")
        # Re-register with a fresh token (e.g. iOS rotated APNs token).
        row = await repo.set_push_token(
            device_id="device-aaaaaaaa",
            push_token=_TOKEN_B, push_provider="apns",
        )
    assert row is not None
    assert row.push_token == _TOKEN_B
    assert row.push_failure_count == 0


@pytest.mark.asyncio
async def test_set_push_token_returns_none_for_unknown_device(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        result = await repo.set_push_token(
            device_id="device-does-not-exist",
            push_token=_TOKEN_A, push_provider="apns",
        )
    assert result is None


@pytest.mark.asyncio
async def test_set_push_token_rejects_bad_provider(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        await _register(repo, "device-aaaaaaaa")
        with pytest.raises(ValueError, match="unsupported push_provider"):
            await repo.set_push_token(
                device_id="device-aaaaaaaa",
                push_token=_TOKEN_A, push_provider="ona-signal",
            )


@pytest.mark.asyncio
async def test_set_push_token_rejects_short_token(pool, user_ids):
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        await _register(repo, "device-aaaaaaaa")
        with pytest.raises(ValueError, match="push_token too short"):
            await repo.set_push_token(
                device_id="device-aaaaaaaa",
                push_token="too-short", push_provider="apns",
            )


@pytest.mark.asyncio
async def test_find_push_targets_returns_only_eligible_devices(pool, user_ids):
    """The send pipeline must see exactly the devices that are active,
    have a push token, and haven't been soft-disabled by repeated
    failures."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        # 1. Active with push token — eligible.
        await _register(repo, "device-eligible")
        await repo.set_push_token(
            device_id="device-eligible",
            push_token=_TOKEN_A, push_provider="apns",
        )
        # 2. Active without push token — excluded.
        await _register(repo, "device-no-token")
        # 3. Active, push token present, but failure count over threshold.
        await _register(repo, "device-burned")
        await repo.set_push_token(
            device_id="device-burned",
            push_token=_TOKEN_B, push_provider="apns",
        )
        for _ in range(5):  # cross _PUSH_FAILURE_THRESHOLD (=5)
            await repo.bump_push_failure("device-burned")
        # 4. Revoked with token — excluded.
        await _register(repo, "device-revoked")
        await repo.set_push_token(
            device_id="device-revoked",
            push_token=_TOKEN_A, push_provider="apns",
        )
        await repo.revoke("device-revoked")

        targets = await repo.find_push_targets()
    assert [t.device_id for t in targets] == ["device-eligible"]


@pytest.mark.asyncio
async def test_clear_push_token_strips_push_fields(pool, user_ids):
    """Terminal APNs failure → caller clears the token, but the device
    row stays active (device_token_hash for auth is untouched)."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        await _register(repo, "device-aaaaaaaa")
        await repo.set_push_token(
            device_id="device-aaaaaaaa",
            push_token=_TOKEN_A, push_provider="apns",
        )
        await repo.bump_push_failure("device-aaaaaaaa")
        cleared = await repo.clear_push_token("device-aaaaaaaa")
        assert cleared is True

        rows = await repo.list_active()
    assert len(rows) == 1
    assert rows[0].device_id == "device-aaaaaaaa"
    assert rows[0].push_token is None
    assert rows[0].push_provider is None
    assert rows[0].push_token_updated_at is None
    assert rows[0].push_failure_count == 0
    assert rows[0].status == "active"


@pytest.mark.asyncio
async def test_push_targets_isolated_across_users(pool, user_ids):
    """RLS sanity: user_a's push targets must not leak into user_b's
    find_push_targets result. find_push_targets only filters by
    user_id but runs under a user-scoped tx (app.user_id set), so the
    RLS policy on pai_user_devices is the actual fence."""
    user_a, user_b = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        repo = DevicesRepository(user_a, conn)
        await _register(repo, "device-aaaaaaaa")
        await repo.set_push_token(
            device_id="device-aaaaaaaa",
            push_token=_TOKEN_A, push_provider="apns",
        )

    async with user_scoped_tx(pool, user_b) as conn:
        targets = await DevicesRepository(user_b, conn).find_push_targets()
    assert targets == []
