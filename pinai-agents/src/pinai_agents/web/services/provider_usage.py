"""Provider usage pricing helpers.

LiteLLM owns token usage. Direct provider calls that bypass LiteLLM, such as
ByteDance ASR, are normalized here before they are written to our own ledger.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

ProviderUsageProduct = Literal[
    "bytedance_streaming_asr",
    "bytedance_audio_file_asr",
    "bytedance_audio_file_fast_asr",
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


def _seconds_decimal(value: Decimal | int | float) -> Decimal:
    seconds = value if isinstance(value, Decimal) else Decimal(str(value))
    if seconds <= 0:
        return Decimal("0.000")
    return seconds.quantize(SECONDS_QUANT, rounding=ROUND_HALF_UP)
