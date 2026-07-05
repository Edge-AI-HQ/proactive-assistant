"""context anchor — resolve(reset 规则)/store(last-writer-wins)(design §4.2/§4.6)。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pinai_api.domains.generation.context_anchor import (
    resolve_anchor,
    store_anchor,
)
from pinai_db.rls import service_tx, user_scoped_tx

NOW = datetime(2026, 7, 4, 12, 0, tzinfo=UTC)


async def _cleanup(pool, user_id: int) -> None:
    async with service_tx(pool) as conn:
        await conn.execute("DELETE FROM pai_generation_context WHERE user_id = %s", (user_id,))


@pytest.mark.asyncio
async def test_fresh_user_gets_now_anchor_and_store_roundtrip(pool, user_ids) -> None:
    user_a, _ = user_ids
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            decision = await resolve_anchor(conn, user_a, now=NOW)
        assert decision.was_reset and decision.reason == "fresh"
        assert decision.anchor == NOW

        async with user_scoped_tx(pool, user_a) as conn:
            await store_anchor(conn, user_a, anchor=NOW, prompt_tokens=42_000)
            kept = await resolve_anchor(conn, user_a, now=NOW + timedelta(hours=1))
        assert not kept.was_reset and kept.reason == "kept"
        assert kept.anchor == NOW
    finally:
        await _cleanup(pool, user_a)


@pytest.mark.asyncio
async def test_reset_on_max_age(pool, user_ids) -> None:
    """时间维度是 api 侧唯一的 reset 规则——token 维度移到 engine 构建时
    就地判(design §4.2),大 token 值在这里不再触发任何事。"""
    user_a, _ = user_ids
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            await store_anchor(conn, user_a, anchor=NOW, prompt_tokens=999_999)
            fresh_enough = await resolve_anchor(conn, user_a, now=NOW + timedelta(hours=1))
        assert not fresh_enough.was_reset  # token 不参与判断

        async with user_scoped_tx(pool, user_a) as conn:
            aged = await resolve_anchor(conn, user_a, now=NOW + timedelta(days=4))
        assert aged.was_reset and aged.reason == "max_age"
        assert aged.anchor == NOW + timedelta(days=4)
    finally:
        await _cleanup(pool, user_a)


@pytest.mark.asyncio
async def test_store_is_last_writer_wins(pool, user_ids) -> None:
    user_a, _ = user_ids
    try:
        async with user_scoped_tx(pool, user_a) as conn:
            await store_anchor(conn, user_a, anchor=NOW, prompt_tokens=100)
            await store_anchor(conn, user_a, anchor=NOW + timedelta(minutes=5), prompt_tokens=200)
            decision = await resolve_anchor(conn, user_a, now=NOW + timedelta(minutes=6))
        assert decision.anchor == NOW + timedelta(minutes=5)
    finally:
        await _cleanup(pool, user_a)
