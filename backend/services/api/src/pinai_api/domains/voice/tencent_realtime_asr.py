"""Tencent Real-Time ASR (v2 WebSocket) signed URL minter.

BLE recorder audio → Tencent RTASR websocket. SecretKey is a master
credential (see trust_boundary.py). The client (iOS PinHardwarePlugin)
requests a short-lived signed WSS URL from ``/api/voice/hardware/tencent-token``
and opens the websocket directly to Tencent. The SecretKey never leaves
the api process.

Signing follows Tencent RTASR v2 spec:
  - URL: wss://asr.cloud.tencent.com/asr/v2/<appid>?<params>
  - Sign string: ``asr.cloud.tencent.com/asr/v2/<appid>?<sorted params>``
  - Signature: HMAC-SHA1(secret_key, sign_string) → base64 → url-encode
  - Append as ``&signature=<encoded>``

Docs: https://cloud.tencent.com/document/product/1093/48982
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from pinai_api.config import get_web_settings

from ...platform.auth.deps import User, current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/voice/hardware", tags=["voice"])

_TENCENT_HOST = "asr.cloud.tencent.com"
_TENCENT_PATH_TEMPLATE = "/asr/v2/{app_id}"

# The MR20 emits a 16 kHz, 32 kbps MP3 byte stream over BLE. Tencent's
# `voice_format=8` is MP3; `voice_format=1` is raw PCM and silently produces
# no transcript for this device. Keep these server-controlled so the iOS side
# cannot accidentally pick incompatible parameters.
# This Tencent account currently supports the standard speaker engine. The
# 2.0 variant is a separately provisioned model and rejects the websocket
# handshake with code 4001 when it is not enabled for the account.
_DEFAULT_ENGINE_MODEL = "16k_zh_en_speaker"
_DEFAULT_VOICE_FORMAT = "8"


class TencentAsrTokenRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    speaker_context_id: str | None = Field(default=None, max_length=128)


@dataclass(frozen=True)
class TencentAsrMintResult:
    url: str
    voice_id: str
    expires_at: int


def _sorted_query(params: dict[str, str]) -> str:
    # Tencent requires ASCII-sorted, url-encoded, joined by `&`. No signature yet.
    return "&".join(f"{key}={quote(value, safe='')}" for key, value in sorted(params.items()))


def _sign(secret_key: str, path: str, sorted_query: str) -> str:
    # RTASR v2 签名串没有 method 前缀(host+path+?+sorted params)——带 "GET " 的
    # 是老版云 API v1 方案,官方 speech-sdk format_sign_string 可对照。
    sign_str = f"{_TENCENT_HOST}{path}?{sorted_query}"
    digest = hmac.new(secret_key.encode("utf-8"), sign_str.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def _make_signed_url(
    *,
    secret_id: str,
    secret_key: str,
    app_id: str,
    voice_id: str,
    ttl_s: int,
    speaker_context_id: str | None = None,
) -> TencentAsrMintResult:
    now = int(time.time())
    expired = now + ttl_s
    nonce = secrets.randbelow(2**31 - 1)
    path = _TENCENT_PATH_TEMPLATE.format(app_id=app_id)

    params: dict[str, str] = {
        "secretid": secret_id,
        "timestamp": str(now),
        "expired": str(expired),
        "nonce": str(nonce),
        "engine_model_type": _DEFAULT_ENGINE_MODEL,
        "voice_id": voice_id,
        "voice_format": _DEFAULT_VOICE_FORMAT,
        "speaker_diarization": "1",
        "enable_speaker_context": "1",
        "sentence_strategy": "0",
        # ASR post-processing knobs — safe defaults for realtime dictation.
        "needvad": "1",
        "filter_dirty": "1",
        "filter_modal": "1",
        "filter_punc": "1",
        "convert_num_mode": "1",
        "word_info": "2",
    }
    if speaker_context_id:
        params["speaker_context_id"] = speaker_context_id
    sorted_query = _sorted_query(params)
    signature = _sign(secret_key, path, sorted_query)
    encoded_sig = quote(signature, safe="")
    url = f"wss://{_TENCENT_HOST}{path}?{sorted_query}&signature={encoded_sig}"
    return TencentAsrMintResult(url=url, voice_id=voice_id, expires_at=expired)


@router.post("/tencent-token")
async def mint_tencent_asr_token(
    body: TencentAsrTokenRequest = Body(default_factory=TencentAsrTokenRequest),
    user: User = Depends(current_user),
) -> dict[str, object]:
    settings = get_web_settings()
    secret_id = settings.tencent_asr_secret_id
    secret_key = settings.tencent_asr_secret_key
    app_id = settings.tencent_asr_app_id
    if not secret_id or not secret_key or not app_id:
        # Explicit 503 so the client can fall back to phone-mic capture
        # without pretending the hardware feature is generally broken.
        logger.warning(
            "tencent_asr_mint_not_configured",
            extra={
                "user_id": user.id,
                "has_secret_id": bool(secret_id),
                "has_secret_key": bool(secret_key),
                "has_app_id": bool(app_id),
            },
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="pin_hardware_asr_not_configured",
        )

    # Tencent uses `voice_id` as the session id — must be unique per socket.
    # A hex nonce is enough; no user-scoped meaning attached.
    voice_id = secrets.token_hex(16)
    result = _make_signed_url(
        secret_id=secret_id,
        secret_key=secret_key,
        app_id=app_id,
        voice_id=voice_id,
        ttl_s=settings.tencent_asr_token_ttl_s,
        speaker_context_id=body.speaker_context_id,
    )
    return {
        "url": result.url,
        "voice_id": result.voice_id,
        "expires_at": result.expires_at,
        "engine_model_type": _DEFAULT_ENGINE_MODEL,
        "voice_format": _DEFAULT_VOICE_FORMAT,
        "sample_rate_hz": 16000,
        "speaker_diarization": True,
    }
