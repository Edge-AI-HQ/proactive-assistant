from __future__ import annotations

from types import SimpleNamespace

import pytest

from pinai_agents.web.services import voice_transcription as service

pytestmark = pytest.mark.asyncio


async def test_plain_transcription_posts_mixed_language_prompt_without_default_language(
    monkeypatch,
):
    captured: dict[str, object] = {}

    class FakeResponse:
        is_success = True
        status_code = 200
        text = ""

        def json(self):
            return {"text": "今天 review Claude Code 里的 Codex patch."}

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

    result = await service.transcribe_audio(
        audio=b"ambient-wav",
        content_type="audio/wav",
        filename="ambient.wav",
        bearer_token="sk-test",
    )

    assert result == "今天 review Claude Code 里的 Codex patch."
    assert captured["url"] == "http://litellm:4000/v1/audio/transcriptions"
    assert captured["headers"] == {
        "Authorization": "Bearer sk-test",
        "Accept": "application/json",
    }
    data = captured["data"]
    assert isinstance(data, dict)
    assert data["model"] == "gpt-4o-transcribe"
    assert data["response_format"] == "json"
    assert "language" not in data
    assert "prompt" in data
    assert "mixed Mandarin Chinese and English" in data["prompt"]
    assert "Claude Code" in data["prompt"]
    assert "Codex" in data["prompt"]
    assert "Do not translate between languages" in data["prompt"]
    assert captured["files"] == {
        "file": ("ambient.wav", b"ambient-wav", "audio/wav"),
    }


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
    assert "prompt" not in captured["data"]
    assert captured["files"] == {
        "file": ("meeting.wav", b"meeting-wav", "audio/wav"),
    }
    assert [segment.speaker for segment in result.segments] == ["self", "speaker_1"]
    assert result.segments[0].start_ms == 0
    assert result.segments[0].end_ms == 1250


async def test_postprocess_diarized_transcription_corrects_segments_and_preserves_structure(
    monkeypatch,
):
    captured_posts: list[dict[str, object]] = []
    responses = [
        "今天 review Claude Code 和 Codex.",
        "Gemini 走 Harness agent.",
    ]

    class FakeResponse:
        is_success = True
        status_code = 200
        text = ""

        def __init__(self, content: str):
            self._content = content

        def json(self):
            return {"choices": [{"message": {"content": self._content}}]}

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            captured_posts.append({"timeout": timeout})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, *, json, headers):
            captured_posts.append({"url": url, "json": json, "headers": headers})
            return FakeResponse(responses.pop(0))

    monkeypatch.setattr(
        service,
        "get_web_settings",
        lambda: SimpleNamespace(litellm_base_url="http://litellm:4000"),
    )
    monkeypatch.setattr(service.httpx, "AsyncClient", FakeAsyncClient)

    result = await service.postprocess_diarized_transcription(
        result=service.DiarizedTranscriptionResult(
            text="今天 review claude code 和 codex.\ngemini 走 harness workflow.",
            segments=[
                service.SpeakerSegment(
                    speaker="self",
                    text="今天 review claude code 和 codex.",
                    start_ms=0,
                    end_ms=1200,
                ),
                service.SpeakerSegment(
                    speaker="speaker_1",
                    text="gemini 走 harness workflow.",
                    start_ms=1300,
                    end_ms=2400,
                ),
            ],
        ),
        bearer_token="sk-test",
    )

    posts = [item for item in captured_posts if "json" in item]
    assert len(posts) == 2
    first_body = posts[0]["json"]
    assert isinstance(first_body, dict)
    assert first_body["model"] == "gpt-5-nano"
    assert "temperature" not in first_body
    assert "top_p" not in first_body
    assert first_body["reasoning_effort"] == "minimal"
    assert first_body["max_completion_tokens"] >= 64
    messages = first_body["messages"]
    assert isinstance(messages, list)
    system_message = messages[0]
    user_message = messages[1]
    assert system_message["role"] == "system"
    assert "Claude Code" in system_message["content"]
    assert "Codex" in system_message["content"]
    assert "Gemini" in system_message["content"]
    assert "Genspark" in system_message["content"]
    assert "Harness" in system_message["content"]
    assert "CloudCode" in system_message["content"]
    assert "Lite, LLM" in system_message["content"]
    assert "Compusel" in system_message["content"]
    assert "Use Simplified Chinese" in system_message["content"]
    assert user_message == {
        "role": "user",
        "content": (
            "Full transcript context:\n"
            "今天 review claude code 和 codex.\ngemini 走 harness workflow.\n\n"
            "Segment text to correct:\n"
            "今天 review claude code 和 codex."
        ),
    }
    assert result.text == "今天 review Claude Code 和 Codex.\nGemini 走 Harness agent."
    assert [(segment.speaker, segment.start_ms, segment.end_ms) for segment in result.segments] == [
        ("self", 0, 1200),
        ("speaker_1", 1300, 2400),
    ]
    assert [segment.text for segment in result.segments] == [
        "今天 review Claude Code 和 Codex.",
        "Gemini 走 Harness agent.",
    ]


