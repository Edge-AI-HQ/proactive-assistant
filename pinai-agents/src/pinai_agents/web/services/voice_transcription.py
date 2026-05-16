"""Voice transcription via LiteLLM's OpenAI-compatible audio endpoint."""

from __future__ import annotations

from typing import Any

import httpx

from ...config import get_web_settings
from ..litellm.client import LiteLLMError

DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe"
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


def normalize_transcription_language(language: str | None) -> str | None:
    raw = (language or "").strip()
    if not raw:
        return "zh"
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
    language: str | None = "zh",
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

    data = {"model": model, "response_format": "json"}
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
