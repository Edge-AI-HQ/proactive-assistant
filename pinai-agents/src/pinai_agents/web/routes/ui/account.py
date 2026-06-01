"""/api/account — account-level destructive operations.

Currently a single endpoint: DELETE /api/account wipes the user across
every system (Composio, LiteLLM, Stripe, Browserbase, Supabase Storage,
Supabase Auth, then DB CASCADE). See `services/account_deletion.py` for
the orchestration + ordering rationale.
"""

from __future__ import annotations

import logging
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException

from ...auth.deps import User, current_user, get_pool
from ...services.account_deletion import (
    AccountDeletionError,
    delete_user_account,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account", tags=["account"])


@router.delete("")
async def delete_account(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict:
    """Permanently delete the authenticated user.

    On success: returns the per-step result so the UI can surface partial
    external failures (e.g. "we disconnected your data but couldn't
    cancel Stripe — please cancel manually").

    On failure of a fail-fast step (Supabase Auth, DB cascade): returns
    502 with the partial result attached. External steps that already
    succeeded are idempotent on retry, so the user can safely retry.
    """
    try:
        result = await delete_user_account(pool, user)
    except AccountDeletionError as e:
        # Fail-fast step aborted the chain. Return the partial result so
        # the client knows what to communicate to the user (and what's
        # safe to retry).
        logger.error(
            "account.delete: aborted user=%s: %s",
            user.id,
            e,
        )
        raise HTTPException(
            status_code=502,
            detail={"message": str(e), "partial_result": asdict(e.result)},
        ) from e
    return {"ok": True, "result": asdict(result)}
