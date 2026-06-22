"""Pytest fixtures for web/db + scheduler tests.

Connect to a Postgres instance via TEST_DATABASE_URL env var. The expected
target is the local docker-compose Postgres after `make migrate` has run
(so pai_* schema + RLS policies + roles exist).

Each test runs inside a transaction that's ROLLBACK'd at teardown — keeps
runs isolated without needing per-test schema teardown.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool


def _normalize_dsn(dsn: str) -> str:
    """Strip yoyo's `postgresql+psycopg://` prefix that yoyo expects but
    psycopg doesn't recognize. We accept both forms in TEST_DATABASE_URL
    so test scripts can reuse the env var that fly release_command uses."""
    return dsn.replace("postgresql+psycopg://", "postgresql://", 1)


def _test_dsn() -> str | None:
    raw = os.environ.get("TEST_DATABASE_URL")
    return _normalize_dsn(raw) if raw else None


def pytest_collection_modifyitems(config, items):
    """Skip DB tests when no TEST_DATABASE_URL is set so `pytest` works on
    a fresh checkout without dev infrastructure."""
    if _test_dsn():
        return
    skip = pytest.mark.skip(reason="TEST_DATABASE_URL not set")
    for item in items:
        if "pool" in item.fixturenames or "user_ids" in item.fixturenames:
            item.add_marker(skip)


@pytest_asyncio.fixture
async def pool() -> AsyncIterator[AsyncConnectionPool]:
    dsn = _test_dsn()
    if not dsn:
        pytest.skip("TEST_DATABASE_URL not set")
    p = AsyncConnectionPool(
        conninfo=dsn,
        min_size=1,
        max_size=8,
        kwargs={"row_factory": dict_row},
        open=False,
    )
    await p.open()
    try:
        yield p
    finally:
        await p.close()


@pytest_asyncio.fixture
async def user_ids(pool: AsyncConnectionPool) -> AsyncIterator[tuple[int, int]]:
    """Provision two test users, yield their IDs, clean up after.

    Cleanup deletes via ON DELETE CASCADE which fans out to all pai_*
    rows we created. (Migration 030 dropped the old apis-era
    `container_proxy_secret NOT NULL` column, so the INSERT only
    needs supabase_user_id + email.)
    """
    suffix = uuid.uuid4().hex[:8]
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            """
                INSERT INTO users (supabase_user_id, email)
                VALUES (gen_random_uuid(), %s),
                       (gen_random_uuid(), %s)
                """,
            (
                f"a-{suffix}@test.invalid",
                f"b-{suffix}@test.invalid",
            ),
        )
        cur = await conn.execute(
            "SELECT id FROM users WHERE email IN (%s, %s) ORDER BY id",
            (f"a-{suffix}@test.invalid", f"b-{suffix}@test.invalid"),
        )
        ids = [row["id"] for row in await cur.fetchall()]
    user_a, user_b = ids[0], ids[1]
    try:
        yield user_a, user_b
    finally:
        async with pool.connection() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM users WHERE id IN (%s, %s)",
                (user_a, user_b),
            )


def utcnow() -> datetime:
    return datetime.now(UTC)