async def test_postprocess_diarized_transcription_skips_model_for_known_hotword_near_misses(
    monkeypatch,
):
    called = False

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            nonlocal called
            called = True
            raise AssertionError("model should not be called for deterministic hotword corrections")

    monkeypatch.setattr(
        service,
        "get_web_settings",
        lambda: SimpleNamespace(litellm_base_url="http://litellm:4000"),
    )
    monkeypatch.setattr(service.httpx, "AsyncClient", FakeAsyncClient)

    raw = (
        "今天测试 Cloudcode 和 Codex 然后比较 Gemini 和 GenSpark 的 Harness Agent "
        "最后检查 Superbase Lite L_L_M_Compocil 和 Lance Smith"
    )
    result = await service.postprocess_diarized_transcription(
        result=service.DiarizedTranscriptionResult(
            text=raw,
            segments=[
                service.SpeakerSegment(
                    speaker="self",
                    text=raw,
                    start_ms=0,
                    end_ms=12950,
                )
            ],
        ),
        bearer_token="sk-test",
    )

    assert called is False
    assert result.text == (
        "今天测试 Claude Code 和 Codex 然后比较 Gemini 和 Genspark 的 Harness agent "
        "最后检查 Supabase LiteLLM Composio 和 LangSmith"
    )
    assert result.segments[0].speaker == "self"
    assert result.segments[0].start_ms == 0
    assert result.segments[0].end_ms == 12950


async def test_postprocess_diarized_transcription_simplifies_chinese_and_cloud_code(
    monkeypatch,
):
    called = False

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            nonlocal called
            called = True
            raise AssertionError("model should not be called for deterministic corrections")

    monkeypatch.setattr(
        service,
        "get_web_settings",
        lambda: SimpleNamespace(litellm_base_url="http://litellm:4000"),
    )
    monkeypatch.setattr(service.httpx, "AsyncClient", FakeAsyncClient)

    raw = (
        "我還想知道 Claude Code 和 Codex 在 Last Mist 的用法怎麼樣, How’s it going? "
        "是吧？ 特別是 Cloud Code 其實用起來非常好，對於 PIN AI 來說我非常需要 Cloud Code"
    )
    result = await service.postprocess_diarized_transcription(
        result=service.DiarizedTranscriptionResult(
            text=raw,
            segments=[
                service.SpeakerSegment(
                    speaker="self",
                    text=raw,
                    start_ms=3956,
                    end_ms=28506,
                )
            ],
        ),
        bearer_token="sk-test",
    )

    assert called is False
    assert result.text == (
        "我还想知道 Claude Code 和 Codex 在 Last Mist 的用法怎么样, How’s it going? "
        "是吧？ 特别是 Claude Code 其实用起来非常好，对于 PIN AI 来说我非常需要 Claude Code"
    )
    assert result.segments[0].text == result.text


async def test_postprocess_diarized_transcription_keeps_deterministic_edits_when_model_fails(
    monkeypatch,
):
    class FakeAsyncClient:
        def __init__(self, *, timeout):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            raise service.LiteLLMError(503, "simulated postprocess failure")

    monkeypatch.setattr(
        service,
        "get_web_settings",
        lambda: SimpleNamespace(litellm_base_url="http://litellm:4000"),
    )
    monkeypatch.setattr(service.httpx, "AsyncClient", FakeAsyncClient)

    result = await service.postprocess_diarized_transcription(
        result=service.DiarizedTranscriptionResult(
            text="特別是 Cloud Code 其實用起來非常好\n普通第二段",
            segments=[
                service.SpeakerSegment(
                    speaker="self",
                    text="特別是 Cloud Code 其實用起來非常好",
                    start_ms=0,
                    end_ms=1200,
                ),
                service.SpeakerSegment(
                    speaker="self",
                    text="普通第二段",
                    start_ms=1300,
                    end_ms=2400,
                ),
            ],
        ),
        bearer_token="sk-test",
    )

    assert result.text == "特别是 Claude Code 其实用起来非常好\n普通第二段"
    assert [segment.text for segment in result.segments] == [
        "特别是 Claude Code 其实用起来非常好",
        "普通第二段",
    ]
