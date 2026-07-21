from __future__ import annotations

import base64
import hashlib
import hmac
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pinai_api.domains.voice import tencent_realtime_asr
from pinai_api.domains.voice.tencent_realtime_asr import _make_signed_url
from pinai_api.platform.auth.deps import current_user
from pinai_api.platform.auth.user_service import User


def test_signed_url_shape_and_signature() -> None:
    result = _make_signed_url(
        secret_id="AKID_TEST",
        secret_key="SECRET_TEST",
        app_id="1234567890",
        voice_id="v" * 32,
        ttl_s=60,
    )

    parsed = urlparse(result.url)
    assert parsed.scheme == "wss"
    assert parsed.netloc == "asr.cloud.tencent.com"
    assert parsed.path == "/asr/v2/1234567890"

    params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
    # Every required RTASR v2 query param must be present.
    for required in (
        "secretid",
        "timestamp",
        "expired",
        "nonce",
        "engine_model_type",
        "voice_id",
        "voice_format",
        "signature",
    ):
        assert required in params, f"missing {required}"

    assert params["secretid"] == "AKID_TEST"
    assert params["engine_model_type"] == "16k_zh_en_speaker_2.0"
    assert params["voice_format"] == "8"
    assert params["speaker_diarization"] == "1"
    assert params["enable_speaker_context"] == "1"
    assert params["sentence_strategy"] == "0"
    assert "speaker_context_id" not in params
    assert params["voice_id"] == "v" * 32
    assert int(params["expired"]) - int(params["timestamp"]) == 60

    # Signature = HMAC-SHA1(secret_key, "<host><path>?<sorted-params-without-sig>")
    # → base64. Recompute end-to-end to catch any silent formatting drift.
    without_sig = {k: v for k, v in params.items() if k != "signature"}
    sorted_pairs = "&".join(f"{k}={v}" for k, v in sorted(without_sig.items()))
    # `params` values were already url-decoded by parse_qs, so re-encode for the
    # signing string. Because our values only contain ascii-safe chars in tests
    # (no & or =), a simple pass through is fine here.
    expected = base64.b64encode(
        hmac.new(
            b"SECRET_TEST",
            f"asr.cloud.tencent.com/asr/v2/1234567890?{sorted_pairs}".encode(),
            hashlib.sha1,
        ).digest()
    ).decode("ascii")
    assert unquote(params["signature"]) == expected


def test_expires_at_uses_ttl() -> None:
    result = _make_signed_url(
        secret_id="AKID_TEST",
        secret_key="SECRET_TEST",
        app_id="1234567890",
        voice_id="voice",
        ttl_s=120,
    )
    parsed = urlparse(result.url)
    params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
    assert result.expires_at == int(params["expired"])
    assert int(params["expired"]) - int(params["timestamp"]) == 120


def test_signed_url_reuses_explicit_speaker_context() -> None:
    result = _make_signed_url(
        secret_id="AKID_TEST",
        secret_key="SECRET_TEST",
        app_id="1234567890",
        voice_id="new-voice",
        ttl_s=60,
        speaker_context_id="previous-speaker-context",
    )

    parsed = urlparse(result.url)
    params = {key: values[0] for key, values in parse_qs(parsed.query).items()}
    assert params["voice_id"] == "new-voice"
    assert params["speaker_context_id"] == "previous-speaker-context"


@pytest.fixture
def token_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    settings = SimpleNamespace(
        tencent_asr_secret_id="AKID_TEST",
        tencent_asr_secret_key="SECRET_TEST",
        tencent_asr_app_id="1234567890",
        tencent_asr_token_ttl_s=60,
    )
    monkeypatch.setattr(tencent_realtime_asr, "get_web_settings", lambda: settings)
    app = FastAPI()
    app.include_router(tencent_realtime_asr.router)
    app.dependency_overrides[current_user] = lambda: User(
        id=1,
        supabase_user_id="00000000-0000-0000-0000-000000000001",
        email="test@example.com",
        litellm_virtual_key=None,
        browserbase_context_id=None,
    )
    return TestClient(app)


def test_token_route_accepts_empty_body(token_client: TestClient) -> None:
    response = token_client.post("/api/voice/hardware/tencent-token")

    assert response.status_code == 200
    payload = response.json()
    assert payload["engine_model_type"] == "16k_zh_en_speaker_2.0"
    assert payload["speaker_diarization"] is True


def test_token_route_forwards_speaker_context(token_client: TestClient) -> None:
    response = token_client.post(
        "/api/voice/hardware/tencent-token",
        json={"speaker_context_id": "previous-speaker-context"},
    )

    assert response.status_code == 200
    params = parse_qs(urlparse(response.json()["url"]).query)
    assert params["speaker_context_id"] == ["previous-speaker-context"]


def test_token_route_rejects_oversized_speaker_context(token_client: TestClient) -> None:
    response = token_client.post(
        "/api/voice/hardware/tencent-token",
        json={"speaker_context_id": "x" * 129},
    )

    assert response.status_code == 422


def test_token_route_reports_missing_provider_config(
    token_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        tencent_realtime_asr,
        "get_web_settings",
        lambda: SimpleNamespace(
            tencent_asr_secret_id=None,
            tencent_asr_secret_key=None,
            tencent_asr_app_id=None,
            tencent_asr_token_ttl_s=60,
        ),
    )

    response = token_client.post("/api/voice/hardware/tencent-token")

    assert response.status_code == 503
    assert response.json() == {"detail": "pin_hardware_asr_not_configured"}
