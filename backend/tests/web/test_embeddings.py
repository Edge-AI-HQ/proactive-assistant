from __future__ import annotations

from types import SimpleNamespace

import pytest
from pinai_api.platform import embeddings as service


def _fake_settings(master: str = "sk-master") -> SimpleNamespace:
    return SimpleNamespace(
        litellm_base_url="http://litellm:4000",
        litellm_master_key=master,
    )


def _make_fake_client(captured: dict[str, object], *, n: int = 1):
    """httpx.AsyncClient stand-in that records the embedding request and
    returns `n` zero-vectors of the correct dimension."""

    class FakeResponse:
        status_code = 200
        text = ""

        def json(self):
            return {"data": [{"embedding": [0.0] * service._DIM} for _ in range(n)]}

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, *, headers, json):
            captured.update({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    return FakeAsyncClient


@pytest.mark.asyncio
async def test_embed_batch_uses_virtual_key_when_provided(monkeypatch):
    """When a per-user virtual key is passed, the embedding call must
    authenticate with it — so LiteLLM attributes the spend to that user's
    key (which is what /api/payment/usage reads back)."""
    captured: dict[str, object] = {}
    monkeypatch.setattr(service, "get_web_settings", _fake_settings)
    monkeypatch.setattr(service.httpx, "AsyncClient", _make_fake_client(captured))

    out = await service.embed_batch(["hello"], virtual_key="sk-user-key")

    assert len(out) == 1
    assert captured["headers"]["Authorization"] == "Bearer sk-user-key"


@pytest.mark.asyncio
async def test_embed_batch_falls_back_to_master_key(monkeypatch):
    """No virtual key (service-internal / keyless user) → master key, so
    embedding still works even when attribution isn't possible."""
    captured: dict[str, object] = {}
    monkeypatch.setattr(service, "get_web_settings", _fake_settings)
    monkeypatch.setattr(service.httpx, "AsyncClient", _make_fake_client(captured))

    await service.embed_batch(["hello"])

    assert captured["headers"]["Authorization"] == "Bearer sk-master"


def test_bill_target_personal_row_uses_that_users_key():
    keys = {1: "sk-user-1", 2: "sk-user-2"}
    assert service._embedding_bill_target(2, keys) == "sk-user-2"
    assert service._embedding_bill_target(1, keys) == "sk-user-1"


def test_bill_target_keyless_personal_row_is_skip_not_master():
    """A keyless user's personal row must be skipped (None), NOT billed to
    master — personal data is never billed to the master key."""
    assert service._embedding_bill_target(99, {}) is None


@pytest.mark.asyncio
async def test_text_to_query_vector_forwards_virtual_key(monkeypatch):
    captured: dict[str, object] = {}
    monkeypatch.setattr(service, "get_web_settings", _fake_settings)
    monkeypatch.setattr(service.httpx, "AsyncClient", _make_fake_client(captured))

    await service.text_to_query_vector("a query", virtual_key="sk-user-key")

    assert captured["headers"]["Authorization"] == "Bearer sk-user-key"
