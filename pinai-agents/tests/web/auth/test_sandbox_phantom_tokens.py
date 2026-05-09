"""sandbox_phantom_tokens repository — cache logic + DB roundtrip.

Cache tests are pure-Python (no DB).
DB tests use the `pool` + `user_ids` fixtures from conftest.py — they
skip automatically when TEST_DATABASE_URL is unset (so `pytest` works
on a fresh checkout without docker-compose up).
"""

from __future__ import annotations

import pytest
from psycopg_pool import AsyncConnectionPool

from pinai_agents.web.db.repositories.sandbox_phantom_tokens import (
    DEFAULT_PHANTOM_TTL_SECONDS,
    PHANTOM_PREFIX,
    _cache_get,
    _cache_invalidate,
    _cache_put,
    _generate_raw_token,
    _hash_token,
    _PhantomResolved,
    _Sentinel,
    bind_sandbox,
    clear_cache_for_tests,
    mint,
    resolve,
    revoke_by_sandbox,
    revoke_by_token,
    sweep_expired,
)
from pinai_agents.web.db.rls import service_tx


def setup_function(_fn):
    clear_cache_for_tests()


# ── Pure-logic ──


def test_token_format():
    raw = _generate_raw_token()
    assert raw.startswith(PHANTOM_PREFIX)
    # 32 bytes → ~43 base64url chars + 8-char prefix
    assert len(raw) >= 50
    # Two calls produce different tokens (entropy sanity)
    assert raw != _generate_raw_token()


def test_hash_is_stable_and_unique():
    a = _hash_token("pai_sbx_one")
    b = _hash_token("pai_sbx_one")
    c = _hash_token("pai_sbx_two")
    assert a == b
    assert a != c
    assert len(a) == 64  # SHA-256 hex


def test_cache_miss_distinct_from_negative():
    """A token we never looked up must not collide with a token we
    looked up and confirmed invalid."""
    miss = _cache_get("never-seen")
    assert isinstance(miss, _Sentinel)

    _cache_put("hash-known-bad", None)
    cached_negative = _cache_get("hash-known-bad")
    assert cached_negative is None  # not _Sentinel — we DID look


def test_cache_round_trip_positive():
    resolved = _PhantomResolved(user_id=42, scope_label="thread-x", sandbox_id="sbx_y")
    _cache_put("h1", resolved)
    got = _cache_get("h1")
    assert got == resolved


def test_invalidate_drops_entry():
    _cache_put("h2", _PhantomResolved(user_id=1, scope_label=None, sandbox_id=None))
    _cache_invalidate("h2")
    assert isinstance(_cache_get("h2"), _Sentinel)


# ── DB roundtrip ──


@pytest.mark.asyncio
async def test_mint_resolve_revoke_roundtrip(
    pool: AsyncConnectionPool, user_ids: tuple[int, int],
):
    user_a, _user_b = user_ids
    async with service_tx(pool) as conn:
        raw, token_hash = await mint(
            conn, user_id=user_a, scope_label="test-thread",
        )
    assert raw.startswith(PHANTOM_PREFIX)
    assert _hash_token(raw) == token_hash

    # Resolve hits DB on first call (cache cold) and returns the user.
    async with service_tx(pool) as conn:
        resolved = await resolve(conn, raw_token=raw)
    assert resolved is not None
    assert resolved.user_id == user_a
    assert resolved.scope_label == "test-thread"
    assert resolved.sandbox_id is None  # not bound yet

    # Revoke by raw token; subsequent resolve returns None.
    async with service_tx(pool) as conn:
        ok = await revoke_by_token(conn, raw_token=raw, reason="test")
    assert ok
    async with service_tx(pool) as conn:
        resolved2 = await resolve(conn, raw_token=raw)
    assert resolved2 is None

    # Re-revoke is idempotent (returns False but doesn't error).
    async with service_tx(pool) as conn:
        ok2 = await revoke_by_token(conn, raw_token=raw)
    assert ok2 is False


