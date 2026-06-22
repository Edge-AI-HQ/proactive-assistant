"""Webhook helpers — _user_id_from_metadata / _attr / _pending_from_stripe_metadata
and a focused integration check of _handle_invoice_paid's pending-plan-code
priority order.

The pending-plan-code lookup is the cross-environment SSOT for plan
switches: a switch scheduled on one backend must be visible to a webhook
processed on a different backend (see checkout.create_or_change_subscription
+ webhook._handle_invoice_paid). The tests below pin that priority order
(Stripe metadata > local DB) plus the post-promote cleanup behavior.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from pinai_api.domains.billing.payments import budget_periods, checkout, plans, subscriptions
from pinai_api.domains.billing.payments import webhook as webhook_mod
from pinai_api.domains.billing.payments.webhook import (
    _attr,
    _handle_invoice_paid,
    _pending_from_stripe_metadata,
    _resolve_user_id_for_event,
    _user_id_from_metadata,
)


@pytest.fixture
def stub_find(monkeypatch):
    """Stand in for subscriptions.find_user_by_supabase_user_id. The
    helper hits the users table by UUID; tests stub that with a dict
    map so we exercise the metadata-parsing branches without a DB."""
    mapping: dict[str, int] = {}

    async def fake_find(conn, supabase_uuid: str) -> int | None:
        return mapping.get(supabase_uuid)

    monkeypatch.setattr(
        subscriptions,
        "find_user_by_supabase_user_id",
        AsyncMock(side_effect=fake_find),
    )
    return mapping


@pytest.mark.asyncio
async def test_user_id_from_metadata_resolves_via_supabase_uuid(stub_find):
    stub_find["u-abc"] = 42
    obj = SimpleNamespace(
        metadata={
            "supabase_user_id": "u-abc",
            "internal_user_id": "42",  # debug-only; never trusted
        }
    )
    assert await _user_id_from_metadata(None, obj) == 42


@pytest.mark.asyncio
async def test_user_id_from_metadata_unknown_uuid_returns_none(stub_find):
    obj = SimpleNamespace(metadata={"supabase_user_id": "u-missing"})
    assert await _user_id_from_metadata(None, obj) is None


@pytest.mark.asyncio
async def test_user_id_from_metadata_missing_uuid_returns_none(stub_find):
    """Without supabase_user_id we cannot safely resolve the user —
    falling back to internal_user_id would cross-env-pollute, see
    AGENTS.md '用户标识规约'."""
    obj = SimpleNamespace(metadata={"internal_user_id": "42"})
    assert await _user_id_from_metadata(None, obj) is None


@pytest.mark.asyncio
async def test_user_id_from_metadata_no_metadata_returns_none(stub_find):
    obj = SimpleNamespace()
    assert await _user_id_from_metadata(None, obj) is None


def test_attr_works_on_namespace_and_dict():
    ns = SimpleNamespace(x=1)
    d = {"x": 1}
    assert _attr(ns, "x") == 1
    assert _attr(d, "x") == 1
    assert _attr(None, "x") is None
    assert _attr({}, "missing") is None


@pytest.mark.asyncio
async def test_resolve_user_id_for_event_drills_through_event_data_object(
    stub_find,
):
    stub_find["u-7"] = 7
    event = SimpleNamespace(
        id="evt_x",
        type="checkout.session.completed",
        data=SimpleNamespace(
            object=SimpleNamespace(
                metadata={"supabase_user_id": "u-7"},
            )
        ),
    )
    assert await _resolve_user_id_for_event(None, event) == 7


# ── _pending_from_stripe_metadata (pure logic) ──


def test_pending_metadata_returns_value_when_set():
    sub = SimpleNamespace(metadata={"pending_plan_code": "max"})
    assert _pending_from_stripe_metadata(sub) == "max"


def test_pending_metadata_empty_string_treated_as_none():
    """Stripe convention: empty string unsets a metadata key. Callers
    branch on `is None`, so empty-string must not look 'present'."""
    sub = SimpleNamespace(metadata={"pending_plan_code": ""})
    assert _pending_from_stripe_metadata(sub) is None


def test_pending_metadata_missing_key_returns_none():
    sub = SimpleNamespace(metadata={"supabase_user_id": "u-1"})
    assert _pending_from_stripe_metadata(sub) is None


def test_pending_metadata_no_metadata_attr_returns_none():
    assert _pending_from_stripe_metadata(SimpleNamespace()) is None


def test_pending_metadata_works_on_dict_payload():
    """Stripe-py StripeObject is dict-like — mirror the same accommodation
    _user_id_from_metadata makes for raw-dict event payloads."""
    sub = {"metadata": {"pending_plan_code": "basic"}}
    assert _pending_from_stripe_metadata(sub) == "basic"


# ── _handle_invoice_paid: pending resolution priority ──
#
# These pin the cross-environment SSOT contract: switch scheduled on
# backend A + invoice.paid handled on backend B must still resolve the
# pending plan, because Stripe.metadata is the only place both backends
# see. Without this, backend B falls back to Stripe.items[0].price which
# is already the next-cycle price → DB gets promoted one cycle early
# (the original bug).


def _sub_row(*, pending: str | None, plan: str = "pro") -> subscriptions.SubscriptionRow:
    now = datetime.now(UTC)
    return subscriptions.SubscriptionRow(
        user_id=42,
        stripe_customer_id="cus_x",
        stripe_subscription_id="sub_y",
        plan_code=plan,
        pending_plan_code=pending,
        status="active",
        current_period_start=now,
        current_period_end=now,
        cancel_at_period_end=False,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture
def invoice_paid_harness(monkeypatch):
    """Stub every collaborator _handle_invoice_paid touches so the test
    isolates the pending-resolution + cleanup logic. Per-case the tests
    mutate `fresh_sub.metadata` and `sub_row_container["row"]` to drive
    the branch under test."""
    fresh_sub = SimpleNamespace(
        id="sub_y",
        customer="cus_x",
        status="active",
        cancel_at_period_end=False,
        current_period_start=1730000000,
        current_period_end=1732678400,
        metadata={},
    )
    sub_row_container = {"row": _sub_row(pending=None)}

    stripe_modify = MagicMock()
    fake_stripe = SimpleNamespace(
        Subscription=SimpleNamespace(
            retrieve=MagicMock(return_value=fresh_sub),
            modify=stripe_modify,
        ),
    )
    monkeypatch.setattr(webhook_mod, "requires_stripe", lambda: fake_stripe)

    monkeypatch.setattr(
        subscriptions,
        "find_user_by_stripe_subscription",
        AsyncMock(return_value=42),
    )
    monkeypatch.setattr(
        webhook_mod,
        "_plan_code_for_subscription",
        AsyncMock(return_value="pro"),  # Stripe items currently 'pro'
    )

    async def fake_get_for_user(conn, user_id):
        return sub_row_container["row"]

    monkeypatch.setattr(subscriptions, "get_for_user", fake_get_for_user)

    sync_mock = AsyncMock()
    monkeypatch.setattr(
        subscriptions,
        "sync_from_stripe_subscription",
        sync_mock,
    )
    clear_mock = AsyncMock()
    monkeypatch.setattr(
        subscriptions,
        "clear_pending_plan_code",
        clear_mock,
    )

    # invoice.paid rolls the budget window: recompute (mocked) raises the cap,
    # set_period_end (mocked) marks the window for the reconcile tick. Both are
    # out of scope for the pending-resolution tests but must not hit the DB.
    recompute_mock = AsyncMock()
    monkeypatch.setattr(checkout, "recompute_litellm_budget", recompute_mock)
    period_mock = AsyncMock()
    monkeypatch.setattr(budget_periods, "set_period_end", period_mock)
    monkeypatch.setattr(plans, "find_by_code", AsyncMock(return_value=None))

    return SimpleNamespace(
        fresh_sub=fresh_sub,
        sub_row_container=sub_row_container,
        sync_mock=sync_mock,
        clear_mock=clear_mock,
        stripe_modify=stripe_modify,
        recompute_mock=recompute_mock,
        period_mock=period_mock,
    )


def _invoice(sub_id: str = "sub_y") -> SimpleNamespace:
    return SimpleNamespace(id="in_test", subscription=sub_id, customer="cus_x")


@pytest.mark.asyncio
async def test_invoice_paid_prefers_stripe_metadata_over_db(invoice_paid_harness):
    """The bug fix: cross-backend schedule → cloud webhook → pending must
    come from Stripe metadata, not (stale or absent) DB row."""
    invoice_paid_harness.fresh_sub.metadata = {"pending_plan_code": "max"}
    invoice_paid_harness.sub_row_container["row"] = _sub_row(pending="basic")

    await _handle_invoice_paid(conn=None, invoice=_invoice())

    invoice_paid_harness.sync_mock.assert_awaited_once()
    _, kwargs = invoice_paid_harness.sync_mock.await_args
    assert kwargs["plan_code"] == "max"
    invoice_paid_harness.clear_mock.assert_awaited_once_with(None, 42)
    invoice_paid_harness.stripe_modify.assert_called_once_with(
        "sub_y",
        metadata={"pending_plan_code": ""},
    )


@pytest.mark.asyncio
async def test_invoice_paid_falls_back_to_db_pending(invoice_paid_harness):
    """Legacy path: subscription scheduled before this rolled out has no
    metadata yet — DB pending_plan_code must still be honored."""
    invoice_paid_harness.fresh_sub.metadata = {}
    invoice_paid_harness.sub_row_container["row"] = _sub_row(pending="max")

    await _handle_invoice_paid(conn=None, invoice=_invoice())

    _, kwargs = invoice_paid_harness.sync_mock.await_args
    assert kwargs["plan_code"] == "max"
    invoice_paid_harness.clear_mock.assert_awaited_once_with(None, 42)
    invoice_paid_harness.stripe_modify.assert_called_once()


@pytest.mark.asyncio
async def test_invoice_paid_empty_metadata_falls_back_to_db(invoice_paid_harness):
    """Empty-string metadata is Stripe's 'unset' signal — must not be
    treated as a real pending value."""
    invoice_paid_harness.fresh_sub.metadata = {"pending_plan_code": ""}
    invoice_paid_harness.sub_row_container["row"] = _sub_row(pending="basic")

    await _handle_invoice_paid(conn=None, invoice=_invoice())

    _, kwargs = invoice_paid_harness.sync_mock.await_args
    assert kwargs["plan_code"] == "basic"


@pytest.mark.asyncio
async def test_invoice_paid_no_pending_uses_stripe_plan_code(invoice_paid_harness):
    """No scheduled switch anywhere — plain renewal. plan_code comes from
    Stripe items[0].price (mocked 'pro'). No cleanup call expected."""
    invoice_paid_harness.fresh_sub.metadata = {}
    invoice_paid_harness.sub_row_container["row"] = _sub_row(pending=None)

    await _handle_invoice_paid(conn=None, invoice=_invoice())

    _, kwargs = invoice_paid_harness.sync_mock.await_args
    assert kwargs["plan_code"] == "pro"
    invoice_paid_harness.clear_mock.assert_not_awaited()
    invoice_paid_harness.stripe_modify.assert_not_called()


@pytest.mark.asyncio
async def test_invoice_paid_metadata_cleanup_failure_does_not_break_webhook(
    invoice_paid_harness,
):
    """If the post-promote Stripe.modify fails (network blip / rate limit),
    the webhook must still complete — DB is already consistent. Worst case
    next renewal re-detects+re-promotes (idempotent) and retries cleanup."""
    invoice_paid_harness.fresh_sub.metadata = {"pending_plan_code": "max"}
    invoice_paid_harness.sub_row_container["row"] = _sub_row(pending="max")
    invoice_paid_harness.stripe_modify.side_effect = RuntimeError("Stripe down")

    await _handle_invoice_paid(conn=None, invoice=_invoice())  # must NOT raise

    _, kwargs = invoice_paid_harness.sync_mock.await_args
    assert kwargs["plan_code"] == "max"
    invoice_paid_harness.clear_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_invoice_paid_skips_upgrade_delta_invoice(invoice_paid_harness):
    """The one-off difference charge from an immediate upgrade is tagged
    metadata.kind='upgrade_delta'. It is NOT a renewal — _handle_invoice_paid
    must short-circuit so it doesn't reset spend or re-promote a plan."""
    delta_invoice = SimpleNamespace(
        id="in_upgrade_delta",
        subscription="sub_y",
        customer="cus_x",
        metadata={"kind": "upgrade_delta"},
    )

    await _handle_invoice_paid(conn=None, invoice=delta_invoice)

    invoice_paid_harness.sync_mock.assert_not_awaited()
    invoice_paid_harness.clear_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_invoice_paid_rolls_window_and_keeps_spend(invoice_paid_harness):
    """On renewal, invoice.paid raises the cap immediately (recompute with
    reset_spend=False — KEEP spend so the reconcile can attribute the closing
    window) and marks period_end=NOW() so the reconcile tick rolls the window
    (the reconcile, not invoice.paid, owns the spend reset)."""
    invoice_paid_harness.fresh_sub.metadata = {}
    invoice_paid_harness.sub_row_container["row"] = _sub_row(pending=None)

    await _handle_invoice_paid(conn=None, invoice=_invoice())

    invoice_paid_harness.recompute_mock.assert_awaited_once()
    _, kwargs = invoice_paid_harness.recompute_mock.await_args
    assert kwargs["reset_spend"] is False
    invoice_paid_harness.period_mock.assert_awaited_once()


