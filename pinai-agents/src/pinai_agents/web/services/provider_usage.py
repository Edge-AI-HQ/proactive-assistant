"""Provider usage pricing helpers.

LiteLLM owns token usage. Direct provider calls that bypass LiteLLM, such as
ByteDance ASR, are normalized here before they are written to our own ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from ..db.repositories.provider_usage import (
    ProviderUsageEventInput,
    ProviderUsageRepository,
)
from ..db.rls import user_scoped_tx

ProviderUsageProduct = Literal[
    "bytedance_streaming_asr",
    "bytedance_audio_file_asr",
    "bytedance_audio_file_fast_asr",
    "browserbase_session",
    "daytona_sandbox",
    "tavily_search",
    "tavily_extract",
    "composio_tool_call",
]
ProviderUsageStatus = Literal["succeeded", "failed"]

BYTEDANCE_PROVIDER = "bytedance"
BYTEDANCE_STREAMING_ASR: ProviderUsageProduct = "bytedance_streaming_asr"
BYTEDANCE_AUDIO_FILE_ASR: ProviderUsageProduct = "bytedance_audio_file_asr"
BYTEDANCE_AUDIO_FILE_FAST_ASR: ProviderUsageProduct = "bytedance_audio_file_fast_asr"

BYTEDANCE_ASR_USD_PER_HOUR: dict[ProviderUsageProduct, Decimal] = {
    BYTEDANCE_STREAMING_ASR: Decimal("0.15"),
    BYTEDANCE_AUDIO_FILE_ASR: Decimal("0.12"),
    BYTEDANCE_AUDIO_FILE_FAST_ASR: Decimal("0.36"),
}

# ── Compute providers (browser automation + sandbox) ──
# Charged by ACTIVE-USE time: each browser_tool action / sandbox exec reports
# its wall-clock duration, summed into the user's credit window like ASR. These
# vendors return no per-call dollar cost, so we price duration × a rate here.
# Rate lives on the web side only (the chat process reports duration, never
# cost), so a compromised chat cannot inflate the charge beyond duration × this
# rate (and duration is capped at the /api/agent/usage/record boundary).
#
# Rates are COST-PLUS, anchored on real vendor list prices (checked 2026-06-17):
#   • Browserbase: $0.10–0.12 / browser-hour ⇒ ~$0.002/min vendor cost.
#   • Daytona (our 2 vCPU / 4 GB / 8 GB snapshot): 2×$0.0504 + 4×$0.0162 +
#     3×$0.000108 ≈ $0.166 / running-hour ⇒ ~$0.00277/min vendor cost.
# The values below apply roughly a 2× margin. ADJUST THE MARGIN HERE if pricing
# policy changes; long-term, calibrate against the monthly vendor invoice.
BROWSERBASE_PROVIDER = "browserbase"
DAYTONA_PROVIDER = "daytona"
BROWSERBASE_SESSION: ProviderUsageProduct = "browserbase_session"
DAYTONA_SANDBOX: ProviderUsageProduct = "daytona_sandbox"

COMPUTE_USD_PER_MINUTE: dict[ProviderUsageProduct, Decimal] = {
    BROWSERBASE_SESSION: Decimal("0.004"),  # ~2× vendor (~$0.002/min) → $0.24/hr
    DAYTONA_SANDBOX: Decimal("0.005"),  # ~1.8× vendor (~$0.00277/min) → $0.30/hr
}

# Maps the public `provider` field the chat process reports to its product +
# canonical provider string. Keeps the chat side from having to know products.
COMPUTE_PRODUCT_BY_PROVIDER: dict[str, tuple[str, ProviderUsageProduct]] = {
    BROWSERBASE_PROVIDER: (BROWSERBASE_PROVIDER, BROWSERBASE_SESSION),
    DAYTONA_PROVIDER: (DAYTONA_PROVIDER, DAYTONA_SANDBOX),
}

# ── Per-call providers ──
# Tavily pricing is credit-based. Current public pay-as-you-go rate:
# $0.008 / API credit. Search costs 1 credit (basic) or 2 credits
# (advanced); Extract costs per successful URL batch, computed chat-side
# because only the tool wrapper sees requested/result URLs.
TAVILY_PROVIDER = "tavily"
TAVILY_SEARCH: ProviderUsageProduct = "tavily_search"
TAVILY_EXTRACT: ProviderUsageProduct = "tavily_extract"
TAVILY_USD_PER_API_CREDIT = Decimal("0.008")

# Composio's public additional-call rate is $0.299 / 1K tool calls.
# We only record user-triggered / user-scoped tool calls, not platform
# catalog browsing or OAuth management calls.
COMPOSIO_PROVIDER = "composio"
COMPOSIO_TOOL_CALL: ProviderUsageProduct = "composio_tool_call"
COMPOSIO_USD_PER_TOOL_CALL = Decimal("0.000299")

PCM_BYTES_PER_SECOND = 16_000 * 2
SECONDS_QUANT = Decimal("0.001")
COST_QUANT = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class ProviderUsageCharge:
    provider: str
    product: ProviderUsageProduct
    source: str
    quantity_seconds: Decimal
    cost_usd: Decimal
    currency: str = "USD"
    units: str = "seconds"
    status: ProviderUsageStatus = "succeeded"
    metadata: dict[str, Any] | None = None


def pcm_audio_seconds(audio_bytes: int) -> Decimal:
    if audio_bytes <= 0:
        return Decimal("0.000")
    seconds = Decimal(audio_bytes) / Decimal(PCM_BYTES_PER_SECOND)
    return seconds.quantize(SECONDS_QUANT, rounding=ROUND_HALF_UP)


def estimate_bytedance_streaming_asr_charge(
    *,
    audio_bytes: int,
    source: str,
    metadata: dict[str, Any] | None = None,
    status: ProviderUsageStatus = "succeeded",
) -> ProviderUsageCharge:
    base_metadata = {"audio_bytes": audio_bytes}
    if metadata:
        base_metadata.update(metadata)
    return estimate_bytedance_asr_charge(
        product=BYTEDANCE_STREAMING_ASR,
        duration_seconds=pcm_audio_seconds(audio_bytes),
        source=source,
        metadata=base_metadata,
        status=status,
    )


def estimate_bytedance_asr_charge(
    *,
    product: ProviderUsageProduct,
    duration_seconds: Decimal | int | float,
    source: str,
    metadata: dict[str, Any] | None = None,
    status: ProviderUsageStatus = "succeeded",
) -> ProviderUsageCharge:
    seconds = _seconds_decimal(duration_seconds)
    hourly_rate = BYTEDANCE_ASR_USD_PER_HOUR[product]
    cost = (seconds / Decimal(3600) * hourly_rate).quantize(
        COST_QUANT,
        rounding=ROUND_HALF_UP,
    )
    return ProviderUsageCharge(
        provider=BYTEDANCE_PROVIDER,
        product=product,
        source=source,
        quantity_seconds=seconds,
        cost_usd=cost,
        status=status,
        metadata=metadata or {},
    )


def estimate_compute_charge(
    *,
    provider: str,
    duration_seconds: Decimal | int | float,
    source: str,
    metadata: dict[str, Any] | None = None,
    status: ProviderUsageStatus = "succeeded",
) -> ProviderUsageCharge:
    """Price active-use compute (browser session / sandbox exec) at
    duration × per-minute rate. `provider` is the public key the chat process
    reports ("browserbase" / "daytona"); the product + rate are resolved here
    so the rate never leaves the web side. Raises KeyError on unknown provider
    (the route validates the literal first)."""
    canonical, product = COMPUTE_PRODUCT_BY_PROVIDER[provider]
    seconds = _seconds_decimal(duration_seconds)
    rate = COMPUTE_USD_PER_MINUTE[product]
    cost = (seconds / Decimal(60) * rate).quantize(COST_QUANT, rounding=ROUND_HALF_UP)
    return ProviderUsageCharge(
        provider=canonical,
        product=product,
        source=source,
        quantity_seconds=seconds,
        cost_usd=cost,
        status=status,
        metadata=metadata or {},
    )


def estimate_tavily_charge(
    *,
    product: Literal["tavily_search", "tavily_extract"],
    api_credits: Decimal | int | float,
    source: str,
    metadata: dict[str, Any] | None = None,
    status: ProviderUsageStatus = "succeeded",
) -> ProviderUsageCharge:
    credits = _seconds_decimal(api_credits)
    cost = (credits * TAVILY_USD_PER_API_CREDIT).quantize(
        COST_QUANT,
        rounding=ROUND_HALF_UP,
    )
    return ProviderUsageCharge(
        provider=TAVILY_PROVIDER,
        product=product,
        source=source,
        quantity_seconds=credits,
        units="api_credits",
        cost_usd=cost,
        status=status,
        metadata=metadata or {},
    )


def estimate_composio_tool_call_charge(
    *,
    tool_calls: Decimal | int | float,
    source: str,
    metadata: dict[str, Any] | None = None,
    status: ProviderUsageStatus = "succeeded",
) -> ProviderUsageCharge:
    calls = _seconds_decimal(tool_calls)
    cost = (calls * COMPOSIO_USD_PER_TOOL_CALL).quantize(
        COST_QUANT,
        rounding=ROUND_HALF_UP,
    )
    return ProviderUsageCharge(
        provider=COMPOSIO_PROVIDER,
        product=COMPOSIO_TOOL_CALL,
        source=source,
        quantity_seconds=calls,
        units="tool_calls",
        cost_usd=cost,
        status=status,
        metadata=metadata or {},
    )


async def record_provider_usage_charge(
    pool: Any,
    *,
    user_id: int,
    supabase_user_id: str,
    charge: ProviderUsageCharge,
    provider_request_id: str | None = None,
) -> None:
    async with user_scoped_tx(pool, user_id) as conn:
        await ProviderUsageRepository(user_id, conn).record_event(
            ProviderUsageEventInput(
                supabase_user_id=supabase_user_id,
                provider=charge.provider,
                product=charge.product,
                source=charge.source,
                quantity_seconds=charge.quantity_seconds,
                cost_usd=charge.cost_usd,
                currency=charge.currency,
                units=charge.units,
                status=charge.status,
                provider_request_id=provider_request_id,
                metadata=charge.metadata or {},
            )
        )


def _seconds_decimal(value: Decimal | int | float) -> Decimal:
    seconds = value if isinstance(value, Decimal) else Decimal(str(value))
    if seconds <= 0:
        return Decimal("0.000")
    return seconds.quantize(SECONDS_QUANT, rounding=ROUND_HALF_UP)
