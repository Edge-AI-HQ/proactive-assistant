"""Tests for the Phase 2 credit topup flow: create_topup_checkout (mocked
Stripe), the webhook grant landing (real DB, idempotent on PaymentIntent),
and claim_event re-claiming 'failed' rows after the claim-tx split.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from pinai_api.domains.billing.payments import budget_periods as periods_repo
from pinai_api.domains.billing.payments import checkout as checkout_mod
from pinai_api.domains.billing.payments import credit_grants as grants_repo
from pinai_api.domains.billing.payments import webhook as webhook_mod
from pinai_db.rls import service_tx

pytestmark = pytest.mark.asyncio


def _user():
    return SimpleNamespace(id=42, supabase_user_id=str(uuid.uuid4()), email="a@b.c")


@pytest.fixture
def topup_checkout_harness(monkeypatch):
    session = SimpleNamespace(url="https://stripe.test/cs", id="cs_topup")
    stripe = SimpleNamespace(
        checkout=SimpleNamespace(Session=SimpleNamespace(create=MagicMock(return_value=session)))
    )
    monkeypatch.setattr(checkout_mod, "requires_stripe", lambda: stripe)
    monkeypatch.setattr(checkout_mod, "ensure_stripe_customer", AsyncMock(return_value="cus_x"))
    monkeypatch.setattr(
        checkout_mod,
        "get_web_settings",
        lambda: SimpleNamespace(payment_public_base_url="https://app.test"),
    )
    return SimpleNamespace(create=stripe.checkout.Session.create)


async def test_create_topup_checkout_uses_payment_mode_dynamic_price(topup_checkout_harness):
    result = await checkout_mod.create_topup_checkout(None, user=_user(), amount_cents=5000)

    _, kw = topup_checkout_harness.create.call_args
    assert kw["mode"] == "payment"
    assert kw["line_items"][0]["price_data"]["unit_amount"] == 5000
    assert kw["line_items"][0]["price_data"]["currency"] == "usd"
    assert kw["metadata"]["kind"] == "topup"
    assert kw["metadata"]["credit_cents"] == "5000"
    # metadata also rides on the PaymentIntent so the webhook can read it back
    assert kw["payment_intent_data"]["metadata"]["kind"] == "topup"
    assert "subscription_data" not in kw  # payment mode rejects it
    assert result["flow"] == "topup"


async def test_create_topup_checkout_preserves_success_url_query(topup_checkout_harness):
    await checkout_mod.create_topup_checkout(
        None,
        user=_user(),
        amount_cents=5000,
        success_url_override="https://app.test/?topup=success",
    )

    _, kw = topup_checkout_harness.create.call_args
    assert kw["success_url"] == "https://app.test/?topup=success&session_id={CHECKOUT_SESSION_ID}"


async def test_payment_methods_falls_back_to_recent_topup_charge(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    pi_id = f"pi_{uuid.uuid4().hex[:12]}"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT supabase_user_id FROM users WHERE id = %s",
            (user_a,),
        )
        supabase_user_id = str((await cur.fetchone())["supabase_user_id"])
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=supabase_user_id,
            grant_cents=7500,
            expires_at=datetime(2027, 6, 17, tzinfo=UTC),
            stripe_payment_intent_id=pi_id,
        )
        await conn.execute(
            "UPDATE users SET stripe_customer_id = 'cus_topup' WHERE id = %s",
            (user_a,),
        )

    payment_intent = SimpleNamespace(
        id=pi_id,
        latest_charge=SimpleNamespace(
            id="ch_topup",
            payment_method_details=SimpleNamespace(
                type="card",
                card=SimpleNamespace(brand="visa", last4="4242", exp_month=12, exp_year=2030),
            ),
        ),
    )
    stripe = SimpleNamespace(
        Customer=SimpleNamespace(
            retrieve=MagicMock(return_value=SimpleNamespace(invoice_settings=SimpleNamespace())),
            list_payment_methods=MagicMock(return_value=SimpleNamespace(data=[])),
        ),
        Subscription=SimpleNamespace(list=MagicMock(return_value=SimpleNamespace(data=[]))),
        PaymentIntent=SimpleNamespace(retrieve=MagicMock(return_value=payment_intent)),
    )
    monkeypatch.setattr(checkout_mod, "requires_stripe", lambda: stripe)

    result = await checkout_mod.list_payment_methods_for_user(
        pool,
        user=SimpleNamespace(id=user_a),
    )

    assert result["items"] == [
        {
            "id": "ch_topup",
            "type": "card",
            "isDefault": True,
            "isSaved": False,
            "source": "checkout",
            "brand": "visa",
            "last4": "4242",
            "expMonth": 12,
            "expYear": 2030,
            "linkEmail": None,
        }
    ]


async def test_payment_methods_falls_back_to_checkout_link_with_user_email(
    pool, user_ids, monkeypatch
):
    user_a, _ = user_ids
    pi_id = f"pi_{uuid.uuid4().hex[:12]}"

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT supabase_user_id FROM users WHERE id = %s",
            (user_a,),
        )
        supabase_user_id = str((await cur.fetchone())["supabase_user_id"])
        await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=supabase_user_id,
            grant_cents=7500,
            expires_at=datetime(2027, 6, 17, tzinfo=UTC),
            stripe_payment_intent_id=pi_id,
        )
        await conn.execute(
            "UPDATE users SET stripe_customer_id = 'cus_topup' WHERE id = %s",
            (user_a,),
        )

    payment_intent = SimpleNamespace(
        id=pi_id,
        latest_charge=SimpleNamespace(
            id="ch_link_topup",
            payment_method_details=SimpleNamespace(
                type="link",
                link=SimpleNamespace(email=None),
            ),
        ),
    )
    stripe = SimpleNamespace(
        Customer=SimpleNamespace(
            retrieve=MagicMock(return_value=SimpleNamespace(invoice_settings=SimpleNamespace())),
            list_payment_methods=MagicMock(return_value=SimpleNamespace(data=[])),
        ),
        Subscription=SimpleNamespace(list=MagicMock(return_value=SimpleNamespace(data=[]))),
        PaymentIntent=SimpleNamespace(retrieve=MagicMock(return_value=payment_intent)),
    )
    monkeypatch.setattr(checkout_mod, "requires_stripe", lambda: stripe)

    result = await checkout_mod.list_payment_methods_for_user(
        pool,
        user=SimpleNamespace(id=user_a, email="liam.yu0301@gmail.com"),
    )

    assert result["items"] == [
        {
            "id": "ch_link_topup",
            "type": "link",
            "isDefault": True,
            "isSaved": False,
            "source": "checkout",
            "brand": None,
            "last4": None,
            "expMonth": None,
            "expYear": None,
            "linkEmail": "liam.yu0301@gmail.com",
        }
    ]


async def test_payment_history_includes_topup_grants(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    pi_id = f"pi_{uuid.uuid4().hex[:12]}"
    granted_at = datetime(2026, 6, 17, 21, 52, 14, tzinfo=UTC)

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT supabase_user_id FROM users WHERE id = %s",
            (user_a,),
        )
        supabase_user_id = str((await cur.fetchone())["supabase_user_id"])
        grant_id = await grants_repo.insert_topup_grant(
            conn,
            user_id=user_a,
            supabase_user_id=supabase_user_id,
            grant_cents=7500,
            expires_at=datetime(2027, 6, 17, tzinfo=UTC),
            stripe_payment_intent_id=pi_id,
        )
        await conn.execute(
            "UPDATE pai_credit_grants SET granted_at = %s WHERE id = %s",
            (granted_at, grant_id),
        )

    stripe = SimpleNamespace(
        Invoice=SimpleNamespace(list=MagicMock(return_value=SimpleNamespace(data=[])))
    )
    monkeypatch.setattr(checkout_mod, "requires_stripe", lambda: stripe)

    result = await checkout_mod.list_payment_history_for_user(
        pool,
        user=SimpleNamespace(id=user_a),
        limit=12,
    )

    assert result["items"] == [
        {
            "id": str(grant_id),
            "kind": "topup",
            "status": "paid",
            "amountPaidCents": 7500,
            "currency": "usd",
            "description": "PIN AI credits",
            "createdAt": int(granted_at.timestamp()),
            "hostedInvoiceUrl": None,
            "pdfUrl": None,
        }
    ]


@pytest.mark.parametrize("amount", [100, 200_000])
async def test_create_topup_checkout_rejects_out_of_bounds(topup_checkout_harness, amount):
    with pytest.raises(HTTPException) as exc:
        await checkout_mod.create_topup_checkout(None, user=_user(), amount_cents=amount)
    assert exc.value.status_code == 400
    topup_checkout_harness.create.assert_not_called()


async def test_webhook_topup_grant_is_idempotent(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    recompute = AsyncMock(return_value=True)
    monkeypatch.setattr(checkout_mod, "recompute_litellm_budget", recompute)

    pi_id = f"pi_{uuid.uuid4().hex[:12]}"
    session = SimpleNamespace(id="cs_topup", payment_intent=pi_id)
    # No supabase_user_id in metadata → exercises the users-table fallback.
    meta = {"kind": "topup", "credit_cents": "5000"}

    async with service_tx(pool) as conn:
        await webhook_mod._handle_topup_completed(conn, session, user_a, meta)
    async with service_tx(pool) as conn:
        first_balance = await grants_repo.sum_active_remaining_cents(conn, user_a)
    # Stripe retry: same PaymentIntent → no second grant, no second recompute.
    async with service_tx(pool) as conn:
        await webhook_mod._handle_topup_completed(conn, session, user_a, meta)
    async with service_tx(pool) as conn:
        second_balance = await grants_repo.sum_active_remaining_cents(conn, user_a)

    assert first_balance == 5000
    assert second_balance == 5000  # idempotent — not doubled
    assert recompute.await_count == 1  # only the real insert recomputed


async def test_webhook_topup_grant_expires_12_months_after_current_period_end(
    monkeypatch,
):
    recompute = AsyncMock(return_value=True)
    monkeypatch.setattr(checkout_mod, "recompute_litellm_budget", recompute)
    period_end = datetime(2026, 7, 17, 12, 0, tzinfo=UTC)
    insert_grant = AsyncMock(return_value="grant-x")
    monkeypatch.setattr(grants_repo, "insert_topup_grant", insert_grant)
    monkeypatch.setattr(
        periods_repo,
        "get_open_period",
        AsyncMock(return_value=SimpleNamespace(period_end=period_end)),
    )

    pi_id = f"pi_{uuid.uuid4().hex[:12]}"
    session = SimpleNamespace(id="cs_topup", payment_intent=pi_id)
    meta = {
        "kind": "topup",
        "credit_cents": "5000",
        "supabase_user_id": str(uuid.uuid4()),
    }

    await webhook_mod._handle_topup_completed(conn=object(), session=session, user_id=42, meta=meta)

    _, kwargs = insert_grant.await_args
    assert kwargs["expires_at"] == datetime(2027, 7, 17, 12, 0, tzinfo=UTC)


async def test_claim_event_reclaims_failed_but_skips_processed(pool, user_ids, monkeypatch):
    user_a, _ = user_ids
    monkeypatch.setattr(webhook_mod, "_resolve_user_id_for_event", AsyncMock(return_value=user_a))
    monkeypatch.setattr(webhook_mod, "_event_to_dict", lambda e: {})
    event = SimpleNamespace(id=f"evt_{uuid.uuid4().hex[:10]}", type="invoice.paid")

    try:
        async with service_tx(pool) as conn:
            assert await webhook_mod.claim_event(conn, event) is True  # new
            assert await webhook_mod.claim_event(conn, event) is False  # in-flight 'claimed'
            await webhook_mod.mark_failed(conn, event.id, "boom")
            assert await webhook_mod.claim_event(conn, event) is True  # retry re-claims 'failed'
            await webhook_mod.mark_processed(conn, event.id)
            assert await webhook_mod.claim_event(conn, event) is False  # terminal — skip
    finally:
        async with service_tx(pool) as conn:
            await conn.execute(
                "DELETE FROM pai_stripe_webhook_events WHERE event_id = %s", (event.id,)
            )
