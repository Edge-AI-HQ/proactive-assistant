from __future__ import annotations

from types import SimpleNamespace

import pytest

from pinai_agents.web.services import voice_transcription as service

pytestmark = pytest.mark.asyncio


async def test_diarized_transcription_posts_openai_diarization_fields(monkeypatch):
    captured: dict[str, object] = {}

    class FakeResponse:
        is_success = True
        status_code = 200
        text = ""

        def json(self):
            return {
                "text": "hello",
                "segments": [
                    {"speaker": "self", "text": "hello", "start": 0, "end": 1.25},
                    {"speaker": "speaker_1", "text": "reply", "start": 1.4, "end": 2},
                ],
            }

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, *, data, files, headers):
            captured.update(
                {
                    "url": url,
                    "data": data,
                    "files": files,
                    "headers": headers,
                }
            )
            return FakeResponse()

    monkeypatch.setattr(
        service,
        "get_web_settings",
        lambda: SimpleNamespace(litellm_base_url="http://litellm:4000"),
    )
    monkeypatch.setattr(service.httpx, "AsyncClient", FakeAsyncClient)

    result = await service.transcribe_audio_diarized(
        audio=b"meeting-wav",
        content_type="audio/wav",
        filename="meeting.wav",
        bearer_token="sk-test",
        known_speaker_reference=b"reference-wav",
        known_speaker_reference_mime="audio/wav",
        language="en",
    )

    assert captured["url"] == "http://litellm:4000/v1/audio/transcriptions"
    assert captured["headers"] == {
        "Authorization": "Bearer sk-test",
        "Accept": "application/json",
    }
    assert captured["data"] == {
        "model": "gpt-4o-transcribe-diarize",
        "response_format": "diarized_json",
        "chunking_strategy": "auto",
        "known_speaker_names[]": "self",
        "known_speaker_references[]": "data:audio/wav;base64,cmVmZXJlbmNlLXdhdg==",
        "language": "en",
    }
    assert captured["files"] == {
        "file": ("meeting.wav", b"meeting-wav", "audio/wav"),
    }
    assert [segment.speaker for segment in result.segments] == ["self", "speaker_1"]
    assert result.segments[0].start_ms == 0
    assert result.segments[0].end_ms == 1250
