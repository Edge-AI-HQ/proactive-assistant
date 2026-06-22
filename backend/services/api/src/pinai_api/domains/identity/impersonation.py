"""/api/reward-dashboard/impersonate — internal-operator chat token mint.

Lets an internal reviewer act on a TARGET user's behalf in the same main
chat. The minted per-run JWT carries `actor='internal_operator'` +
`operator_id=<operator's supabase uuid>`, so any preference the agent
writes during that session is server-stamped `source='internal_operator'`
with the operator recorded — it can never be disguised as the user's own
words (the enforcement lives in web/routes/agent/preferences.py).

Auth: `current_user` (Supabase) is NOT sufficient — these routes live in
the shared web process, so any authenticated product user could otherwise
mint a token AS anyone. The real gate is `_is_internal_operator`: the
caller's Supabase UUID must be in the `INTERNAL_OPERATOR_SUBS` allowlist
(fail-closed when empty), with a single exception for the dev-auth-bypass
reviewer under DEPLOY_ENV=dev so local verification still works. Any other
caller is rejected 403.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pinai_contracts.api_models import ImpersonationMintRequest

from pinai_api.config import get_web_settings

from ...platform.auth.agent_jwt import sign_agent_run_jwt
from ...platform.auth.deps import (
    _DEV_AUTH_BYPASS_SUB,
    User,
    current_user,
    get_pool,
)
from ...platform.auth.user_service import load_user_by_supabase_id

# prefix /api/operator (NOT /api/reward-dashboard): impersonation mints a
# master-credential chat-token, so it stays in the api process — while the
# read-only review routes moved to the standalone reward-dashboard service.
# Keeping both under /api/reward-dashboard would split one prefix across two
# services; /api/operator keeps the trust boundary clean and lets the
# frontend proxy split by prefix (reward-dashboard/* → reward, operator/* → api).
router = APIRouter(prefix="/api/operator", tags=["operator"])


def _is_internal_operator(operator: User) -> bool:
    """True iff this caller may impersonate. Allowlist is comma-separated
    Supabase UUIDs (`INTERNAL_OPERATOR_SUBS`); empty = fail-closed. The
    dev-bypass reviewer is allowed only under DEPLOY_ENV=dev."""
    settings = get_web_settings()
    if settings.deploy_env == "dev" and operator.supabase_user_id == _DEV_AUTH_BYPASS_SUB:
        return True
    allowed = {s.strip() for s in settings.internal_operator_subs.split(",") if s.strip()}
    return operator.supabase_user_id in allowed


@router.post("/impersonate/chat-token")
async def mint_impersonation_token(
    body: ImpersonationMintRequest,
    operator: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Mint a chat-driving run JWT for the target user, tagged as driven
    by this internal operator. Returns `{ token, runId, userId }`."""
    if not _is_internal_operator(operator):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="caller is not an internal operator",
        )
    target = await load_user_by_supabase_id(pool, body.target_supabase_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="target user not found",
        )
    token, run_id = sign_agent_run_jwt(
        user_id=target.id,
        # vk lets the token drive chat turns when the target has a key;
        # the preferences write path doesn't require it.
        virtual_key=target.litellm_virtual_key,
        actor="internal_operator",
        operator_id=operator.supabase_user_id,
    )
    return {"token": token, "runId": run_id, "userId": target.id}
