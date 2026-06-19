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

    async def sum_cost_usd(self, *, since: datetime | None = None) -> Decimal:
        """Total succeeded provider cost for this user (optionally only
        events created at/after `since`).

        Used to fold non-LiteLLM provider spend (e.g. ByteDance streaming
        ASR) into the user's unified usage total. Only 'succeeded' events
        count — a failed call isn't charged. Failures-to-charge stay out
        of the user's bill.
        """
        if since is not None:
            cur = await self.conn.execute(
                """
                SELECT COALESCE(SUM(cost_usd), 0) AS total
                FROM pai_provider_usage_events
                WHERE user_id = %s AND status = 'succeeded' AND created_at >= %s
                """,
                (self.user_id, since),
            )
        else:
            cur = await self.conn.execute(
                """
                SELECT COALESCE(SUM(cost_usd), 0) AS total
                FROM pai_provider_usage_events
                WHERE user_id = %s AND status = 'succeeded'
                """,
                (self.user_id,),
            )
        row = await cur.fetchone()
        total = row["total"] if row else 0
        return Decimal(total)