@pytest.mark.asyncio
async def test_cancel_to_free_keeps_credits(monkeypatch):
    """A terminal cancel demotes to Free via recompute (reset_spend=False) —
    which re-adds the user's active credit grants on top of the Free allowance,
    so purchased credits survive cancel — and rolls the window for reconcile."""
    monkeypatch.setattr(webhook_mod, "_user_id_from_metadata", AsyncMock(return_value=42))
    monkeypatch.setattr(webhook_mod, "_plan_code_for_subscription", AsyncMock(return_value="free"))
    fresh = SimpleNamespace(status="canceled")
    monkeypatch.setattr(
        webhook_mod,
        "requires_stripe",
        lambda: SimpleNamespace(
            Subscription=SimpleNamespace(retrieve=MagicMock(return_value=fresh))
        ),
    )
    monkeypatch.setattr(subscriptions, "sync_from_stripe_subscription", AsyncMock())
    ensure_free = AsyncMock()
    monkeypatch.setattr(checkout, "ensure_user_free_subscription", ensure_free)
    set_end = AsyncMock()
    monkeypatch.setattr(budget_periods, "set_period_end", set_end)
    recompute = AsyncMock()
    monkeypatch.setattr(checkout, "recompute_litellm_budget", recompute)

    sub = SimpleNamespace(id="sub_x", customer="cus_x", metadata={"supabase_user_id": "u"})
    await webhook_mod._handle_subscription_event(None, sub)

    ensure_free.assert_awaited_once()
    set_end.assert_awaited_once()
    recompute.assert_awaited_once()
    _, kwargs = recompute.await_args
    assert kwargs["reset_spend"] is False
