"""_parse_payload：Linear 把 scope 错误用 HTTP 400 + errors body 返回，必须先看 body。"""

from __future__ import annotations

import pytest

from dev_pipeline.linear.client import LinearError, _parse_payload


def test_ok() -> None:
    assert _parse_payload({"data": {"x": 1}}, 200) == {"x": 1}


def test_forbidden_scope_on_400_raises_with_message() -> None:
    payload = {
        "errors": [
            {"message": "Invalid scope: `oauth:create` required",
             "extensions": {"code": "FORBIDDEN"}}
        ]
    }
    with pytest.raises(LinearError) as ei:
        _parse_payload(payload, 400)
    # 错误信息保留下来，wire_linear 才能据此降级到手动粘
    assert "oauth:create" in str(ei.value)


def test_non_json_raises() -> None:
    with pytest.raises(LinearError):
        _parse_payload(None, 500)


def test_empty_data_raises() -> None:
    with pytest.raises(LinearError):
        _parse_payload({}, 200)
