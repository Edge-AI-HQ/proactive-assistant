"""Frontend voice-input helpers."""

from __future__ import annotations

import hashlib
import io
import logging
import wave

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status

from ...auth.deps import User, current_user, get_pool
from ...db.repositories.voice_identity import (
    VoiceIdentityProfileRow,
    VoiceIdentityRepository,
)
from ...db.rls import user_scoped_tx
from ...litellm.client import LiteLLMError
from ...services.litellm_provisioning import ensure_user_litellm_key
from ...services.voice_transcription import (
    ALLOWED_TRANSCRIPTION_MODELS,
    DEFAULT_TRANSCRIPTION_MODEL,
    DIARIZED_TRANSCRIPTION_MODEL,
    MAX_AUDIO_BYTES,
    normalize_transcription_language,
    transcribe_audio,
    transcribe_audio_diarized,
)
from ...storage import (
    delete_media,
    download_media_bytes,
    upload_user_media_bytes,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice", tags=["voice"])

SUPPORTED_AUDIO_CONTENT_TYPES = {
    "application/octet-stream",
    "video/webm",
}
VOICE_REFERENCE_STORAGE_PATH = "voice_identity/self_reference.wav"
MIN_REFERENCE_DURATION_MS = 2_000
MAX_REFERENCE_DURATION_MS = 10_000


@router.get("/identity")
async def get_voice_identity(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, object]:
    async with user_scoped_tx(pool, user.id) as conn:
        profile = await VoiceIdentityRepository(user.id, conn).get_profile()
    return {"ok": True, "profile": _profile_response(profile)}


@router.post("/identity/reference")
async def upload_voice_identity_reference(
    request: Request,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, object]:
    content_type = request.headers.get("content-type", "application/octet-stream")
    if not _is_supported_audio_content_type(content_type):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"unsupported audio content type: {content_type}",
        )
    audio = await request.body()
    if not audio:
        raise HTTPException(status_code=400, detail="audio payload is empty")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(413, detail=f"audio payload exceeds {MAX_AUDIO_BYTES} bytes")
    duration_ms = _wav_duration_ms(audio)
    if duration_ms < MIN_REFERENCE_DURATION_MS or duration_ms > MAX_REFERENCE_DURATION_MS:
        raise HTTPException(
            status_code=422,
            detail="voice reference must be between 2 and 10 seconds",
        )

    media_type = _media_type(content_type) or "audio/wav"
    storage_path = f"{user.supabase_user_id}/{VOICE_REFERENCE_STORAGE_PATH}"
    uploaded = await upload_user_media_bytes(
        supabase_user_id=user.supabase_user_id,
        storage_path=storage_path,
        data=audio,
        content_type=media_type,
    )
    if uploaded is None:
        raise HTTPException(503, detail="storage not configured")

    async with user_scoped_tx(pool, user.id) as conn:
        profile = await VoiceIdentityRepository(user.id, conn).upsert_profile(
            reference_storage_path=uploaded.storage_path,
            reference_mime=uploaded.mime or media_type,
            reference_byte_len=uploaded.byte_len,
            reference_duration_ms=duration_ms,
            reference_sha256=hashlib.sha256(audio).hexdigest(),
        )
    return {"ok": True, "profile": _profile_response(profile)}


@router.post("/identity")
async def update_voice_identity(
    request: Request,
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, object]:
    body = await request.json()
    if not isinstance(body, dict) or not isinstance(body.get("enabled"), bool):
        raise HTTPException(status_code=422, detail="enabled must be boolean")
    async with user_scoped_tx(pool, user.id) as conn:
        profile = await VoiceIdentityRepository(user.id, conn).set_enabled(body["enabled"])
    if profile is None:
        raise HTTPException(status_code=404, detail="voice identity not enrolled")
    return {"ok": True, "profile": _profile_response(profile)}


@router.delete("/identity/reference")
async def delete_voice_identity_reference(
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, object]:
    async with user_scoped_tx(pool, user.id) as conn:
        repo = VoiceIdentityRepository(user.id, conn)
        profile = await repo.get_profile()
        if profile is not None:
            await delete_media(profile.reference_storage_path)
            await repo.delete_profile()
    return {"ok": True}


