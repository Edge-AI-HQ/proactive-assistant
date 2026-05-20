"""Webhook helpers — _user_id_from_metadata / _attr — no Stripe needed.

These helpers resolve a Stripe event's metadata back to our internal
BIGINT user id by looking up the Supabase UUID against the users table.
See AGENTS.md "用户标识规约" for why metadata's primary key is the UUID
and never the BIGINT.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from pinai_agents.web.payment import subscriptions
from pinai_agents.web.payment.webhook import (
    _attr,
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
        subscriptions, "find_user_by_supabase_user_id",
        AsyncMock(side_effect=fake_find),
    )
    return mapping


@pytest.mark.asyncio
async def test_user_id_from_metadata_resolves_via_supabase_uuid(stub_find):
    stub_find["u-abc"] = 42
    obj = SimpleNamespace(metadata={
        "supabase_user_id": "u-abc",
        "internal_user_id": "42",  # debug-only; never trusted
    })
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
        id="evt_x", type="checkout.session.completed",
        data=SimpleNamespace(object=SimpleNamespace(
            metadata={"supabase_user_id": "u-7"},
        )),
    )
    assert await _resolve_user_id_for_event(None, event) == 7
