"""Frontend voice-input helpers."""

from __future__ import annotations

import hashlib
import io
import logging
import wave

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, WebSocket, status

from ....config import get_web_settings
from ...auth.deps import User, _dev_auth_identity, _maybe_dev_bypass_marker, current_user, get_pool
from ...auth.supabase_jwt import JWTVerifyError, verify_supabase_jwt
from ...auth.user_service import upsert_user_by_supabase_id
from ...db.repositories.provider_usage import ProviderUsageEventInput, ProviderUsageRepository
from ...db.repositories.voice_identity import (
    VoiceIdentityProfileRow,
    VoiceIdentityRepository,
)
from ...db.rls import user_scoped_tx
from ...litellm.client import LiteLLMError
from ...services.bytedance_asr import (
    ByteDanceAsrConfig,
    ByteDanceAsrSessionUsage,
    proxy_bytedance_asr,
)
from ...services.litellm_provisioning import ensure_user_litellm_key
from ...services.provider_usage import estimate_bytedance_streaming_asr_charge
from ...services.voice_transcription import (
    ALLOWED_TRANSCRIPTION_MODELS,
    DEFAULT_TRANSCRIPTION_MODEL,
    DEFAULT_TRANSCRIPTION_POSTPROCESS_MODEL,
    DIARIZED_TRANSCRIPTION_MODEL,
    MAX_AUDIO_BYTES,
    normalize_transcription_language,
    postprocess_diarized_transcription,
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


@router.websocket("/transcribe-stream")
async def transcribe_voice_input_stream(
    websocket: WebSocket,
    language: str | None = Query(default=None),
) -> None:
    await websocket.accept()
    try:
        language_hint = normalize_transcription_language(language)
        auth = await _read_voice_stream_auth(websocket)
        user = await _current_user_for_voice_websocket(
            websocket,
            token=auth.token,
            dev_auth=auth.dev_auth,
        )
    except ValueError as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close(code=1008)
        return
    except HTTPException as exc:
        await websocket.send_json({"type": "error", "message": exc.detail})
        await websocket.close(code=1008)
        return

    settings = get_web_settings()
    if not settings.bytedance_asr_app_key or not settings.bytedance_asr_access_key:
        await websocket.send_json(
            {
                "type": "error",
                "message": "ByteDance streaming ASR is not configured",
            }
        )
        await websocket.close(code=1011)
        return

    logger.info(
        "voice streaming transcription request user=%s language=%s endpoint=%s",
        user.id,
        language_hint or "auto",
        settings.bytedance_asr_endpoint,
    )
    usage = await proxy_bytedance_asr(
        websocket,
        ByteDanceAsrConfig(
            app_key=settings.bytedance_asr_app_key,
            access_key=settings.bytedance_asr_access_key,
            endpoint=settings.bytedance_asr_endpoint,
            resource_id=settings.bytedance_asr_resource_id,
            user_id=user.supabase_user_id,
        ),
    )
    await _record_bytedance_stream_usage(
        websocket,
        user=user,
        usage=usage,
        language_hint=language_hint,
    )


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
            required_models={DIARIZED_TRANSCRIPTION_MODEL, DEFAULT_TRANSCRIPTION_POSTPROCESS_MODEL},
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

    try:
        result = await postprocess_diarized_transcription(
            result=result,
            bearer_token=user.litellm_virtual_key,
        )
    except LiteLLMError as exc:
        logger.warning("voice diarization postprocess failed user=%s: %s", user.id, exc)

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


class _VoiceStreamAuth:
    def __init__(self, *, token: str | None, dev_auth: str | None) -> None:
        self.token = token
        self.dev_auth = dev_auth


async def _read_voice_stream_auth(websocket: WebSocket) -> _VoiceStreamAuth:
    try:
        message = await websocket.receive_json()
    except Exception as exc:
        raise HTTPException(status_code=1008, detail="voice stream auth frame missing") from exc
    if not isinstance(message, dict) or message.get("type") != "auth":
        raise HTTPException(status_code=1008, detail="voice stream auth frame missing")
    token = message.get("token")
    dev_auth = message.get("dev_auth")
    return _VoiceStreamAuth(
        token=token.strip() if isinstance(token, str) and token.strip() else None,
        dev_auth=dev_auth.strip() if isinstance(dev_auth, str) and dev_auth.strip() else None,
    )


async def _current_user_for_voice_websocket(
    websocket: WebSocket,
    *,
    token: str | None,
    dev_auth: str | None,
) -> User:
    settings = get_web_settings()
    identity = _dev_auth_identity(_maybe_dev_bypass_marker(dev_auth))
    if settings.deploy_env == "dev" and identity is not None:
        logger.info("dev auth bypass active for voice stream role=%s", identity.role)
        pool = getattr(websocket.app.state, "pool", None)
        if pool is None:
            return User(
                id=0,
                supabase_user_id=identity.supabase_user_id,
                email=identity.email,
                litellm_virtual_key=None,
                browserbase_context_id=None,
            )
        return await upsert_user_by_supabase_id(
            pool,
            supabase_user_id=identity.supabase_user_id,
            email=identity.email,
        )

    pool = getattr(websocket.app.state, "pool", None)
    if pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB pool not initialized",
        )

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="voice stream auth token missing",
        )
    try:
        claims = await verify_supabase_jwt(token)
    except JWTVerifyError as exc:
        logger.info("Supabase JWT verify failed for voice stream: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid Supabase token",
        ) from exc

    return await upsert_user_by_supabase_id(
        pool,
        supabase_user_id=claims.sub,
        email=claims.email,
    )


async def _record_bytedance_stream_usage(
    websocket: WebSocket,
    *,
    user: User,
    usage: ByteDanceAsrSessionUsage,
    language_hint: str | None,
) -> None:
    logger.info(
        "voice streaming transcription finished user=%s audio_bytes=%s duration=%.3fs latest_text_len=%s",
        user.id,
        usage.audio_bytes,
        usage.duration_seconds,
        len(usage.latest_text or ""),
    )
    if user.id <= 0 or usage.audio_bytes <= 0:
        return
    pool = getattr(websocket.app.state, "pool", None)
    if pool is None:
        return
    charge = estimate_bytedance_streaming_asr_charge(
        audio_bytes=usage.audio_bytes,
        source="main_chat_voice",
        metadata={
            "language": language_hint or "auto",
            "latest_text_len": len(usage.latest_text or ""),
            **({"error_message": usage.error_message} if usage.error_message else {}),
            **({"error_code": usage.error_code} if usage.error_code is not None else {}),
        },
        status=usage.status,
    )
    try:
        async with user_scoped_tx(pool, user.id) as conn:
            await ProviderUsageRepository(user.id, conn).record_event(
                ProviderUsageEventInput(
                    supabase_user_id=user.supabase_user_id,
                    provider=charge.provider,
                    product=charge.product,
                    source=charge.source,
                    quantity_seconds=charge.quantity_seconds,
                    cost_usd=charge.cost_usd,
                    currency=charge.currency,
                    status=charge.status,
                    metadata=charge.metadata or {},
                    started_at=usage.started_at,
                    ended_at=usage.ended_at,
                )
            )
    except Exception as exc:
        logger.warning("failed to record ByteDance ASR usage user=%s: %s", user.id, exc)


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
