"""Per-user LiteLLM virtual key provisioning.

Lifecycle (never minted on the auth/signup path so login can't block on
LiteLLM availability; see web/auth/user_service.py):
    onboarding completion (profile.py update_settings) → ensure_user_litellm_key()
        → /user/new (idempotent on conflict)
        → /key/generate (returns sk-*)
        → UPDATE users SET litellm_virtual_key = ...
    point-of-use re-ensure (generate, ambient, voice, scheduler dispatcher):
        same call — beyond NULL recovery it re-checks the key covers the
        required models, which is how a payment plan change propagates onto
        the key (checkout/webhook rely on "the next ensure call").
    conversation send deliberately does NOT ensure: the SPA gates the app
        on onboarding, so the key is already on the user row by the time a
        chat turn runs.

Only `litellm_virtual_key` is persisted on the users table. We don't
cache user_id / key_alias / budget separately — LiteLLM is the source
of truth and we re-derive aliases from the Supabase UUID
deterministically. See AGENTS.md "用户标识规约": LiteLLM user_id is an
external namespace, so it must derive from supabase_user_id (UUID) and
not the internal BIGINT — local docker / dev / prod SERIAL sequences
would otherwise collide on the shared LiteLLM control plane.

Failure semantics: ensure_user_litellm_key() raises on LiteLLM failure
so the triggering request sees a clean 502 rather than a silent hang.
Because nothing mints the key at signup, LiteLLM downtime never blocks
login — it only defers the key to the next request that needs it.
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


def _agent_required_models() -> set[str]:
    """Models a virtual key must cover for agent runs: the per-env default
    agent model (DEFAULT_MODEL) plus the annotation tier (GROUP_TITLE_MODEL,
    chat work-group titles) — a key policy that misses either would silently
    break that path."""
    settings = get_web_settings()
    return {settings.default_model, settings.group_title_model}


def _litellm_user_id(supabase_user_id: str) -> str:
    """Deterministic LiteLLM user_id derived from the Supabase UUID.
    Stable across re-provisioning so /user/new is genuinely idempotent,
    and globally unique across environments (see module docstring)."""
    return f"pinai-{supabase_user_id}"


def _key_alias(supabase_user_id: str) -> str:
    """Human-friendly key alias surfaced in LiteLLM's dashboard.
    Same string as the user_id — dashboard rows align 1:1."""
    return f"pinai-{supabase_user_id}"


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
                user.id,
                e.status_code,
            )
            return False
        logger.warning(
            "litellm: virtual key model probe failed user=%d, keeping existing key: %s",
            user.id,
            e,
        )
        return True
    except Exception as e:
        logger.warning(
            "litellm: virtual key model probe errored user=%d, keeping existing key: %s",
            user.id,
            e,
        )
        return True
    missing = sorted(required_models - models)
    if missing:
        logger.warning(
            "litellm: rotating stale virtual key user=%d missing_models=%s",
            user.id,
            ",".join(missing),
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
    litellm_uid = _litellm_user_id(user.supabase_user_id)
    alias = _key_alias(user.supabase_user_id)

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

    # Read the Free tier budget from pai_billing_plans (SSOT). Every
    # newly-provisioned user starts on Free; webhook on `invoice.paid`
    # later bumps the budget when they subscribe. Falls back to the env
    # default if 'free' row is missing (shouldn't happen post-058).
    from ..payment import plans as plans_repo

    async with service_tx(pool) as conn:
        free_plan = await plans_repo.find_by_code(conn, "free")
    if free_plan is not None:
        budget_usd = free_plan.monthly_refresh_credits / 100.0
        budget_duration = "30d"
    else:
        budget_usd = s.litellm_default_budget_usd
        budget_duration = s.litellm_default_budget_duration

    raw_key = await generate_key(
        user_id=litellm_uid,
        key_alias=alias,
        max_budget_usd=budget_usd,
        budget_duration=budget_duration,
        rpm_limit=s.litellm_default_rpm_limit,
        tpm_limit=s.litellm_default_tpm_limit,
        models=_allowed_models(required_models or ()),
        metadata={"source": "pinai-agents", "internal_user_id": user.id},
    )

    async with service_tx(pool) as conn:
        await conn.execute(
            "UPDATE users SET litellm_virtual_key = %s, updated_at = NOW() WHERE id = %s",
            (raw_key, user.id),
        )
        # Also make sure they have a pai_subscriptions row on Free tier.
        from ..payment.checkout import ensure_user_free_subscription

        await ensure_user_free_subscription(conn, user.id)
    logger.info(
        "litellm: provisioned virtual key user=%d alias=%s last4=%s budget=$%.2f (Free tier)",
        user.id,
        alias,
        raw_key[-4:],
        budget_usd,
    )
    return raw_key


async def ensure_user_litellm_key(
    pool: AsyncConnectionPool,
    user: User,
    *,
    required_models: set[str] | None = None,
) -> User:
    """Mint-or-verify the user's virtual key. Called at onboarding completion
    (profile update_settings — the primary mint) and at point of use by
    generate / ambient / voice / the scheduler dispatcher, where the
    model-coverage check also propagates payment plan changes onto the key.
    NOT called on chat send (key must already exist; onboarding gates the
    app). Raises on LiteLLM failure so the request sees a clean 502 rather
    than a silent hang."""
    models = required_models or _agent_required_models()
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
