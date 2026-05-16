"""push_notifier — dispatch loop + payload shape + bookkeeping.

Two layers covered:

  * Pure-Python: _build_new_cards_payload (singular vs plural copy +
    collapse_key on the OS-level coalesce key). No fixtures needed.

  * DB-backed: notify_new_cards end-to-end with a fake transport. The
    real APNs call is replaced via monkeypatch so we exercise:
      - opt-out skip (settings.notify_new_cards = False)
      - no-targets skip (no device with push_token)
      - success path increments sent counter
      - terminal error → clear_push_token (token gone from row)
      - transient error → bump_push_failure (counter goes up)
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from pinai_agents.web.db.repositories.devices import DevicesRepository
from pinai_agents.web.db.repositories.profile import ProfileRepository
from pinai_agents.web.db.rls import user_scoped_tx
from pinai_agents.web.services import push_notifier
from pinai_agents.web.services.push_notifier import (
    PushPayload,
    PushResult,
    _build_new_cards_payload,
    notify_new_cards,
)

_TOKEN = "apns-device-token-" + "a" * 64


# ── pure-Python ──


def test_build_payload_singular_copy():
    payload = _build_new_cards_payload(card_count=1)
    assert payload.title == "新卡片生成"
    assert payload.body == "你有 1 张新的卡片"
    assert payload.deep_link == "app://cards"
    # collapse_key is the OS-level dedup signal — multiple runs squash
    # into one banner. Hard-coding it lets the test catch accidental
    # rename downstream (the iOS side reads apns-collapse-id header).
    assert payload.collapse_key == "new_cards"


def test_build_payload_plural_copy():
    payload = _build_new_cards_payload(card_count=3)
    assert payload.body == "你有 3 张新的卡片"


# ── DB-backed (fake transport) ──


@dataclass
class _Call:
    device_id: str
    push_token: str | None
    result: PushResult


class _FakeTransport:
    """Records every send() invocation and returns a scripted response.

    Lets us verify both the dispatch loop's selection (which devices
    are sent to) and its post-send bookkeeping (terminal vs transient
    branch into clear_push_token / bump_push_failure)."""

    def __init__(self, *, results: dict[str, PushResult] | None = None) -> None:
        # device_id → result. Devices not in the map default to ok.
        self._results = results or {}
        self.calls: list[_Call] = []

    async def send(self, *, device, payload: PushPayload) -> PushResult:  # noqa: ARG002
        result = self._results.get(device.device_id, PushResult(ok=True))
        self.calls.append(
            _Call(device_id=device.device_id,
                  push_token=device.push_token, result=result),
        )
        return result


async def _setup_user_with_push_device(
    pool, user_id: int, device_id: str, *, opt_in: bool,
) -> None:
    async with user_scoped_tx(pool, user_id) as conn:
        await ProfileRepository(user_id, conn).upsert_settings(
            notify_new_cards=opt_in,
        )
        devices = DevicesRepository(user_id, conn)
        await devices.register(
            device_id=device_id, platform="ios",
            display_name="Test iPhone",
        )
        await devices.set_push_token(
            device_id=device_id, push_token=_TOKEN, push_provider="apns",
        )


@pytest.mark.asyncio
async def test_notify_skips_when_opted_out(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    await _setup_user_with_push_device(pool, user_a, "device-aaa", opt_in=False)
    fake = _FakeTransport()
    monkeypatch.setattr(push_notifier, "_transport", fake)

    sent = await notify_new_cards(pool, user_id=user_a, card_count=2)
    assert sent == 0
    assert fake.calls == []  # never reached the transport


@pytest.mark.asyncio
async def test_notify_skips_when_no_push_targets(pool, user_ids, monkeypatch):
    """User opted in but never registered a push token. Pipeline must
    quietly exit, NOT crash on an empty target list."""
    user_a, _ = user_ids
    async with user_scoped_tx(pool, user_a) as conn:
        await ProfileRepository(user_a, conn).upsert_settings(notify_new_cards=True)
    fake = _FakeTransport()
    monkeypatch.setattr(push_notifier, "_transport", fake)

    sent = await notify_new_cards(pool, user_id=user_a, card_count=1)
    assert sent == 0
    assert fake.calls == []


@pytest.mark.asyncio
async def test_notify_sends_to_eligible_devices(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    await _setup_user_with_push_device(pool, user_a, "device-aaa", opt_in=True)
    fake = _FakeTransport()
    monkeypatch.setattr(push_notifier, "_transport", fake)

    sent = await notify_new_cards(pool, user_id=user_a, card_count=2)
    assert sent == 1
    assert len(fake.calls) == 1
    assert fake.calls[0].device_id == "device-aaa"
    assert fake.calls[0].push_token == _TOKEN


@pytest.mark.asyncio
async def test_notify_terminal_error_clears_push_token(pool, user_ids, monkeypatch):
    """APNs "BadDeviceToken" means this token will never deliver — the
    pipeline must strip the token from the row so subsequent runs don't
    re-attempt against a guaranteed-bad target."""
    user_a, _ = user_ids
    await _setup_user_with_push_device(pool, user_a, "device-aaa", opt_in=True)
    fake = _FakeTransport(results={
        "device-aaa": PushResult(ok=False, error_code="BadDeviceToken"),
    })
    monkeypatch.setattr(push_notifier, "_transport", fake)

    sent = await notify_new_cards(pool, user_id=user_a, card_count=1)
    assert sent == 0

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await DevicesRepository(user_a, conn).list_active()
    assert len(rows) == 1
    assert rows[0].push_token is None
    assert rows[0].push_provider is None


@pytest.mark.asyncio
async def test_notify_transient_error_bumps_failure_counter(
    pool, user_ids, monkeypatch,
):
    """Non-terminal error (e.g. APNs 5xx) → bump the counter. Token
    stays in place; the next run will retry. After enough strikes
    find_push_targets soft-disables the row."""
    user_a, _ = user_ids
    await _setup_user_with_push_device(pool, user_a, "device-aaa", opt_in=True)
    fake = _FakeTransport(results={
        "device-aaa": PushResult(ok=False, error_code="InternalServerError"),
    })
    monkeypatch.setattr(push_notifier, "_transport", fake)

    sent = await notify_new_cards(pool, user_id=user_a, card_count=1)
    assert sent == 0

    async with user_scoped_tx(pool, user_a) as conn:
        rows = await DevicesRepository(user_a, conn).list_active()
    assert len(rows) == 1
    assert rows[0].push_token == _TOKEN  # preserved
    assert rows[0].push_failure_count == 1


@pytest.mark.asyncio
async def test_notify_zero_cards_is_noop(pool, user_ids, monkeypatch):
    """Belt-and-braces: dispatcher already guards `if card_count > 0`,
    but the service must be safe on its own — a hot-path early return
    avoids needless DB reads for empty generator runs."""
    user_a, _ = user_ids
    await _setup_user_with_push_device(pool, user_a, "device-aaa", opt_in=True)
    fake = _FakeTransport()
    monkeypatch.setattr(push_notifier, "_transport", fake)

    sent = await notify_new_cards(pool, user_id=user_a, card_count=0)
    assert sent == 0
    assert fake.calls == []
