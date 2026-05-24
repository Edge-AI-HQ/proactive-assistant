"""/api/reward-dashboard/impersonate — internal-operator chat token mint.

Lets an internal reviewer (authenticated like the rest of the reward
dashboard, via `current_user`) act on a TARGET user's behalf in the same
main chat. The minted per-run JWT carries `actor='internal_operator'` +
`operator_id=<operator's supabase uuid>`, so any preference the agent
writes during that session is server-stamped `source='internal_operator'`
with the operator recorded — it can never be disguised as the user's own
words (the enforcement lives in web/routes/agent/preferences.py).

Auth: `current_user` (Supabase). A caller without dashboard auth (no /
non-Supabase token) is rejected 401 by the dependency, satisfying
"only internal dashboard auth may mint".
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from ....shared.api_models import ImpersonationMintRequest
from ...auth.agent_jwt import sign_agent_run_jwt
from ...auth.deps import User, current_user, get_pool
from ...auth.user_service import load_user_by_supabase_id

router = APIRouter(prefix="/api/reward-dashboard", tags=["reward-dashboard"])


@router.post("/impersonate/chat-token")
async def mint_impersonation_token(
    body: ImpersonationMintRequest,
    operator: User = Depends(current_user),
    pool=Depends(get_pool),
):
    """Mint a chat-driving run JWT for the target user, tagged as driven
    by this internal operator. Returns `{ token, runId, userId }`."""
    target = await load_user_by_supabase_id(pool, body.target_supabase_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="target user not found",
        )
    token, run_id = sign_agent_run_jwt(
        user_id=target.id,
        # vk lets the token drive chat-stream when the target has a key;
        # the preferences write path doesn't require it.
        virtual_key=target.litellm_virtual_key,
        actor="internal_operator",
        operator_id=operator.supabase_user_id,
    )
    return {"token": token, "runId": run_id, "userId": target.id}
