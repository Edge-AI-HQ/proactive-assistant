"""Reserved ByteDance audio-file ASR integration point.

The product/rate is already represented in provider_usage.py. This service
keeps the future file-transcription path explicit without exposing a route
before upload/result polling semantics are decided.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..billing.metering import (
    BYTEDANCE_AUDIO_FILE_ASR,
    BYTEDANCE_AUDIO_FILE_FAST_ASR,
    ProviderUsageProduct,
)


@dataclass(frozen=True, slots=True)
class ByteDanceFileAsrRequest:
    audio_url: str
    supabase_user_id: str
    fast_mode: bool = False
    language: str | None = None

    @property
    def product(self) -> ProviderUsageProduct:
        return BYTEDANCE_AUDIO_FILE_FAST_ASR if self.fast_mode else BYTEDANCE_AUDIO_FILE_ASR


@dataclass(frozen=True, slots=True)
class ByteDanceFileAsrResult:
    text: str
    duration_seconds: float
    provider_request_id: str | None = None


async def transcribe_bytedance_audio_file(
    _request: ByteDanceFileAsrRequest,
) -> ByteDanceFileAsrResult:
    raise NotImplementedError("ByteDance audio-file ASR is reserved but not wired yet")
