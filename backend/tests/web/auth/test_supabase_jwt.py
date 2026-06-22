"""Supabase JWT verifier — REST mode (calls /auth/v1/user)."""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import httpx
import pytest
from pinai_api.platform.auth.supabase_jwt import (
    JWTVerifyError,
    reset_cache_for_tests,
    verify_supabase_jwt,
)


@pytest.fixture(autouse=True)
def _set_env(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "publishable-key-test")
    from pinai_api import config

    config.get_web_settings.cache_clear()
    reset_cache_for_tests()
    yield
    config.get_web_settings.cache_clear()
    reset_cache_for_tests()


def _mock_response(
    status_code: int, json_body: dict | None = None, text: str = ""
) -> httpx.Response:
    request = httpx.Request("GET", "https://test.supabase.co/auth/v1/user")
    if json_body is not None:
        return httpx.Response(status_code, json=json_body, request=request)
    return httpx.Response(status_code, text=text, request=request)


@pytest.mark.asyncio
async def test_verify_success():
    with patch(
        "pinai_api.platform.auth.supabase_jwt.httpx.AsyncClient.get",
        return_value=_mock_response(
            200,
            {
                "id": "00000000-0000-0000-0000-000000000001",
                "email": "user@test.invalid",
                "role": "authenticated",
            },
        ),
    ):
        claims = await verify_supabase_jwt("token-abc")
    assert claims.sub == "00000000-0000-0000-0000-000000000001"
    assert claims.email == "user@test.invalid"
    assert claims.role == "authenticated"


@pytest.mark.asyncio
async def test_verify_rejects_401():
    with (
        patch(
            "pinai_api.platform.auth.supabase_jwt.httpx.AsyncClient.get",
            return_value=_mock_response(401, text='{"error":"invalid"}'),
        ),
        pytest.raises(JWTVerifyError, match="rejected"),
    ):
        await verify_supabase_jwt("bad-token")


@pytest.mark.asyncio
async def test_verify_rejects_missing_sub():
    with (
        patch(
            "pinai_api.platform.auth.supabase_jwt.httpx.AsyncClient.get",
            return_value=_mock_response(200, {"email": "x@y.invalid"}),
        ),
        pytest.raises(JWTVerifyError, match="missing user id"),
    ):
        await verify_supabase_jwt("weird-token")


@pytest.mark.asyncio
async def test_network_error_surfaces_as_verify_error():
    async def boom(*_args, **_kwargs):
        raise httpx.ConnectError("connection refused")

    with (
        patch(
            "pinai_api.platform.auth.supabase_jwt.httpx.AsyncClient.get",
            side_effect=boom,
        ),
        pytest.raises(JWTVerifyError, match="unreachable"),
    ):
        await verify_supabase_jwt("any")


@pytest.mark.asyncio
async def test_cache_avoids_second_network_call():
    """Successive verifications of the same token hit the cache,
    not the network."""
    call_count = 0

    async def counting_get(*_args, **_kwargs):
        nonlocal call_count
        call_count += 1
        return _mock_response(
            200,
            {
                "id": "user-cached",
                "email": "c@x.invalid",
                "role": "authenticated",
            },
        )

    with patch(
        "pinai_api.platform.auth.supabase_jwt.httpx.AsyncClient.get",
        side_effect=counting_get,
    ):
        a = await verify_supabase_jwt("same-token")
        b = await verify_supabase_jwt("same-token")
    assert a.sub == b.sub == "user-cached"
    assert call_count == 1


@pytest.mark.asyncio
async def test_concurrent_verifies_dedupe_to_one_call():
    """Parallel verifications of the same token coalesce into one
    upstream HTTPS call — protects against thundering herd on AppShell
    mount where 5+ panels fire /api/* at the same moment."""
    call_count = 0
    barrier = asyncio.Event()

    async def slow_get(*_args, **_kwargs):
        nonlocal call_count
        call_count += 1
        await barrier.wait()
        return _mock_response(
            200,
            {
                "id": "user-deduped",
                "email": None,
                "role": "authenticated",
            },
        )

    with patch(
        "pinai_api.platform.auth.supabase_jwt.httpx.AsyncClient.get",
        side_effect=slow_get,
    ):
        # Five concurrent verifies of the same token.
        tasks = [asyncio.create_task(verify_supabase_jwt("burst-token")) for _ in range(5)]
        # Yield once so each task gets to the inflight check / suspend.
        await asyncio.sleep(0)
        barrier.set()
        results = await asyncio.gather(*tasks)
    assert all(r.sub == "user-deduped" for r in results)
    assert call_count == 1
