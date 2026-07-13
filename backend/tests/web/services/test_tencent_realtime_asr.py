from __future__ import annotations

import base64
import hashlib
import hmac
from urllib.parse import parse_qs, unquote, urlparse

from pinai_api.domains.voice.tencent_realtime_asr import _make_signed_url


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
    assert params["engine_model_type"] == "16k_zh"
    assert params["voice_format"] == "1"
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
