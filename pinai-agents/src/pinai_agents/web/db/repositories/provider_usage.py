"""Provider usage ledger repository.

Rows are user-scoped cost facts for provider calls that do not naturally flow
through LiteLLM token accounting.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal

from psycopg.types.json import Jsonb

from .base import UserScopedRepository

ProviderUsageStatus = Literal["succeeded", "failed"]


@dataclass(frozen=True, slots=True)
class ProviderUsageEventInput:
    supabase_user_id: str
    provider: str
    product: str
    source: str
    quantity_seconds: Decimal
    cost_usd: Decimal
    metadata: dict[str, Any]
    started_at: datetime | None = None
    ended_at: datetime | None = None
    currency: str = "USD"
    units: str = "seconds"
    status: ProviderUsageStatus = "succeeded"
    provider_request_id: str | None = None


class ProviderUsageRepository(UserScopedRepository):
    async def record_event(self, event: ProviderUsageEventInput) -> None:
        await self.conn.execute(
            """
            INSERT INTO pai_provider_usage_events (
              user_id,
              supabase_user_id,
              provider,
              product,
              source,
              units,
              quantity_seconds,
              cost_usd,
              currency,
              status,
              provider_request_id,
              metadata,
              started_at,
              ended_at
            )
            VALUES (
              %(user_id)s,
              %(supabase_user_id)s,
              %(provider)s,
              %(product)s,
              %(source)s,
              %(units)s,
              %(quantity_seconds)s,
              %(cost_usd)s,
              %(currency)s,
              %(status)s,
              %(provider_request_id)s,
              %(metadata)s,
              %(started_at)s,
              %(ended_at)s
            )
            """,
            {
                "user_id": self.user_id,
                "supabase_user_id": event.supabase_user_id,
                "provider": event.provider,
                "product": event.product,
                "source": event.source,
                "units": event.units,
                "quantity_seconds": event.quantity_seconds,
                "cost_usd": event.cost_usd,
                "currency": event.currency,
                "status": event.status,
                "provider_request_id": event.provider_request_id,
                "metadata": Jsonb(event.metadata),
                "started_at": event.started_at,
                "ended_at": event.ended_at,
            },
        )
