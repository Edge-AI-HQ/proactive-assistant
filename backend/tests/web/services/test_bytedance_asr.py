from __future__ import annotations

import asyncio
import gzip
import inspect
import json

from pinai_api.domains.voice import bytedance_asr
from pinai_api.domains.voice.bytedance_asr import (
    CLIENT_AUDIO_ONLY_REQUEST,
    CLIENT_FULL_REQUEST,
    COMPRESSION_GZIP,
    FLAG_NEG_WITH_SEQUENCE,
    FLAG_POS_SEQUENCE,
    SERIALIZATION_JSON,
    SERVER_FULL_RESPONSE,
    ByteDanceAsrConfig,
    build_audio_only_request,
    build_full_client_request,
    build_server_message_for_test,
    parse_response,
    proxy_bytedance_asr,
)


def test_full_client_request_enables_streaming_corrections_and_punctuation():
    config = ByteDanceAsrConfig(
        app_key="app",
        access_key="access",
        endpoint="wss://example.test/api/v3/sauc/bigmodel",
        resource_id="volc.bigasr.sauc.duration",
        user_id="user-123",
    )

    message = build_full_client_request(config, sequence=1)

    assert message[0] == 0x11
    assert message[1] == (CLIENT_FULL_REQUEST << 4) | FLAG_POS_SEQUENCE
    assert message[2] == (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP
    assert int.from_bytes(message[4:8], "big", signed=True) == 1

    payload_size = int.from_bytes(message[8:12], "big")
    payload = json.loads(gzip.decompress(message[12 : 12 + payload_size]))
    assert payload["user"] == {"uid": "user-123"}
    assert payload["audio"] == {
        "format": "pcm",
        "codec": "raw",
        "rate": 16000,
        "bits": 16,
        "channel": 1,
    }
    assert payload["request"]["model_name"] == "bigmodel"
    assert payload["request"]["enable_punc"] is True
    assert payload["request"]["enable_itn"] is True
    assert payload["request"]["enable_ddc"] is True
    assert payload["request"]["show_utterances"] is True
    assert payload["request"]["enable_nonstream"] is True
    assert payload["request"]["ssd_version"] == "200"
    assert payload["request"]["result_type"] == "full"
    assert payload["request"]["end_window_size"] == 800


def test_audio_request_sends_pcm_chunk_without_wav_header_and_marks_last_packet():
    pcm = b"\x01\x00\x02\x00"

    message = build_audio_only_request(sequence=2, pcm_audio=pcm, is_last=True)

    assert message[1] == (CLIENT_AUDIO_ONLY_REQUEST << 4) | FLAG_NEG_WITH_SEQUENCE
    assert int.from_bytes(message[4:8], "big", signed=True) == -2

    payload_size = int.from_bytes(message[8:12], "big")
    payload = gzip.decompress(message[12 : 12 + payload_size])
    assert payload == pcm


def test_parse_response_keeps_definite_utterance_live_until_last_package():
    message = build_server_message_for_test(
        {
            "result": {"text": "今天 review Codex patch。"},
            "utterances": [
                {"text": "今天 review Codex patch。", "definite": True},
            ],
        },
        sequence=8,
        final=False,
    )

    response = parse_response(message)

    assert response.message_type == SERVER_FULL_RESPONSE
    assert response.sequence == 8
    assert response.text == "今天 review Codex patch。"
    assert response.is_final is False
    assert response.error_message is None


def test_parse_response_extracts_nested_utterance_text():
    message = build_server_message_for_test(
        {
            "result": {
                "text": "",
                "utterances": [
                    {"text": "边说边出字", "definite": False},
                ],
            },
        },
        sequence=9,
        final=False,
    )

    response = parse_response(message)

    assert response.text == "边说边出字"
    assert response.is_final is False


def test_parse_response_surfaces_server_error_payload():
    message = build_server_message_for_test(
        {"message": "invalid access key", "code": 4000001},
        message_type=0xF,
    )

    response = parse_response(message)

    assert response.code == 4000001
    assert response.error_message == "invalid access key"


def test_connect_options_follow_installed_websockets_header_name():
    headers = {"X-Api-App-Key": "app"}

    options = bytedance_asr._connect_options(bytedance_asr.websockets.connect, headers)

    expected_key = (
        "additional_headers"
        if "additional_headers" in inspect.signature(bytedance_asr.websockets.connect).parameters
        else "extra_headers"
    )
    assert options == {expected_key: headers}


def test_proxy_forwards_each_pcm_chunk_without_waiting_for_next_chunk():
    sent_messages: list[bytes] = []
    client_ws = FakeClientWebSocket(
        [
            {"bytes": b"\x01\x00" * 1600},
            {"bytes": b"\x02\x00" * 1600},
            {"text": json.dumps({"type": "end"})},
        ]
    )
    upstream = FakeUpstream(sent_messages)
    config = ByteDanceAsrConfig(
        app_key="app",
        access_key="access",
        endpoint="wss://example.test/api/v3/sauc/bigmodel",
        resource_id="volc.bigasr.sauc.duration",
        user_id="user-123",
    )

    async def run() -> None:
        async def connect(*args: object, **kwargs: object) -> FakeUpstream:
            return upstream

        return await proxy_bytedance_asr(
            client_ws,
            config,
            connect=connect,
        )

    usage = asyncio.run(run())

    assert len(sent_messages) == 4
    assert _message_sequence(sent_messages[0]) == 1
    assert _message_sequence(sent_messages[1]) == 2
    assert _message_sequence(sent_messages[2]) == 3
    assert _message_sequence(sent_messages[3]) == -4
    assert usage.audio_bytes == 6400
    assert usage.duration_seconds == 0.2


def test_proxy_sends_live_updates_as_partial_until_last_package():
    client_ws = FakeClientWebSocket(
        [
            {"bytes": b"\x01\x00" * 1600},
        ],
        wait_when_empty=True,
    )
    upstream = FakeUpstream(
        [],
        responses=[
            build_server_message_for_test(
                {
                    "result": {"text": "哈喽哈喽，你好"},
                    "utterances": [
                        {"text": "哈喽哈喽，你好", "definite": True},
                    ],
                },
                sequence=2,
                final=False,
            )
        ],
    )
    config = ByteDanceAsrConfig(
        app_key="app",
        access_key="access",
        endpoint="wss://example.test/api/v3/sauc/bigmodel",
        resource_id="volc.bigasr.sauc.duration",
        user_id="user-123",
    )

    async def run() -> None:
        async def connect(*args: object, **kwargs: object) -> FakeUpstream:
            return upstream

        return await proxy_bytedance_asr(
            client_ws,
            config,
            connect=connect,
        )

    usage = asyncio.run(run())

    assert client_ws.sent_json == [
        {"type": "partial", "text": "哈喽哈喽，你好"},
    ]
    assert usage.latest_text == "哈喽哈喽，你好"


def test_proxy_marks_usage_failed_when_upstream_returns_error():
    client_ws = FakeClientWebSocket(
        [
            {"bytes": b"\x01\x00" * 1600},
        ],
        wait_when_empty=True,
    )
    upstream = FakeUpstream(
        [],
        responses=[
            build_server_message_for_test(
                {"message": "invalid access key", "code": 4000001},
                message_type=0xF,
            )
        ],
    )
    config = ByteDanceAsrConfig(
        app_key="app",
        access_key="access",
        endpoint="wss://example.test/api/v3/sauc/bigmodel",
        resource_id="volc.bigasr.sauc.duration",
        user_id="user-123",
    )

    async def run() -> None:
        async def connect(*args: object, **kwargs: object) -> FakeUpstream:
            return upstream

        return await proxy_bytedance_asr(
            client_ws,
            config,
            connect=connect,
        )

    usage = asyncio.run(run())

    assert client_ws.sent_json == [
        {"type": "error", "message": "invalid access key", "code": 4000001},
    ]
    assert usage.status == "failed"
    assert usage.error_message == "invalid access key"


class FakeClientWebSocket:
    def __init__(
        self,
        messages: list[dict[str, object]],
        *,
        wait_when_empty: bool = False,
    ) -> None:
        self._messages = list(messages)
        self._wait_when_empty = wait_when_empty
        self.sent_json: list[dict[str, object]] = []

    async def receive(self) -> dict[str, object]:
        if self._messages:
            return self._messages.pop(0)
        if self._wait_when_empty:
            await asyncio.Event().wait()
        raise RuntimeError("unexpected receive")

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent_json.append(payload)


class FakeUpstream:
    def __init__(
        self,
        sent_messages: list[bytes],
        *,
        responses: list[bytes] | None = None,
    ) -> None:
        self.sent_messages = sent_messages
        self._responses = list(responses or [])

    async def send(self, message: bytes) -> None:
        self.sent_messages.append(message)

    def __aiter__(self) -> FakeUpstream:
        return self

    async def __anext__(self) -> bytes:
        await asyncio.sleep(0)
        if self._responses:
            return self._responses.pop(0)
        raise StopAsyncIteration

    async def close(self) -> None:
        return None


def _message_sequence(message: bytes) -> int:
    return int.from_bytes(message[4:8], "big", signed=True)
