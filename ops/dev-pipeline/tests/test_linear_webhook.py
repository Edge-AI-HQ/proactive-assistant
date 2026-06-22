import json
import time

import pytest
from fastapi.testclient import TestClient

import dev_pipeline.app as app_mod
from dev_pipeline.app import create_app
from dev_pipeline.config import Settings
from dev_pipeline.linear.models import TriggerKind, WebhookEnvelope, parse_trigger
from dev_pipeline.linear.webhook import sign, timestamp_fresh, verify_signature
from tests import fixtures

SECRET = "lin_wh_testsecret"


def test_verify_signature_roundtrip() -> None:
    body = b'{"hello":"world"}'
    good = sign(body, SECRET)
    assert verify_signature(body, good, SECRET) is True
    assert verify_signature(body, "deadbeef", SECRET) is False
    assert verify_signature(body, good, "wrong-secret") is False
    assert verify_signature(body, None, SECRET) is False
    assert verify_signature(body, good, "") is False


def test_timestamp_fresh() -> None:
    now = 1_000_000_000_000
    assert timestamp_fresh(now, now) is True
    assert timestamp_fresh(now - 30_000, now) is True
    assert timestamp_fresh(now - 120_000, now) is False
    assert timestamp_fresh(None, now) is True  # 缺失视为通过


def test_parse_agent_session_created() -> None:
    t = parse_trigger(WebhookEnvelope.model_validate(fixtures.AGENT_SESSION_CREATED))
    assert t.kind is TriggerKind.AGENT_SESSION_CREATED
    assert t.issue_identifier == "EDG-42"
    assert t.agent_session_id == "agses_abc"


def test_parse_agent_session_prompted_carries_followup() -> None:
    t = parse_trigger(WebhookEnvelope.model_validate(fixtures.AGENT_SESSION_PROMPTED))
    assert t.kind is TriggerKind.AGENT_SESSION_PROMPTED
    assert t.prompt == "按钮放右上角"  # 反复改的 follow-up 抽出来了


def test_parse_issue_and_comment() -> None:
    issue = parse_trigger(WebhookEnvelope.model_validate(fixtures.ISSUE_CREATED))
    assert issue.kind is TriggerKind.ISSUE
    assert issue.issue_identifier == "EDG-99"

    comment = parse_trigger(WebhookEnvelope.model_validate(fixtures.COMMENT_CREATED))
    assert comment.kind is TriggerKind.COMMENT
    assert comment.issue_id == "issue_42"
    assert comment.prompt == "CI 挂了，帮我修一下"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    settings = Settings(linear_webhook_secret=SECRET)
    monkeypatch.setattr(app_mod, "get_settings", lambda: settings)
    return TestClient(create_app())


def test_webhook_route_accepts_valid_signature(client: TestClient) -> None:
    payload = dict(fixtures.AGENT_SESSION_CREATED)
    payload["webhookTimestamp"] = int(time.time() * 1000)
    raw = json.dumps(payload).encode()
    resp = client.post(
        "/webhook/linear",
        content=raw,
        headers={"Linear-Signature": sign(raw, SECRET)},
    )
    assert resp.status_code == 200
    assert resp.text == TriggerKind.AGENT_SESSION_CREATED.value


def test_webhook_route_rejects_bad_signature(client: TestClient) -> None:
    raw = json.dumps(fixtures.AGENT_SESSION_CREATED).encode()
    resp = client.post(
        "/webhook/linear",
        content=raw,
        headers={"Linear-Signature": "bad"},
    )
    assert resp.status_code == 401
