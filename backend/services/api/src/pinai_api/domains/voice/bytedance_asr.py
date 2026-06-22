"""ByteDance / Volcengine streaming ASR protocol helpers.

The frontend sends plain 16 kHz mono PCM chunks to our own WebSocket route.
This module keeps ByteDance credentials server-side and translates those
chunks into the v3 binary WebSocket protocol used by the official bigmodel
streaming ASR API.
"""

from __future__ import annotations

import asyncio
import gzip
import inspect
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import websockets
from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

ByteDanceAsrUsageStatus = Literal["succeeded", "failed"]

PROTOCOL_VERSION = 0x1
HEADER_SIZE_WORDS = 0x1

CLIENT_FULL_REQUEST = 0x1
CLIENT_AUDIO_ONLY_REQUEST = 0x2
SERVER_FULL_RESPONSE = 0x9
SERVER_ACK = 0xB
SERVER_ERROR_RESPONSE = 0xF

FLAG_NO_SEQUENCE = 0x0
FLAG_POS_SEQUENCE = 0x1
FLAG_NEG_SEQUENCE = 0x2
FLAG_NEG_WITH_SEQUENCE = 0x3

SERIALIZATION_JSON = 0x1
COMPRESSION_GZIP = 0x1

SAMPLE_RATE = 16_000
CHANNELS = 1
BITS_PER_SAMPLE = 16

ConnectFactory = Callable[..., Any]


@dataclass(frozen=True, slots=True)
class ByteDanceAsrConfig:
    app_key: str
    access_key: str
    endpoint: str
    resource_id: str
    user_id: str
    model_name: str = "bigmodel"
    enable_punc: bool = True
    enable_itn: bool = True
    enable_ddc: bool = True
    show_utterances: bool = True
    enable_nonstream: bool = True
    ssd_version: str = "200"
    result_type: str = "full"
    end_window_size: int = 800

    def auth_headers(self) -> dict[str, str]:
        return {
            "X-Api-Resource-Id": self.resource_id,
            "X-Api-Request-Id": str(uuid.uuid4()),
            "X-Api-Access-Key": self.access_key,
            "X-Api-App-Key": self.app_key,
        }


@dataclass(frozen=True, slots=True)
class ByteDanceAsrResponse:
    message_type: int
    sequence: int
    is_last_package: bool
    payload: dict[str, Any] | None
    text: str | None
    is_final: bool
    code: int
    error_message: str | None


