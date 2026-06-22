"""Linear webhook 验签。

Linear-Signature = hex(HMAC-SHA256(raw_body, webhook_secret))。
另校验 webhookTimestamp 在 ±60s（防重放）。
docs: https://linear.app/developers/webhooks
"""

from __future__ import annotations

import hashlib
import hmac

DEFAULT_TOLERANCE_S = 60


def verify_signature(raw_body: bytes, signature_header: str | None, secret: str) -> bool:
    """timing-safe 比较 HMAC-SHA256。secret 为空（未配置）时返回 False，不放行。"""
    if not secret or not signature_header:
        return False
    expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def timestamp_fresh(
    webhook_timestamp_ms: int | None,
    now_ms: int,
    tolerance_s: int = DEFAULT_TOLERANCE_S,
) -> bool:
    """webhookTimestamp 在容忍窗口内。缺失时视为通过（部分事件不带）。"""
    if webhook_timestamp_ms is None:
        return True
    return abs(now_ms - webhook_timestamp_ms) <= tolerance_s * 1000


def sign(raw_body: bytes, secret: str) -> str:
    """生成签名（测试 / 自检用）。"""
    return hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
