"""User account deletion orchestration.

A "delete account" is multi-system: every per-user `pai_*` table is wiped
via FK CASCADE off `users`, but Composio OAuth grants, LiteLLM virtual
keys, Stripe subscriptions, Browserbase persistent contexts (which hold
login cookies for Gmail/Slack/etc — more sensitive than the OAuth
grants themselves), user-uploaded Supabase Storage files, and the
Supabase Auth user record all live in external systems and must be torn
down with their own APIs.

Order (matters — see ordering rationale below):

    1. Composio    — disconnect every ACTIVE connected_account, otherwise
                     the OAuth grant stays live at Google/Notion/Slack.
    2. LiteLLM     — delete every virtual key the user owns so it can't
                     continue burning budget.
    3. Stripe      — cancel the subscription so the customer stops being
                     billed. Customer object is kept for invoice audit.
    4. Browserbase — delete the persistent context (contains login
                     cookies for every site the agent has visited).
    5. Storage     — recursively remove pai-media/{user_id}/* so user-
                     uploaded media doesn't outlive the DB metadata.
    6. Supabase    — admin-delete the auth.users row. THIS IS FAIL-FAST:
                     it invalidates the stale JWT immediately, which
                     prevents the most dangerous race in the chain — a
                     concurrent request (other tab, multi-device, in-
                     flight fetch) hitting `current_user` after the DB
                     cascade and re-upserting a fresh empty users row
                     against the same supabase_user_id. If we can't
                     guarantee the JWT is dead, we don't proceed.
    7. DB CASCADE  — wipe pai_stripe_webhook_events for this user (its FK
                     is ON DELETE SET NULL, not CASCADE, and raw_data
                     holds the full Stripe event payload — billing PII),
                     then DELETE FROM users, which drops every per-user
                     pai_* table via CASCADE in one tx.

Idempotency: every external step (1-5) swallows "already gone" errors so
a user-initiated retry after a partial failure cleanly walks the chain a
second time. Supabase Auth (6) treats 404 as success for the same reason.

Failure semantics:
  * Steps 1-5 — best-effort. Failures logged and collected into the
    result; do not abort the chain. A retry will re-attempt them and
    swallow whatever already succeeded.
  * Step 6   — FAIL-FAST. Any non-success (other than 404) raises and
    aborts. Without this barrier, the stale JWT can recreate the user.
  * Step 7   — gate. If this fails the user is in a broken state
    (Supabase auth gone, no DB row to log into) — they need ops help.
    In practice CASCADE on the users PK is one of the simplest deletes
    PostgreSQL does, so this failing means something is very wrong.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

import httpx
from browserbase import Browserbase
from psycopg_pool import AsyncConnectionPool

from ...config import get_web_settings
from ..auth.user_service import User
from ..composio_service import ComposioError, disconnect, list_connections
from ..db.rls import service_tx
from ..litellm.client import LiteLLMError, delete_keys, list_keys_for_user
from ..payment.stripe_client import get_stripe
from ..payment.subscriptions import get_for_user
from ..storage import delete_all_user_media

logger = logging.getLogger(__name__)


def _litellm_user_id(supabase_user_id: str) -> str:
    # Mirrors services/litellm_provisioning._litellm_user_id. One line is
    # not worth a cross-module private import.
    return f"pinai-{supabase_user_id}"


class AccountDeletionError(Exception):
    """Raised when a fail-fast step (Supabase Auth, DB cascade) errors.

    Carries the partial result so callers can surface which external
    cleanup succeeded before the abort."""

    def __init__(self, message: str, result: AccountDeletionResult) -> None:
        super().__init__(message)
        self.result = result


@dataclass(slots=True)
class AccountDeletionResult:
    composio_disconnected: int = 0
    composio_errors: list[str] = field(default_factory=list)
    litellm_keys_deleted: int = 0
    litellm_error: str | None = None
    stripe_subscription_canceled: bool = False
    stripe_error: str | None = None
    browserbase_context_deleted: bool = False
    browserbase_error: str | None = None
    storage_files_deleted: int = 0
    storage_error: str | None = None
    supabase_auth_deleted: bool = False
    supabase_auth_error: str | None = None
    db_deleted: bool = False


async def _cleanup_composio(user: User, result: AccountDeletionResult) -> None:
    try:
        connections = await list_connections(user)
    except ComposioError as e:
        logger.warning("account.delete: composio list failed user=%s: %s", user.id, e)
        result.composio_errors.append(f"list: {e}")
        return
    for conn in connections:
        try:
            await disconnect(conn.connected_account_id)
            result.composio_disconnected += 1
        except (ComposioError, ValueError) as e:
            logger.warning(
                "account.delete: composio disconnect failed user=%s cid=%s: %s",
                user.id,
                conn.connected_account_id,
                e,
            )
            result.composio_errors.append(f"{conn.toolkit}:{e}")


async def _cleanup_litellm(user: User, result: AccountDeletionResult) -> None:
    # Delete the token stored on the user row AND every key listed under
    # the computed LiteLLM user_id. The stored token is the only reliable
    # handle when an account's persisted LiteLLM user_id prefix has drifted
    # from what _litellm_user_id() computes (e.g. legacy `proactive-<uuid>`
    # rows that predate the `pinai-` scheme) — list-by-user_id alone would
    # miss it and leave the key live. The list catches orphan keys from old
    # re-provisioning paths.
    tokens: set[str] = set()
    if user.litellm_virtual_key:
        tokens.add(user.litellm_virtual_key)
    try:
        keys = await list_keys_for_user(_litellm_user_id(user.supabase_user_id))
        tokens.update(k["token"] for k in keys if isinstance(k.get("token"), str))
    except LiteLLMError as e:
        logger.warning("account.delete: litellm list failed user=%s: %s", user.id, e)
        result.litellm_error = str(e)
    if tokens:
        await delete_keys(sorted(tokens))  # swallows LiteLLMError internally
        result.litellm_keys_deleted = len(tokens)


async def _cleanup_stripe(
    pool: AsyncConnectionPool,
    user: User,
    result: AccountDeletionResult,
) -> None:
    # Cancel subscription only — Customer object is kept for Stripe-side
    # invoice / dispute audit (deleting it nukes invoice history too).
    try:
        async with service_tx(pool) as conn:
            sub = await get_for_user(conn, user.id)
        if not (sub and sub.stripe_subscription_id):
            return
        stripe = get_stripe()
        if stripe is None:
            logger.info(
                "account.delete: stripe not configured, skipping cancel user=%s",
                user.id,
            )
            return
        # stripe SDK is sync — wrap so the event loop doesn't stall on
        # the Stripe RTT. Existing webhook.py calls don't do this but
        # webhook handlers run their own short queries; a deletion
        # endpoint chains several network calls so the cost adds up.
        await asyncio.to_thread(
            stripe.Subscription.delete,  # type: ignore[attr-defined]  # get_stripe() is typed object | None
            sub.stripe_subscription_id,
        )
        result.stripe_subscription_canceled = True
    except Exception as e:  # noqa: BLE001 — stripe SDK raises many concrete types
        # "No such subscription" / "already canceled" are expected on retry.
        msg = str(e).lower()
        if "no such" in msg or "already" in msg:
            result.stripe_subscription_canceled = True
            return
        logger.warning("account.delete: stripe cancel failed user=%s: %s", user.id, e)
        result.stripe_error = str(e)


async def _cleanup_browserbase(user: User, result: AccountDeletionResult) -> None:
    # Persistent context holds login cookies for every site the agent
    # has visited (Gmail / Slack / Notion / etc) — strictly more
    # sensitive than the OAuth grants themselves.
    ctx_id = user.browserbase_context_id
    if not ctx_id:
        return
    settings = get_web_settings()
    if not settings.browserbase_api_key:
        logger.info(
            "account.delete: browserbase not configured, skipping ctx=%s",
            ctx_id,
        )
        return
    try:
        bb = Browserbase(api_key=settings.browserbase_api_key)
        await asyncio.to_thread(bb.contexts.delete, ctx_id)
        result.browserbase_context_deleted = True
    except Exception as e:  # noqa: BLE001 — browserbase SDK raises many concrete types
        # 404 = already deleted (idempotent retry); treat as success.
        if "404" in str(e) or "not found" in str(e).lower():
            result.browserbase_context_deleted = True
            return
        logger.warning(
            "account.delete: browserbase delete failed user=%s ctx=%s: %s",
            user.id,
            ctx_id,
            e,
        )
        result.browserbase_error = str(e)


async def _cleanup_storage(user: User, result: AccountDeletionResult) -> None:
    try:
        result.storage_files_deleted = await delete_all_user_media(user.supabase_user_id)
    except Exception as e:  # noqa: BLE001 — supabase storage SDK raises many types
        logger.warning(
            "account.delete: storage cleanup failed user=%s: %s",
            user.id,
            e,
        )
        result.storage_error = str(e)


async def _delete_supabase_auth_user(
    user: User,
    result: AccountDeletionResult,
) -> None:
    """Fail-fast: any error other than 404 raises.

    This step is the JWT-invalidation barrier. Letting it fail silently
    would risk a stale JWT recreating the users row right after the DB
    cascade. The endpoint must abort with 5xx and the user must retry.
    """
    settings = get_web_settings()
    if not (settings.supabase_url and settings.supabase_secret_key):
        msg = "supabase admin credentials not configured (SUPABASE_SECRET_KEY)"
        result.supabase_auth_error = msg
        raise AccountDeletionError(msg, result)

    url = f"{settings.supabase_url.rstrip('/')}/auth/v1/admin/users/{user.supabase_user_id}"
    headers = {
        "apikey": settings.supabase_secret_key,
        "Authorization": f"Bearer {settings.supabase_secret_key}",
    }
    timeout = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as cli:
            resp = await cli.delete(url, headers=headers)
    except httpx.HTTPError as e:
        msg = f"supabase admin delete network error: {e}"
        result.supabase_auth_error = msg
        raise AccountDeletionError(msg, result) from e
    # 404 = already gone (retry path), treat as success.
    if resp.is_success or resp.status_code == 404:
        result.supabase_auth_deleted = True
        return
    msg = f"supabase admin delete {resp.status_code}: {resp.text[:200]}"
    result.supabase_auth_error = msg
    raise AccountDeletionError(msg, result)


async def _delete_db_user(
    pool: AsyncConnectionPool,
    user: User,
    result: AccountDeletionResult,
) -> None:
    """DB cascade. rowcount on the users DELETE must be exactly 1 —
    Supabase Auth delete (step 6) lives in a different database and does
    NOT touch our users table, so the row is still here. A rowcount of 0
    means something race-deleted it out from under us and we should
    notice.

    pai_stripe_webhook_events is deleted explicitly first, in the same tx
    and while user_id is still set: its FK is ON DELETE SET NULL (the
    idempotency log is meant to outlive any single user), so the users
    CASCADE would NOT take its rows — and raw_data holds the full Stripe
    event payload (customer email / name / address / phone). Without this,
    billing PII survives the account deletion.
    """
    async with service_tx(pool) as conn:
        await conn.execute(
            "DELETE FROM pai_stripe_webhook_events WHERE user_id = %s",
            (user.id,),
        )
        cur = await conn.execute(
            "DELETE FROM users WHERE id = %s",
            (user.id,),
        )
        if cur.rowcount != 1:
            msg = f"users DELETE affected {cur.rowcount} rows (expected 1)"
            raise AccountDeletionError(msg, result)
    result.db_deleted = True


async def delete_user_account(
    pool: AsyncConnectionPool,
    user: User,
) -> AccountDeletionResult:
    """Tear down `user` across every system that holds their data.

    Returns the per-step result on success. Raises `AccountDeletionError`
    when a fail-fast step (Supabase Auth or DB cascade) fails — the
    error carries `result` so the caller can still surface which
    external cleanup succeeded.
    """
    result = AccountDeletionResult()
    logger.info(
        "account.delete: starting user=%s email=%s",
        user.id,
        user.email,
    )

    await _cleanup_composio(user, result)
    await _cleanup_litellm(user, result)
    await _cleanup_stripe(pool, user, result)
    await _cleanup_browserbase(user, result)
    await _cleanup_storage(user, result)
    # ── point of no return ──
    await _delete_supabase_auth_user(user, result)  # fail-fast
    await _delete_db_user(pool, user, result)  # gate

    logger.info(
        "account.delete: done user=%s composio=%d litellm=%d stripe=%s "
        "browserbase=%s storage=%d supabase=%s db=%s",
        user.id,
        result.composio_disconnected,
        result.litellm_keys_deleted,
        result.stripe_subscription_canceled,
        result.browserbase_context_deleted,
        result.storage_files_deleted,
        result.supabase_auth_deleted,
        result.db_deleted,
    )
    return result
