"""Per-user LiteLLM virtual key provisioning.

Lifecycle:
    user upsert (first INSERT) → provision_user_litellm_key()
        → /user/new (idempotent on conflict)
        → /key/generate (returns sk-*)
        → UPDATE users SET litellm_virtual_key = ...

    chat send when key is missing → ensure_user_litellm_key()
        → exact same path, just keyed off the existing user row.

Only `litellm_virtual_key` is persisted on the users table. We don't
cache user_id / key_alias / budget separately — LiteLLM is the source
of truth and we re-derive aliases from internal user_id deterministically.

Failure semantics: if LiteLLM is unreachable on first INSERT, the row
goes in with virtual_key=NULL and the user is logged in fine; the next
chat-send tries again (lazy recovery). This treats LiteLLM downtime as
a transient outage rather than a hard signup blocker.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from psycopg_pool import AsyncConnectionPool

from ...config import get_web_settings
from ..auth.user_service import User
from ..db.rls import service_tx
from ..litellm.client import (
    LITELLM_KEY_PREFIX,
    LiteLLMError,
    create_user,
    delete_keys,
    generate_key,
    list_keys_for_user,
    list_models_for_key,
)

logger = logging.getLogger(__name__)
GENERATOR_REQUIRED_MODELS = {"gpt-5.5"}


def _litellm_user_id(internal_user_id: int) -> str:
    """Deterministic LiteLLM user_id derived from our BIGINT id. Stable
    across re-provisioning so /user/new is genuinely idempotent."""
    return f"pinai-{internal_user_id}"


def _key_alias(internal_user_id: int) -> str:
    """Human-friendly key alias surfaced in LiteLLM's dashboard."""
    return f"pinai-{internal_user_id}"


def _allowed_models(required_models: Iterable[str] = ()) -> list[str]:
    s = get_web_settings()
    raw = s.litellm_allowed_models or ""
    configured = [m.strip() for m in raw.split(",") if m.strip()]
    if not configured:
        return []
    seen = set(configured)
    out = list(configured)
    for model in required_models:
        if model not in seen:
            out.append(model)
            seen.add(model)
    return out


async def _key_supports_models(user: User, required_models: set[str]) -> bool:
    key = user.litellm_virtual_key or ""
    if not key.startswith(LITELLM_KEY_PREFIX):
        return False
    try:
        models = await list_models_for_key(key)
    except LiteLLMError as e:
        if e.status_code in (401, 403):
            logger.warning(
                "litellm: virtual key rejected by model probe user=%d status=%d",
                user.id, e.status_code,
            )
            return False
        logger.warning(
            "litellm: virtual key model probe failed user=%d, keeping existing key: %s",
            user.id, e,
        )
        return True
    except Exception as e:
        logger.warning(
            "litellm: virtual key model probe errored user=%d, keeping existing key: %s",
            user.id, e,
        )
        return True
    missing = sorted(required_models - models)
    if missing:
        logger.warning(
            "litellm: rotating stale virtual key user=%d missing_models=%s",
            user.id, ",".join(missing),
        )
        return False
    return True


async def _provision_and_persist(
    pool: AsyncConnectionPool,
    user: User,
    *,
    required_models: set[str] | None = None,
) -> str:
    """Mint a fresh sk-* key for `user`, persist on users.litellm_virtual_key,
    and return the raw key. Cleans up any stale key bound to the same alias
    so we don't accumulate orphans on retries."""
    s = get_web_settings()
    litellm_uid = _litellm_user_id(user.id)
    alias = _key_alias(user.id)

    await create_user(
        user_id=litellm_uid,
        user_alias=alias,
        metadata={"source": "pinai-agents", "internal_user_id": user.id},
    )

    # Drop any prior key under the same alias so re-provisioning doesn't
    # leave orphans in LiteLLM. Token values are write-once on LiteLLM's
    # side — we can never recover them, so the only safe move is to
    # delete-and-replace.
    existing = await list_keys_for_user(litellm_uid)
    stale_tokens = [k["token"] for k in existing if k.get("key_alias") == alias]
    if stale_tokens:
        await delete_keys(stale_tokens)

    raw_key = await generate_key(
        user_id=litellm_uid,
        key_alias=alias,
        max_budget_usd=s.litellm_default_budget_usd,
        budget_duration=s.litellm_default_budget_duration,
        rpm_limit=s.litellm_default_rpm_limit,
        tpm_limit=s.litellm_default_tpm_limit,
        models=_allowed_models(required_models or ()),
        metadata={"source": "pinai-agents", "internal_user_id": user.id},
    )

    async with service_tx(pool) as conn:
        await conn.execute(
            "UPDATE users SET litellm_virtual_key = %s, updated_at = NOW() "
            "WHERE id = %s",
            (raw_key, user.id),
        )
    logger.info(
        "litellm: provisioned virtual key user=%d alias=%s last4=%s",
        user.id, alias, raw_key[-4:],
    )
    return raw_key


async def provision_user_litellm_key(
    pool: AsyncConnectionPool, user: User,
) -> User:
    """First-touch provisioning — called from upsert_user_by_supabase_id
    when a brand-new row was just INSERTed. On LiteLLM failure we log and
    return the user unchanged so login still succeeds; lazy recovery on
    chat-send will try again.
    """
    if user.litellm_virtual_key and user.litellm_virtual_key.startswith(
        LITELLM_KEY_PREFIX,
    ):
        return user
    try:
        raw_key = await _provision_and_persist(
            pool, user, required_models=GENERATOR_REQUIRED_MODELS,
        )
    except Exception as e:
        logger.warning(
            "litellm: first-touch provisioning failed user=%d (will lazy-retry): %s",
            user.id, e,
        )
        return user
    return User(
        id=user.id,
        supabase_user_id=user.supabase_user_id,
        email=user.email,
        litellm_virtual_key=raw_key,
        browserbase_context_id=user.browserbase_context_id,
    )


async def ensure_user_litellm_key(
    pool: AsyncConnectionPool,
    user: User,
    *,
    required_models: set[str] | None = None,
) -> User:
    """Lazy recovery — called from /chat-stream/send when the user row's
    virtual_key is NULL. Raises on LiteLLM failure so the request sees
    a clean 502 rather than a silent hang."""
    models = required_models or GENERATOR_REQUIRED_MODELS
    if await _key_supports_models(user, models):
        return user
    raw_key = await _provision_and_persist(pool, user, required_models=models)
    return User(
        id=user.id,
        supabase_user_id=user.supabase_user_id,
        email=user.email,
        litellm_virtual_key=raw_key,
        browserbase_context_id=user.browserbase_context_id,
    )
