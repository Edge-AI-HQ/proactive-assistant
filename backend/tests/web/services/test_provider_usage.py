from __future__ import annotations

from decimal import Decimal

from pinai_api.domains.billing.metering import (
    BYTEDANCE_AUDIO_FILE_ASR,
    BYTEDANCE_AUDIO_FILE_FAST_ASR,
    BYTEDANCE_STREAMING_ASR,
    estimate_bytedance_asr_charge,
    estimate_bytedance_streaming_asr_charge,
)


def test_estimate_bytedance_streaming_asr_charge_from_pcm_bytes():
    charge = estimate_bytedance_streaming_asr_charge(
        audio_bytes=32_000,
        source="main_chat_voice",
    )

    assert charge.provider == "bytedance"
    assert charge.product == BYTEDANCE_STREAMING_ASR
    assert charge.quantity_seconds == Decimal("1.000")
    assert charge.cost_usd == Decimal("0.000042")
    assert charge.metadata["audio_bytes"] == 32_000


def test_estimate_bytedance_file_asr_rates_are_reserved():
    standard = estimate_bytedance_asr_charge(
        product=BYTEDANCE_AUDIO_FILE_ASR,
        duration_seconds=3600,
        source="file_transcription",
    )
    fast = estimate_bytedance_asr_charge(
        product=BYTEDANCE_AUDIO_FILE_FAST_ASR,
        duration_seconds=3600,
        source="file_transcription",
    )

    assert standard.cost_usd == Decimal("0.120000")
    assert fast.cost_usd == Decimal("0.360000")
