"""Stripe connector — extractor / mapper / DB round-trip.

Stripe wire format quirks: amounts are integer cents (NEVER float), the
`customer` field can be a string id or expanded dict, timestamps are
unix seconds. STRIPE_LIST_INVOICES returns merchant invoices — most
non-business users get an empty list.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from pinai_agents.web.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_agents.web.db.rls import service_tx, user_scoped_tx
from pinai_agents.web.services import connector_ingest

# ── Stripe mapper ──────────────────────────────────────────────────────


def test_map_stripe_invoice_basic():
    raw = {
        "id": "in_1",
        "number": "INV-001",
        "status": "open",
        "amount_due": 12500,
        "amount_paid": 0,
        "amount_remaining": 12500,
        "currency": "usd",
        "customer": "cus_abc",
        "customer_email": "buyer@x.com",
        "collection_method": "charge_automatically",
        "created": 1714521600,  # 2024-05-01 (unix)
        "due_date": 1717113600,  # 2024-05-31
        "hosted_invoice_url": "https://stripe.com/i/in_1",
        "invoice_pdf": "https://stripe.com/i/in_1.pdf",
    }
    mapped = connector_ingest._map_stripe_invoice(raw)
    assert mapped is not None
    assert mapped["invoice_id"] == "in_1"
    assert mapped["amount_due"] == 12500
    assert isinstance(mapped["amount_due"], int)
    assert mapped["currency"] == "usd"
    assert mapped["customer_id"] == "cus_abc"
    assert mapped["customer_email"] == "buyer@x.com"
    assert mapped["created_at_remote"].year == 2024
    assert mapped["due_date"].isoformat() == "2024-05-31"
    assert mapped["occurred_at"] == mapped["created_at_remote"]


def test_map_stripe_invoice_handles_expanded_customer():
    raw = {"id": "in_2", "customer": {"id": "cus_xyz", "name": "Acme Co"}}
    mapped = connector_ingest._map_stripe_invoice(raw)
    assert mapped is not None
    assert mapped["customer_id"] == "cus_xyz"


def test_map_stripe_invoice_amounts_reject_floats_and_bools():
    raw = {
        "id": "in_3",
        "amount_due": True,  # bool — must NOT count as int
        "amount_paid": "5000",  # numeric string — accept
        "amount_remaining": 1.5,  # float — reject (cents are int)
    }
    mapped = connector_ingest._map_stripe_invoice(raw)
    assert mapped is not None
    assert mapped["amount_due"] is None
    assert mapped["amount_paid"] == 5000
    assert mapped["amount_remaining"] is None


def test_map_stripe_invoice_returns_none_without_id():
    assert connector_ingest._map_stripe_invoice({"status": "paid"}) is None


# ── DB-backed sync round-trip ──────────────────────────────────────────


def _sync_task(toolkit: str, user_id: int, cid: str) -> ScheduledTaskRow:
    return ScheduledTaskRow(
        user_id=user_id,
        id=f"sync.{toolkit}.{cid}",
        kind="connector.sync",
        name=None,
        prompt=None,
        trigger_kind="schedule",
        cron_expr="*/30 * * * *",
        interval_seconds=None,
        event_filter=None,
        payload={"toolkit": toolkit, "connectedAccountId": cid},
        timezone="UTC",
        status="active",
        next_run_at=None,
        last_run_at=datetime.now(UTC),
        last_run_status="dispatched",
        run_count=1,
        attempts=0,
        max_attempts=3,
        progress={},
        last_error=None,
    )


def _patch_fetch(monkeypatch, toolkit: str, items_box: dict):
    from pinai_agents.web.services import ingest_runner

    async def fake_fetch(user_id, tk, cid, *, limit=100, since=None, pool=None):
        if tk == toolkit:
            return list(items_box["items"])
        return []

    monkeypatch.setattr(ingest_runner, "run_fetch", fake_fetch)
    _ = SimpleNamespace


@pytest.mark.asyncio
async def test_stripe_sync_status_flips_open_to_paid(
    pool,
    user_ids,
    monkeypatch,
):
    user_a, _ = user_ids
    box = {
        "items": [
            {
                "id": "in_payflip",
                "number": "INV-9",
                "status": "open",
                "amount_due": 5000,
                "amount_paid": 0,
                "amount_remaining": 5000,
                "currency": "usd",
                "customer": "cus_pay",
                "created": 1714521600,
            },
        ]
    }
    _patch_fetch(monkeypatch, "stripe", box)

    async with user_scoped_tx(pool, user_a) as conn:
        await enqueue_once(
            conn,
            user_id=user_a,
            task_id="sync.stripe.cidST",
            kind="connector.sync",
            payload={"toolkit": "stripe", "connectedAccountId": "cidST"},
        )
    await connector_ingest.run(pool, _sync_task("stripe", user_a, "cidST"), "rs1")

    box["items"][0] = {
        **box["items"][0],
        "status": "paid",
        "amount_paid": 5000,
        "amount_remaining": 0,
    }
    await connector_ingest.run(pool, _sync_task("stripe", user_a, "cidST"), "rs2")

    async with service_tx(pool) as conn:
        cur = await conn.execute(
            "SELECT status, amount_paid, amount_remaining "
            "FROM pai_raw_stripe_invoices WHERE user_id = %s",
            (user_a,),
        )
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0]["status"] == "paid"
    assert rows[0]["amount_paid"] == 5000
    assert rows[0]["amount_remaining"] == 0


@pytest.mark.asyncio
async def test_stripe_registered():
    assert "stripe" in connector_ingest.supported_toolkits()
