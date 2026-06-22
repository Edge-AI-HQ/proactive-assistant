from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from pinai_api.domains.billing.payments import checkout as checkout_mod


def _plan(code: str, price_cents: int, credits: int):
    return SimpleNamespace(
        plan_code=code,
        price_cents_monthly=price_cents,
        monthly_refresh_credits=credits,
        stripe_price_id=f"price_{code}",
    )


def _existing_sub():
    return SimpleNamespace(
        stripe_subscription_id="sub_y",
        stripe_customer_id="cus_x",
        plan_code="basic",
        pending_plan_code=None,
        status="active",
    )


class _FakeTx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *args):
        return False


@pytest.fixture
def upgrade_harness(monkeypatch):
    period_start = datetime(2026, 6, 20, 12, 0, tzinfo=UTC)
    period_end = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
    modified_subscription = SimpleNamespace(
        id="sub_y",
        customer="cus_x",
        status="active",
        current_period_start=int(period_start.timestamp()),
        current_period_end=int(period_end.timestamp()),
        cancel_at_period_end=False,
    )
    paid_invoice = SimpleNamespace(id="in_x", status="paid")
    stripe = SimpleNamespace(
        InvoiceItem=SimpleNamespace(create=MagicMock()),
        Invoice=SimpleNamespace(
            create=MagicMock(return_value=SimpleNamespace(id="in_x", status="draft")),
            finalize_invoice=MagicMock(return_value=SimpleNamespace(id="in_x", status="open")),
            pay=MagicMock(return_value=paid_invoice),
            void_invoice=MagicMock(),
        ),
        Subscription=SimpleNamespace(modify=MagicMock(return_value=modified_subscription)),
    )
    monkeypatch.setattr(checkout_mod, "requires_stripe", lambda: stripe)
    monkeypatch.setattr(checkout_mod, "get_subscription_item_id", lambda _sid: "si_x")
    monkeypatch.setattr(checkout_mod, "service_tx", lambda _pool: _FakeTx(object()))
    monkeypatch.setattr(checkout_mod, "_now_utc", lambda: period_start, raising=False)
    anchor_mock = AsyncMock(return_value=(Decimal("12.34"), None))
    monkeypatch.setattr(
        checkout_mod,
        "_read_litellm_anchor_for_user",
        anchor_mock,
        raising=False,
    )

    sync_mock = AsyncMock()
    clear_mock = AsyncMock()
    monkeypatch.setattr(checkout_mod.subs_repo, "sync_from_stripe_subscription", sync_mock)
    monkeypatch.setattr(checkout_mod.subs_repo, "clear_pending_plan_code", clear_mock)
    budget_mock = AsyncMock()
    monkeypatch.setattr(checkout_mod, "sync_litellm_budget_for_plan", budget_mock)
    credits_mock = AsyncMock(return_value=0)
    monkeypatch.setattr(checkout_mod.grants_repo, "sum_active_remaining_cents", credits_mock)
    reanchor_mock = AsyncMock()
    monkeypatch.setattr(
        checkout_mod.periods_repo,
        "reanchor_open_period_for_upgrade",
        reanchor_mock,
        raising=False,
    )

    return SimpleNamespace(
        stripe=stripe,
        sync_mock=sync_mock,
        clear_mock=clear_mock,
        budget_mock=budget_mock,
        reanchor_mock=reanchor_mock,
        period_start=period_start,
        period_end=period_end,
    )


@pytest.mark.asyncio
async def test_immediate_upgrade_charges_flat_difference_and_promotes(upgrade_harness):
    user = SimpleNamespace(id=42, supabase_user_id="u-abc", email="a@b.c")
    result = await checkout_mod._apply_immediate_upgrade(
        pool=None,
        user=user,
        existing_sub=_existing_sub(),
        current_plan=_plan("basic", 3900, 3900),
        target_plan=_plan("pro", 9900, 9900),
    )

    _, item_kwargs = upgrade_harness.stripe.InvoiceItem.create.call_args
    assert item_kwargs["amount"] == 6000
    assert item_kwargs["metadata"]["kind"] == "upgrade_delta"
    # The one-off item MUST be attached to the invoice explicitly, else
    # Invoice.create leaves it off and the upgrade charges $0.
    assert item_kwargs["invoice"] == "in_x"

    _, mod_kwargs = upgrade_harness.stripe.Subscription.modify.call_args
    assert mod_kwargs["proration_behavior"] == "none"
    assert "billing_cycle_anchor" not in mod_kwargs
    assert mod_kwargs["trial_end"] == int(upgrade_harness.period_end.timestamp())

    _, sync_kwargs = upgrade_harness.sync_mock.await_args
    assert sync_kwargs["plan_code"] == "pro"
    assert sync_kwargs["update_plan_code"] is True
    _, reanchor_kwargs = upgrade_harness.reanchor_mock.await_args
    assert reanchor_kwargs["user_id"] == 42
    assert reanchor_kwargs["plan_code"] == "pro"
    assert reanchor_kwargs["allowance_cents"] == 9900
    assert reanchor_kwargs["period_start"] == upgrade_harness.period_start
    assert reanchor_kwargs["period_end"] == upgrade_harness.period_end
    assert reanchor_kwargs["opening_litellm_spend"] == Decimal("12.34")
    assert reanchor_kwargs["max_budget_cents_at_open"] == 9900

    _, budget_kwargs = upgrade_harness.budget_mock.await_args
    assert budget_kwargs["reset_spend"] is False

    assert result["flow"] == "upgrade"
    assert result["applied"] is True


