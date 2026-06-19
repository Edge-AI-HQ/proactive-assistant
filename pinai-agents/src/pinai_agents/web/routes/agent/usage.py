"""/api/agent/usage/* — chat process reports non-LiteLLM compute usage.

Browser (Browserbase) sessions and Daytona sandbox execs cost money but don't
flow through LiteLLM token accounting. The chat process times each active use
and POSTs the duration here; we price it (duration × rate, the rate owned
web-side) and write a `pai_provider_usage_events` row, which budget reconcile
folds into the user's credit window — same path as ByteDance ASR.

Auth: `current_chat_principal` (EdDSA run JWT carrying `vk`), so the row is
attributed to the run's user. The chat reports only duration; cost is computed
here and duration is capped, so a misbehaving chat can't inflate the bill.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ...auth.deps import ChatPrincipal, current_chat_principal, get_pool
from ...auth.user_service import load_user_by_id
from ...db.repositories.provider_usage import (
    ProviderUsageEventInput,
    ProviderUsageRepository,
)
from ...db.rls import user_scoped_tx
from ...services.provider_usage import estimate_compute_charge, estimate_tavily_charge

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent/usage", tags=["agent-usage"])

# Defensive cap: a single active browser action / sandbox exec can't plausibly
# run longer than this. Bounds a buggy or compromised chat from reporting an
# absurd duration → runaway charge.
_MAX_DURATION_SECONDS = 6 * 60 * 60  # 6h


class UsageRecordRequest(BaseModel):
    provider: Literal["browserbase", "daytona", "tavily"]
    durationSeconds: float = Field(default=0, ge=0, le=_MAX_DURATION_SECONDS)
    product: Literal["tavily_search", "tavily_extract"] | None = None
    apiCredits: float | None = Field(default=None, ge=0, le=10_000)
    source: str = Field(min_length=1, max_length=120)
    providerRequestId: str | None = Field(default=None, max_length=200)
    status: Literal["succeeded", "failed"] = "succeeded"
    metadata: dict[str, Any] = Field(default_factory=dict)


@router.post("/record")
async def record_usage(
    body: UsageRecordRequest,
    principal: ChatPrincipal = Depends(current_chat_principal),
    pool=Depends(get_pool),
) -> dict:
    """Record one active-use compute charge for the run's user."""
    if body.provider == "tavily":
        if body.product is None:
            return {"ok": False, "recorded": False, "error": "product required"}
        if not body.apiCredits or body.apiCredits <= 0:
            return {"ok": True, "recorded": False, "costUsd": 0.0}
        quantity = body.apiCredits
        charge = estimate_tavily_charge(
            product=body.product,
            api_credits=quantity,
            source=body.source,
            metadata=body.metadata,
            status=body.status,
        )
    elif body.durationSeconds <= 0:
        return {"ok": True, "recorded": False, "costUsd": 0.0}
    else:
        quantity = body.durationSeconds
        charge = estimate_compute_charge(
            provider=body.provider,
            duration_seconds=body.durationSeconds,
            source=body.source,
            metadata=body.metadata,
            status=body.status,
        )
    user = await load_user_by_id(pool, principal.user_id)
    if user is None:
        return {"ok": False, "recorded": False, "error": "user not found"}
    async with user_scoped_tx(pool, principal.user_id) as conn:
        await ProviderUsageRepository(principal.user_id, conn).record_event(
            ProviderUsageEventInput(
                supabase_user_id=user.supabase_user_id,
                provider=charge.provider,
                product=charge.product,
                source=charge.source,
                quantity_seconds=charge.quantity_seconds,
                cost_usd=charge.cost_usd,
                units=charge.units,
                status=charge.status,
                provider_request_id=body.providerRequestId,
                metadata=charge.metadata or {},
            )
        )
    logger.info(
        "provider usage recorded user=%d provider=%s quantity=%s units=%s cost=$%s source=%s",
        principal.user_id,
        charge.provider,
        quantity,
        charge.units,
        charge.cost_usd,
        charge.source,
    )
    return {"ok": True, "recorded": True, "costUsd": float(charge.cost_usd)}