@router.post("/transcribe")
async def transcribe_voice_input(
    request: Request,
    model: str = Query(DEFAULT_TRANSCRIPTION_MODEL),
    language: str | None = Query(default=None),
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
            pool,
            user,
            required_models={model},
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


@router.post("/transcribe-diarized")
async def transcribe_voice_input_diarized(
    request: Request,
    language: str | None = Query(default=None),
    x_audio_filename: str | None = Header(default=None),
    user: User = Depends(current_user),
    pool=Depends(get_pool),
) -> dict[str, object]:
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
        raise HTTPException(status_code=400, detail="audio payload is empty")
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(413, detail=f"audio payload exceeds {MAX_AUDIO_BYTES} bytes")

    async with user_scoped_tx(pool, user.id) as conn:
        profile = await VoiceIdentityRepository(user.id, conn).get_profile()
    if profile is None or not profile.enabled:
        raise HTTPException(status_code=409, detail="voice identity not enrolled")
    reference_audio = await download_media_bytes(profile.reference_storage_path)
    if not reference_audio:
        raise HTTPException(status_code=503, detail="voice identity reference unavailable")

    try:
        user = await ensure_user_litellm_key(
            pool,
            user,
            required_models={DIARIZED_TRANSCRIPTION_MODEL},
        )
    except Exception as exc:
        logger.exception("voice diarization key provisioning failed user=%s", user.id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"unable to provision LiteLLM key: {type(exc).__name__}: {exc}",
        ) from exc
    if not user.litellm_virtual_key:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="LiteLLM key missing after provisioning",
        )

    filename = _safe_audio_filename(x_audio_filename, content_type)
    try:
        result = await transcribe_audio_diarized(
            audio=audio,
            content_type=content_type,
            filename=filename,
            bearer_token=user.litellm_virtual_key,
            known_speaker_reference=reference_audio,
            known_speaker_reference_mime=profile.reference_mime,
            language=language_hint,
        )
    except LiteLLMError as exc:
        logger.warning("voice diarization failed user=%s: %s", user.id, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    speaker_labels = _speaker_labels([segment.speaker for segment in result.segments])
    self_text = " ".join(
        segment.text for segment in result.segments if segment.speaker == "self"
    ).strip()
    return {
        "ok": True,
        "text": result.text,
        "model": DIARIZED_TRANSCRIPTION_MODEL,
        "segments": [
            {
                "speaker": segment.speaker,
                "text": segment.text,
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
            }
            for segment in result.segments
        ],
        "selfText": self_text,
        "speakerLabels": speaker_labels,
        "diarizationModel": DIARIZED_TRANSCRIPTION_MODEL,
        "diarizationStatus": "matched_reference"
        if "self" in speaker_labels
        else "diarized_without_reference",
    }


def _is_supported_audio_content_type(content_type: str) -> bool:
    media_type = _media_type(content_type)
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


def _profile_response(profile: VoiceIdentityProfileRow | None) -> dict[str, object] | None:
    if profile is None:
        return None
    return {
        "enabled": profile.enabled,
        "enrolledAt": profile.enrolled_at.isoformat(),
        "updatedAt": profile.updated_at.isoformat(),
        "speakerName": "self",
        "referenceDurationMs": profile.reference_duration_ms,
        "referenceByteLen": profile.reference_byte_len,
        "referenceSha256": profile.reference_sha256,
    }


def _media_type(content_type: str) -> str:
    return content_type.split(";", maxsplit=1)[0].strip().lower()


def _wav_duration_ms(audio: bytes) -> int:
    try:
        with wave.open(io.BytesIO(audio), "rb") as wav:
            frame_rate = wav.getframerate()
            frame_count = wav.getnframes()
    except wave.Error as exc:
        raise HTTPException(status_code=422, detail="voice reference must be WAV audio") from exc
    if frame_rate <= 0:
        raise HTTPException(status_code=422, detail="voice reference has invalid sample rate")
    return int(round(frame_count * 1000 / frame_rate))


def _speaker_labels(labels: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for label in labels:
        if label not in seen:
            seen.add(label)
            out.append(label)
    return out
