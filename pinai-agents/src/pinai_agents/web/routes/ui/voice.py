"""Frontend voice-input helpers."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status

from ...auth.deps import User, current_user, get_pool
from ...litellm.client import LiteLLMError
from ...services.litellm_provisioning import ensure_user_litellm_key
from ...services.voice_transcription import (
    ALLOWED_TRANSCRIPTION_MODELS,
    DEFAULT_TRANSCRIPTION_MODEL,
    MAX_AUDIO_BYTES,
    normalize_transcription_language,
    transcribe_audio,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice", tags=["voice"])

SUPPORTED_AUDIO_CONTENT_TYPES = {
    "application/octet-stream",
    "video/webm",
}


@router.post("/transcribe")
async def transcribe_voice_input(
    request: Request,
    model: str = Query(DEFAULT_TRANSCRIPTION_MODEL),
    language: str | None = Query(default="zh"),
    x_audio_filename: str | None = Header(default=None),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, object]:
    if model not in ALLOWED_TRANSCRIPTION_MODELS:
        allowed = ", ".join(sorted(ALLOWED_TRANSCRIPTION_MODELS))
        raise HTTPException(
            status_code=422,
            detail=f"model must be one of: {allowed}",
        )
    try:
        language_hint = normalize_transcription_language(language)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    content_type = request.headers.get("content-type", "application/octet-stream")
    if not _is_supported_audio_content_type(content_type):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"unsupported audio content type: {content_type}",
        )

    audio = await request.body()
    if not audio:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="audio payload is empty",
        )
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"audio payload exceeds {MAX_AUDIO_BYTES} bytes",
        )

    filename = _safe_audio_filename(x_audio_filename, content_type)
    try:
        user = await ensure_user_litellm_key(
            pool, user, required_models={model},
        )
    except Exception as exc:
        logger.exception("voice transcription key provisioning failed user=%s", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"unable to provision LiteLLM key: {type(exc).__name__}: {exc}",
        ) from exc
    if not user.litellm_virtual_key:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LiteLLM key missing after provisioning",
        )

    logger.info(
        "voice transcription request user=%s model=%s language=%s bytes=%s content_type=%s",
        user.id,
        model,
        language_hint or "auto",
        len(audio),
        content_type,
    )
    try:
        text = await transcribe_audio(
            audio=audio,
            content_type=content_type,
            filename=filename,
            bearer_token=user.litellm_virtual_key,
            model=model,
            language=language_hint,
        )
    except LiteLLMError as exc:
        logger.warning("voice transcription failed user=%s: %s", user.id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    return {"ok": True, "text": text, "model": model}


def _is_supported_audio_content_type(content_type: str) -> bool:
    media_type = content_type.split(";", maxsplit=1)[0].strip().lower()
    return media_type.startswith("audio/") or media_type in SUPPORTED_AUDIO_CONTENT_TYPES


def _safe_audio_filename(filename: str | None, content_type: str) -> str:
    if filename:
        cleaned = filename.rsplit("/", maxsplit=1)[-1].rsplit("\\", maxsplit=1)[-1]
        if cleaned.strip():
            return cleaned.strip()[:120]
    media_type = content_type.split(";", maxsplit=1)[0].strip().lower()
    if media_type == "audio/mp4":
        return "voice-input.mp4"
    if media_type == "audio/mpeg":
        return "voice-input.mp3"
    if media_type == "audio/wav":
        return "voice-input.wav"
    return "voice-input.webm"
