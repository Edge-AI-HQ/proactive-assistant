"""Voice transcription via LiteLLM's OpenAI-compatible audio endpoint."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import httpx

from ...config import get_web_settings
from ..litellm.client import LiteLLMError

DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"
DIARIZED_TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize"
MIXED_ZH_EN_TRANSCRIPTION_PROMPT = (
    "The audio may contain mixed Mandarin Chinese and English. Transcribe exactly what is spoken. "
    "Keep English words, product names, acronyms, and technical terms in English. "
    "Use Simplified Chinese for Chinese speech. Do not translate between languages.\n\n"
    "Common terms may include: Claude Code, Codex, ChatGPT, GPT, OpenAI, Gemini, Cursor, "
    "Supabase, LiteLLM, Composio, LangSmith, Daytona, Fly.io, Vercel, GitHub, pull request, "
    "PR, commit, branch, merge, rebase, deploy, Docker, Xcode, iOS, Android, Ambient, "
    "PIN AI, Proactive AI."
)
ALLOWED_TRANSCRIPTION_MODELS = frozenset(
    {DEFAULT_TRANSCRIPTION_MODEL, "gpt-4o-mini-transcribe"},
)
SUPPORTED_TRANSCRIPTION_LANGUAGES = frozenset(
    {"en", "zh", "ja", "ko", "es", "fr", "de", "pt"},
)
TRANSCRIPTION_LANGUAGE_ALIASES = {
    "zh-hans": "zh",
    "zh-cn": "zh",
    "zh": "zh",
    "en-us": "en",
    "en-gb": "en",
    "pt-br": "pt",
    "pt-pt": "pt",
}
MAX_AUDIO_BYTES = 25 * 1024 * 1024


@dataclass(slots=True)
class SpeakerSegment:
    speaker: str
    text: str
    start_ms: int | None
    end_ms: int | None


@dataclass(slots=True)
class DiarizedTranscriptionResult:
    text: str
    segments: list[SpeakerSegment]


def normalize_transcription_language(language: str | None) -> str | None:
    raw = (language or "").strip()
    if not raw:
        return None
    key = raw.replace("_", "-").lower()
    if key == "auto":
        return None
    normalized = TRANSCRIPTION_LANGUAGE_ALIASES.get(key, key.split("-", maxsplit=1)[0])
    if normalized not in SUPPORTED_TRANSCRIPTION_LANGUAGES:
        allowed = ", ".join(sorted(SUPPORTED_TRANSCRIPTION_LANGUAGES))
        msg = f"language must be one of: {allowed}"
        raise ValueError(msg)
    return normalized


async def transcribe_audio(
    *,
    audio: bytes,
    content_type: str,
    filename: str,
    bearer_token: str,
    model: str = DEFAULT_TRANSCRIPTION_MODEL,
    language: str | None = None,
) -> str:
    if model not in ALLOWED_TRANSCRIPTION_MODELS:
        msg = f"unsupported transcription model: {model}"
        raise LiteLLMError(400, msg)
    if not audio:
        msg = "audio payload is empty"
        raise LiteLLMError(400, msg)
    if len(audio) > MAX_AUDIO_BYTES:
        msg = f"audio payload exceeds {MAX_AUDIO_BYTES} bytes"
        raise LiteLLMError(413, msg)

    settings = get_web_settings()
    base_url = (settings.litellm_base_url or "").rstrip("/")
    if base_url and not base_url.endswith("/v1"):
        base_url = f"{base_url}/v1"
    if not base_url:
        raise LiteLLMError(500, "LITELLM_BASE_URL not configured")
    if not bearer_token:
        raise LiteLLMError(500, "LiteLLM virtual key not configured")

    data = {
        "model": model,
        "response_format": "json",
        "prompt": MIXED_ZH_EN_TRANSCRIPTION_PROMPT,
    }
    if language:
        data["language"] = language
    files = {
        "file": (
            filename,
            audio,
            content_type or "application/octet-stream",
        ),
    }
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "Accept": "application/json",
    }

    timeout = httpx.Timeout(connect=5.0, read=60.0, write=30.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{base_url}/audio/transcriptions",
            data=data,
            files=files,
            headers=headers,
        )

    parsed: Any
    try:
        parsed = response.json()
    except ValueError:
        parsed = {"message": response.text}

    if not response.is_success:
        detail = _error_message(parsed) or response.text[:300]
        raise LiteLLMError(response.status_code, detail)

    text = parsed.get("text") if isinstance(parsed, dict) else None
    if not isinstance(text, str):
        raise LiteLLMError(502, "/audio/transcriptions response missing text")
    return text


async def transcribe_audio_diarized(
    *,
    audio: bytes,
    content_type: str,
    filename: str,
    bearer_token: str,
    known_speaker_reference: bytes,
    known_speaker_reference_mime: str,
    model: str = DIARIZED_TRANSCRIPTION_MODEL,
    language: str | None = None,
) -> DiarizedTranscriptionResult:
    if model != DIARIZED_TRANSCRIPTION_MODEL:
        msg = f"unsupported diarized transcription model: {model}"
        raise LiteLLMError(400, msg)
    if not known_speaker_reference:
        msg = "known speaker reference is empty"
        raise LiteLLMError(400, msg)
    _validate_audio(audio)

    settings = get_web_settings()
    base_url = (settings.litellm_base_url or "").rstrip("/")
    if base_url and not base_url.endswith("/v1"):
        base_url = f"{base_url}/v1"
    if not base_url:
        raise LiteLLMError(500, "LITELLM_BASE_URL not configured")
    if not bearer_token:
        raise LiteLLMError(500, "LiteLLM virtual key not configured")

    reference_mime = known_speaker_reference_mime or "audio/wav"
    reference_data_url = (
        f"data:{reference_mime};base64,{base64.b64encode(known_speaker_reference).decode('ascii')}"
    )
    data = {
        "model": model,
        "response_format": "diarized_json",
        "chunking_strategy": "auto",
        "known_speaker_names[]": "self",
        "known_speaker_references[]": reference_data_url,
    }
    if language:
        data["language"] = language
    files = {
        "file": (
            filename,
            audio,
            content_type or "application/octet-stream",
        ),
    }
    headers = {
        "Authorization": f"Bearer {bearer_token}",
        "Accept": "application/json",
    }

    timeout = httpx.Timeout(connect=5.0, read=90.0, write=30.0, pool=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{base_url}/audio/transcriptions",
            data=data,
            files=files,
            headers=headers,
        )

    parsed: Any
    try:
        parsed = response.json()
    except ValueError:
        parsed = {"message": response.text}

    if not response.is_success:
        detail = _error_message(parsed) or response.text[:300]
        raise LiteLLMError(response.status_code, detail)
    return _parse_diarized_transcription(parsed)


def _validate_audio(audio: bytes) -> None:
    if not audio:
        msg = "audio payload is empty"
        raise LiteLLMError(400, msg)
    if len(audio) > MAX_AUDIO_BYTES:
        msg = f"audio payload exceeds {MAX_AUDIO_BYTES} bytes"
        raise LiteLLMError(413, msg)


def _parse_diarized_transcription(payload: Any) -> DiarizedTranscriptionResult:
    if not isinstance(payload, dict):
        raise LiteLLMError(502, "/audio/transcriptions response was not JSON")
    text = payload.get("text")
    if not isinstance(text, str):
        raise LiteLLMError(502, "/audio/transcriptions response missing text")
    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, list):
        raise LiteLLMError(502, "/audio/transcriptions diarized response missing segments")

    segments: list[SpeakerSegment] = []
    for raw in raw_segments:
        if not isinstance(raw, dict):
            continue
        segment_text = raw.get("text")
        if not isinstance(segment_text, str) or not segment_text.strip():
            continue
        speaker = raw.get("speaker")
        segments.append(
            SpeakerSegment(
                speaker=speaker.strip()
                if isinstance(speaker, str) and speaker.strip()
                else "other",
                text=segment_text.strip(),
                start_ms=_seconds_to_ms(raw.get("start")),
                end_ms=_seconds_to_ms(raw.get("end")),
            )
        )
    return DiarizedTranscriptionResult(text=text.strip(), segments=segments)


def _seconds_to_ms(value: Any) -> int | None:
    if not isinstance(value, int | float):
        return None
    return int(round(float(value) * 1000))


def _error_message(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if isinstance(error, dict):
        message = error.get("message") or error.get("detail")
        if isinstance(message, str) and message.strip():
            return message.strip()
    for key in ("message", "detail", "error"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
