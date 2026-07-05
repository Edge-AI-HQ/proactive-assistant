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
from pinai_api.domains.connector.apps import connector_ingest
from pinai_api.platform.db.repositories.scheduled_tasks import (
    ScheduledTaskRow,
    enqueue_once,
)
from pinai_db.rls import service_tx, user_scoped_tx

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
    from pinai_api.domains.connector.apps import ingest_runner

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
            "SELECT payload->>'status' AS status, "
            "(payload->>'amount_paid')::int AS amount_paid, "
            "(payload->>'amount_remaining')::int AS amount_remaining "
            "FROM pai_raw_apps WHERE user_id = %s AND toolkit = 'stripe' AND entity_type = 'invoices'",
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