@pytest.mark.asyncio
async def test_immediate_upgrade_skips_pay_when_finalize_already_paid(upgrade_harness):
    """finalize_invoice auto-settles some invoices straight to 'paid'; calling
    pay() again raises 'Invoice is already paid'. The helper must skip pay()
    when the invoice is already paid (regression guard for that real Stripe
    behavior)."""
    upgrade_harness.stripe.Invoice.finalize_invoice.return_value = SimpleNamespace(
        id="in_x", status="paid"
    )
    user = SimpleNamespace(id=42, supabase_user_id="u-abc", email="a@b.c")

    result = await checkout_mod._apply_immediate_upgrade(
        pool=None,
        user=user,
        existing_sub=_existing_sub(),
        current_plan=_plan("basic", 3900, 3900),
        target_plan=_plan("pro", 9900, 9900),
    )

    upgrade_harness.stripe.Invoice.pay.assert_not_called()
    assert result["flow"] == "upgrade"
    assert result["applied"] is True


@pytest.mark.asyncio
async def test_immediate_upgrade_aborts_when_payment_fails(upgrade_harness):
    upgrade_harness.stripe.Invoice.pay.side_effect = RuntimeError("card_declined")
    user = SimpleNamespace(id=42, supabase_user_id="u-abc", email="a@b.c")

    with pytest.raises(HTTPException) as exc:
        await checkout_mod._apply_immediate_upgrade(
            pool=None,
            user=user,
            existing_sub=_existing_sub(),
            current_plan=_plan("basic", 3900, 3900),
            target_plan=_plan("pro", 9900, 9900),
        )

    assert exc.value.status_code == 402
    upgrade_harness.stripe.Subscription.modify.assert_not_called()
    upgrade_harness.sync_mock.assert_not_awaited()
    upgrade_harness.budget_mock.assert_not_awaited()
    upgrade_harness.stripe.Invoice.void_invoice.assert_called_once()


@pytest.mark.asyncio
async def test_create_or_change_routes_upgrade_to_immediate(monkeypatch):
    """Upgrade direction must call _apply_immediate_upgrade; the deferred
    pending path must NOT run for an upgrade."""
    applied = AsyncMock(return_value={"flow": "upgrade", "applied": True})
    monkeypatch.setattr(checkout_mod, "_apply_immediate_upgrade", applied)

    async def fake_find_by_code(conn, code):
        prices = {"basic": 3900, "pro": 9900, "max": 19900}
        return _plan(code, prices[code], prices[code])

    monkeypatch.setattr(checkout_mod.plans_repo, "find_by_code", fake_find_by_code)

    async def fake_get_for_user(conn, user_id):
        return _existing_sub()  # currently 'basic', modifiable, has stripe sub

    monkeypatch.setattr(checkout_mod.subs_repo, "get_for_user", fake_get_for_user)
    monkeypatch.setattr(checkout_mod, "user_scoped_tx", lambda _p, _u: _FakeTx(object()))
    monkeypatch.setattr(checkout_mod, "requires_stripe", lambda: SimpleNamespace())
    monkeypatch.setattr(
        checkout_mod, "get_web_settings", lambda: SimpleNamespace(payment_public_base_url="")
    )

    user = SimpleNamespace(id=42, supabase_user_id="u-abc", email="a@b.c")
    result = await checkout_mod.create_or_change_subscription(None, user=user, plan_code="pro")

    applied.assert_awaited_once()
    assert result["flow"] == "upgrade"