@dataclass(frozen=True, slots=True)
class ByteDanceAsrSessionUsage:
    audio_bytes: int
    started_at: datetime
    ended_at: datetime
    latest_text: str | None = None
    status: ByteDanceAsrUsageStatus = "succeeded"
    error_message: str | None = None
    error_code: int | None = None

    @property
    def duration_seconds(self) -> float:
        return self.audio_bytes / float(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE // 8))


async def proxy_bytedance_asr(
    client_ws: WebSocket,
    config: ByteDanceAsrConfig,
    *,
    connect: ConnectFactory = websockets.connect,
) -> ByteDanceAsrSessionUsage:
    """Bridge one frontend voice WebSocket to one ByteDance ASR WebSocket."""

    sequence = 1
    upstream = None
    final_sent = False
    audio_bytes = 0
    latest_text: str | None = None
    status: ByteDanceAsrUsageStatus = "succeeded"
    error_message: str | None = None
    error_code: int | None = None
    started_at = datetime.now(UTC)
    try:
        upstream = await connect(
            config.endpoint,
            **_connect_options(connect, config.auth_headers()),
            max_size=None,
            ping_interval=30,
            ping_timeout=20,
        )
        await upstream.send(build_full_client_request(config, sequence=sequence))
        sequence += 1

        async def receive_client_audio() -> None:
            nonlocal sequence, final_sent, audio_bytes
            while True:
                try:
                    message = await client_ws.receive()
                except RuntimeError as exc:
                    if "disconnect message has been received" in str(exc):
                        return
                    raise
                if "bytes" in message and message["bytes"] is not None:
                    pcm = message["bytes"]
                    if pcm:
                        audio_bytes += len(pcm)
                        await upstream.send(
                            build_audio_only_request(
                                sequence=sequence,
                                pcm_audio=pcm,
                            )
                        )
                        sequence += 1
                    continue

                text = message.get("text")
                if text:
                    try:
                        payload = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(payload, dict) and payload.get("type") == "end":
                        await upstream.send(
                            build_audio_only_request(
                                sequence=sequence,
                                pcm_audio=b"",
                                is_last=True,
                            )
                        )
                        final_sent = True
                        return

        async def receive_asr_events() -> None:
            nonlocal latest_text, status, error_message, error_code
            async for raw in upstream:
                if not isinstance(raw, bytes):
                    continue
                response = parse_response(raw)
                if response.error_message:
                    status = "failed"
                    error_message = response.error_message
                    error_code = response.code
                    await client_ws.send_json(
                        {
                            "type": "error",
                            "message": response.error_message,
                            "code": response.code,
                        }
                    )
                    return
                if response.text:
                    latest_text = response.text
                    await client_ws.send_json(
                        {
                            "type": "final" if response.is_final else "partial",
                            "text": response.text,
                        }
                    )
                if response.is_last_package:
                    return

        client_task = asyncio.create_task(receive_client_audio())
        upstream_task = asyncio.create_task(receive_asr_events())
        done, pending = await asyncio.wait(
            {client_task, upstream_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in done:
            task.result()
        if client_task in done and final_sent and upstream_task not in done:
            await asyncio.wait({upstream_task}, timeout=3)
        for task in pending:
            task.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        status = "failed"
        error_message = str(exc)
        logger.warning("ByteDance ASR stream failed: %s", exc)
        await _safe_send_error(client_ws, str(exc))
    finally:
        if upstream is not None:
            await _maybe_await(upstream.close())
    return ByteDanceAsrSessionUsage(
        audio_bytes=audio_bytes,
        latest_text=latest_text,
        status=status,
        error_message=error_message,
        error_code=error_code,
        started_at=started_at,
        ended_at=datetime.now(UTC),
    )


def build_full_client_request(config: ByteDanceAsrConfig, *, sequence: int) -> bytes:
    payload = {
        "user": {"uid": config.user_id},
        "audio": {
            "format": "pcm",
            "codec": "raw",
            "rate": SAMPLE_RATE,
            "bits": BITS_PER_SAMPLE,
            "channel": CHANNELS,
        },
        "request": {
            "model_name": config.model_name,
            "enable_itn": config.enable_itn,
            "enable_punc": config.enable_punc,
            "enable_ddc": config.enable_ddc,
            "show_utterances": config.show_utterances,
            "enable_nonstream": config.enable_nonstream,
            "ssd_version": config.ssd_version,
            "result_type": config.result_type,
            "end_window_size": config.end_window_size,
        },
    }
    return _build_message(
        CLIENT_FULL_REQUEST,
        FLAG_POS_SEQUENCE,
        sequence,
        _gzip_json(payload),
    )


def _connect_options(connect: ConnectFactory, headers: dict[str, str]) -> dict[str, object]:
    try:
        parameters = inspect.signature(connect).parameters
    except (TypeError, ValueError):
        return {"additional_headers": headers}
    if "additional_headers" in parameters:
        return {"additional_headers": headers}
    return {"extra_headers": headers}


def build_audio_only_request(
    *,
    sequence: int,
    pcm_audio: bytes,
    is_last: bool = False,
) -> bytes:
    flags = FLAG_NEG_WITH_SEQUENCE if is_last else FLAG_POS_SEQUENCE
    actual_sequence = -sequence if is_last else sequence
    return _build_message(
        CLIENT_AUDIO_ONLY_REQUEST,
        flags,
        actual_sequence,
        gzip.compress(pcm_audio),
    )


def parse_response(message: bytes) -> ByteDanceAsrResponse:
    if len(message) < 4:
        return ByteDanceAsrResponse(
            message_type=0,
            sequence=0,
            is_last_package=False,
            payload=None,
            text=None,
            is_final=False,
            code=-1,
            error_message="empty ASR response",
        )

    header_size = message[0] & 0x0F
    message_type = (message[1] >> 4) & 0x0F
    flags = message[1] & 0x0F
    serialization = (message[2] >> 4) & 0x0F
    compression = message[2] & 0x0F
    offset = header_size * 4

    sequence = 0
    if flags & 0x01 and offset + 4 <= len(message):
        sequence = int.from_bytes(message[offset : offset + 4], "big", signed=True)
        offset += 4

    is_last_package = bool(flags & 0x02)
    code = 0
    payload_size = 0
    if message_type == SERVER_ERROR_RESPONSE and offset + 8 <= len(message):
        code = int.from_bytes(message[offset : offset + 4], "big", signed=True)
        payload_size = int.from_bytes(message[offset + 4 : offset + 8], "big")
        offset += 8
    elif message_type in {SERVER_FULL_RESPONSE, SERVER_ACK} and offset + 4 <= len(message):
        payload_size = int.from_bytes(message[offset : offset + 4], "big")
        offset += 4

    payload: dict[str, Any] | None = None
    error_message: str | None = None
    if payload_size > 0 and offset < len(message):
        payload_bytes = message[offset : offset + payload_size]
        if compression == COMPRESSION_GZIP:
            payload_bytes = gzip.decompress(payload_bytes)
        if serialization == SERIALIZATION_JSON:
            decoded = json.loads(payload_bytes.decode("utf-8"))
            if isinstance(decoded, dict):
                payload = decoded
        else:
            error_message = payload_bytes.decode("utf-8", errors="replace")

    if payload:
        payload_code = payload.get("code")
        if isinstance(payload_code, int) and payload_code != 0:
            code = payload_code
        message_text = payload.get("message") or payload.get("error")
        if isinstance(message_text, str) and message_text.strip():
            error_message = message_text.strip()

    text = _extract_text(payload)
    is_final = is_last_package
    return ByteDanceAsrResponse(
        message_type=message_type,
        sequence=sequence,
        is_last_package=is_last_package,
        payload=payload,
        text=text,
        is_final=is_final,
        code=code,
        error_message=error_message,
    )


def build_server_message_for_test(
    payload: dict[str, Any],
    *,
    message_type: int = SERVER_FULL_RESPONSE,
    sequence: int = 1,
    final: bool = False,
) -> bytes:
    flags = FLAG_NEG_WITH_SEQUENCE if final else FLAG_POS_SEQUENCE
    compressed = _gzip_json(payload)
    if message_type == SERVER_ERROR_RESPONSE:
        code = payload.get("code")
        return b"".join(
            [
                _header(message_type, FLAG_NO_SEQUENCE),
                (code if isinstance(code, int) else 0).to_bytes(4, "big", signed=True),
                len(compressed).to_bytes(4, "big"),
                compressed,
            ]
        )
    header = _header(message_type, flags)
    return b"".join(
        [
            header,
            sequence.to_bytes(4, "big", signed=True),
            len(compressed).to_bytes(4, "big"),
            compressed,
        ]
    )


def _build_message(message_type: int, flags: int, sequence: int, payload: bytes) -> bytes:
    return b"".join(
        [
            _header(message_type, flags),
            sequence.to_bytes(4, "big", signed=True),
            len(payload).to_bytes(4, "big"),
            payload,
        ]
    )


def _header(
    message_type: int,
    flags: int,
    serialization: int = SERIALIZATION_JSON,
    compression: int = COMPRESSION_GZIP,
) -> bytes:
    return bytes(
        [
            (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
            (message_type << 4) | flags,
            (serialization << 4) | compression,
            0x00,
        ]
    )


def _gzip_json(payload: dict[str, Any]) -> bytes:
    return gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def _extract_text(payload: dict[str, Any] | None) -> str | None:
    if not payload:
        return None
    result = payload.get("result")
    if isinstance(result, dict):
        text = result.get("text")
        if isinstance(text, str) and text.strip():
            return text.strip()
        text = _extract_utterance_text(result.get("utterances"))
        if text:
            return text
    return _extract_utterance_text(payload.get("utterances"))


def _extract_utterance_text(utterances: object) -> str | None:
    if isinstance(utterances, list):
        parts: list[str] = []
        for utterance in utterances:
            if not isinstance(utterance, dict):
                continue
            text = utterance.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
        if parts:
            return " ".join(parts)
    return None


async def _safe_send_error(client_ws: WebSocket, message: str) -> None:
    try:
        await client_ws.send_json({"type": "error", "message": message})
    except Exception:
        return


async def _maybe_await(value: Any) -> None:
    if isinstance(value, Awaitable):
        await value
