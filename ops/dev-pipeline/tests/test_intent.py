"""IntentRouter：解析模型的 tool 输出 → 意图（用假 Anthropic client，不打真 API）。"""

from __future__ import annotations

from typing import Any

from dev_pipeline.intent import IntentContext, IntentRouter


class _Block:
    type = "tool_use"
    name = "route"

    def __init__(self, inp: dict[str, Any]) -> None:
        self.input = inp


class _Resp:
    def __init__(self, inp: dict[str, Any]) -> None:
        self.content = [_Block(inp)]


class _FakeAnthropic:
    def __init__(self, inp: dict[str, Any]) -> None:
        self._inp = inp
        self.messages = self
        self.last_kwargs: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> _Resp:
        self.last_kwargs = kwargs
        return _Resp(self._inp)


def test_router_parses_intent() -> None:
    r = IntentRouter(_FakeAnthropic({"intent": "deploy", "reply": ""}))  # type: ignore[arg-type]
    res = r.route("上线瞅一眼", IntentContext(awaiting_plan=False, delegated=True))
    assert res.intent == "deploy"


def test_router_unknown_intent_falls_to_clarify() -> None:
    r = IntentRouter(_FakeAnthropic({"intent": "garbage"}))  # type: ignore[arg-type]
    assert r.route("???", IntentContext(awaiting_plan=False, delegated=False)).intent == "clarify"


def test_router_carries_clarify_reply() -> None:
    r = IntentRouter(  # type: ignore[arg-type]
        _FakeAnthropic({"intent": "clarify", "reply": "你是想起 preview 还是改方案？"})
    )
    res = r.route("那个", IntentContext(awaiting_plan=True, delegated=False))
    assert res.intent == "clarify" and "preview" in res.reply


def test_router_feeds_issue_context_into_prompt() -> None:
    # 回归：「plan it」要带上 issue 标题/描述喂给模型，否则会被误判成 clarify
    c = _FakeAnthropic({"intent": "new_request"})
    r = IntentRouter(c)  # type: ignore[arg-type]
    r.route("plan it", IntentContext(False, False, "支持3行标题", "AC: 最多3行"))
    sent = c.last_kwargs["messages"][0]["content"]
    assert "支持3行标题" in sent and "AC: 最多3行" in sent
