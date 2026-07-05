"""Real-Postgres regression test for the key-mint savepoint isolation.

Bug (regression from #197): _provision_and_persist() mints a user's LiteLLM
virtual key and, in the SAME service_tx, calls recompute_litellm_budget →
_sync_litellm_budget_reset_at, which UPDATEs the shared ``litellm`` schema.
service_role was never granted that schema (migration 104 only covered
``public``), so the cross-schema UPDATE raised "permission denied for schema
litellm". In PostgreSQL a single failed statement aborts the WHOLE
transaction, so committing the service_tx silently rolled back everything —
including ``UPDATE users SET litellm_virtual_key`` — leaving the key NULL.

The fix wraps that cross-schema write in a SAVEPOINT (checkout.py) so its
failure can never abort the caller's transaction, and migration 127 restores
the grant so the write succeeds outright. This test locks the savepoint half:
a failing _sync must not roll back a sibling write in the same transaction.
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from pinai_api.domains.billing.payments import checkout as checkout_mod

pytestmark = pytest.mark.asyncio

_PERIOD = SimpleNamespace(period_end=datetime(2026, 7, 17, 12, 0, tzinfo=UTC))


async def test_sync_failure_does_not_roll_back_sibling_write(pool, user_ids):
    web_uid, _ = user_ids
    marker = "sk-savepoint-marker-677351"

    # This test exercises the FAILURE path, which needs _sync's cross-schema
    # UPDATE to actually fail. It fails whenever the LiteLLM app's token table
    # is unreachable — absent, or present but not granted (to_regclass → NULL).
    # That is the case on CI / a fresh test DB where the LiteLLM app never ran.
    # If a local DB happens to have it reachable, _sync succeeds and there is
    # nothing to isolate, so skip rather than false-pass.
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT to_regclass('litellm.\"LiteLLM_VerificationToken\"') AS t")
        if (await cur.fetchone())["t"] is not None:
            pytest.skip("litellm token table reachable; failure path not exercised")

    async with pool.connection() as conn, conn.transaction():
        # 1. mimic the mint's own key write (public schema) — must survive commit
        await conn.execute(
            "UPDATE users SET litellm_virtual_key = %s WHERE id = %s",
            (marker, web_uid),
        )
        # 2. the best-effort budget-reset sync fails (litellm table unreachable);
        #    the savepoint inside _sync must contain it
        await checkout_mod._sync_litellm_budget_reset_at(conn, web_uid, _PERIOD)
        # 3. the transaction is NOT poisoned — without the savepoint this SELECT
        #    would raise "current transaction is aborted"
        cur = await conn.execute("SELECT litellm_virtual_key FROM users WHERE id = %s", (web_uid,))
        assert (await cur.fetchone())["litellm_virtual_key"] == marker

    # 4. committed: the key write persisted. This is the exact bug — before the
    #    fix, the failed cross-schema UPDATE rolled this back to NULL.
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT litellm_virtual_key FROM users WHERE id = %s", (web_uid,))
        assert (await cur.fetchone())["litellm_virtual_key"] == marker