@pytest.mark.asyncio
async def test_bind_then_revoke_by_sandbox(
    pool: AsyncConnectionPool, user_ids: tuple[int, int],
):
    user_a, user_b = user_ids
    sandbox_id = "sbx_abc123"
    async with service_tx(pool) as conn:
        raw, token_hash = await mint(
            conn, user_id=user_a, scope_label="bind-test",
        )
        await bind_sandbox(conn, token_hash=token_hash, sandbox_id=sandbox_id)
        resolved = await resolve(conn, raw_token=raw)
    assert resolved is not None
    assert resolved.sandbox_id == sandbox_id

    # revoke_by_sandbox with the WRONG user_id must not affect this row
    # (defense-in-depth check baked into the WHERE).
    async with service_tx(pool) as conn:
        n = await revoke_by_sandbox(
            conn, sandbox_id=sandbox_id, user_id=user_b, reason="wrong_user",
        )
    assert n == 0
    async with service_tx(pool) as conn:
        still = await resolve(conn, raw_token=raw)
    assert still is not None  # still active

    # Now revoke with the correct user_id.
    async with service_tx(pool) as conn:
        n = await revoke_by_sandbox(
            conn, sandbox_id=sandbox_id, user_id=user_a, reason="correct_user",
        )
    assert n == 1
    async with service_tx(pool) as conn:
        gone = await resolve(conn, raw_token=raw)
    assert gone is None


@pytest.mark.asyncio
async def test_resolve_rejects_non_phantom_format(pool: AsyncConnectionPool):
    """A JWT-shaped or random Bearer should not even hit DB lookup."""
    async with service_tx(pool) as conn:
        # Garbage and JWT-shaped values share the "doesn't start with
        # PHANTOM_PREFIX" property — both should return None without a
        # DB roundtrip. We can't easily assert "no DB hit", but we CAN
        # assert that a known-invalid prefix returns None deterministically.
        assert await resolve(conn, raw_token="not-a-phantom") is None
        assert await resolve(conn, raw_token="eyJhbGciOiJFZERTQSJ9.x.y") is None


@pytest.mark.asyncio
async def test_resolve_rejects_expired(
    pool: AsyncConnectionPool, user_ids: tuple[int, int],
):
    user_a, _ = user_ids
    # Mint with a 1-second TTL, then poke `expires_at` to the past so
    # we don't have to actually sleep. Using bind path to mutate just
    # to keep the test fast — direct UPDATE is clearest.
    async with service_tx(pool) as conn:
        raw, token_hash = await mint(
            conn, user_id=user_a, scope_label="expired-test", ttl_seconds=60,
        )
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_sandbox_phantom_tokens
                SET expires_at = NOW() - interval '1 minute'
                WHERE token_hash = %s
                """,
                (token_hash,),
            )
    # Cache may have remembered an earlier resolve; clear so we hit DB.
    clear_cache_for_tests()
    async with service_tx(pool) as conn:
        resolved = await resolve(conn, raw_token=raw)
    assert resolved is None


@pytest.mark.asyncio
async def test_sweep_drops_old_expired(
    pool: AsyncConnectionPool, user_ids: tuple[int, int],
):
    user_a, _ = user_ids
    # Create one row that's 10 days past expiration; sweep with
    # retain_days=7 should drop it.
    async with service_tx(pool) as conn:
        raw, token_hash = await mint(
            conn, user_id=user_a, scope_label="sweep-test", ttl_seconds=60,
        )
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE pai_sandbox_phantom_tokens
                SET expires_at = NOW() - interval '10 days'
                WHERE token_hash = %s
                """,
                (token_hash,),
            )
        n = await sweep_expired(conn, retain_days=7)
    assert n >= 1
    # Row is gone.
    async with service_tx(pool) as conn, conn.cursor() as cur:
        await cur.execute(
            "SELECT 1 FROM pai_sandbox_phantom_tokens WHERE token_hash = %s",
            (token_hash,),
        )
        assert await cur.fetchone() is None
    # Silence unused-warning on the round-tripped raw value.
    assert raw.startswith(PHANTOM_PREFIX)


def test_default_ttl_matches_sandbox_auto_delete():
    """Sanity on the constant — sandbox auto_delete is 24h; phantom TTL
    must not exceed it (would create orphan windows)."""
    assert DEFAULT_PHANTOM_TTL_SECONDS == 24 * 60 * 60
