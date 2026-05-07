"""Webhook helpers — _user_id_from_metadata / _attr — no Stripe needed."""

from __future__ import annotations

from types import SimpleNamespace

from pinai_agents.web.payment.webhook import (
    _attr,
    _resolve_user_id_for_event,
    _user_id_from_metadata,
)


def test_user_id_from_metadata_int_string():
    obj = SimpleNamespace(metadata={"user_id": "42"})
    assert _user_id_from_metadata(obj) == 42


def test_user_id_from_metadata_int_value():
    obj = SimpleNamespace(metadata={"user_id": 42})
    assert _user_id_from_metadata(obj) == 42


def test_user_id_from_metadata_missing_returns_none():
    obj = SimpleNamespace(metadata={})
    assert _user_id_from_metadata(obj) is None


def test_user_id_from_metadata_no_metadata_returns_none():
    obj = SimpleNamespace()
    assert _user_id_from_metadata(obj) is None


def test_user_id_from_metadata_garbage_returns_none():
    obj = SimpleNamespace(metadata={"user_id": "abc"})
    assert _user_id_from_metadata(obj) is None


def test_attr_works_on_namespace_and_dict():
    ns = SimpleNamespace(x=1)
    d = {"x": 1}
    assert _attr(ns, "x") == 1
    assert _attr(d, "x") == 1
    assert _attr(None, "x") is None
    assert _attr({}, "missing") is None


def test_resolve_user_id_for_event_drills_through_event_data_object():
    event = SimpleNamespace(
        id="evt_x", type="checkout.session.completed",
        data=SimpleNamespace(object=SimpleNamespace(metadata={"user_id": "7"})),
    )
    assert _resolve_user_id_for_event(event) == 7
