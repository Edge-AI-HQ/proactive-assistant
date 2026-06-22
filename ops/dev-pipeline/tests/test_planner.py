"""Planner：mock Anthropic client，验证 agentic loop（grep → submit_plan）+ Plan 解析。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from dev_pipeline.planner import Plan, Planner, PlannerError


def _tool_use(name: str, tid: str, inp: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(type="tool_use", name=name, id=tid, input=inp)


def _resp(*blocks: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(content=list(blocks), stop_reason="tool_use")


class FakeMessages:
    def __init__(self, responses: list[SimpleNamespace]) -> None:
        self._responses = responses
        self.calls = 0

    def create(self, **kwargs: Any) -> SimpleNamespace:
        r = self._responses[self.calls]
        self.calls += 1
        return r


class FakeAnthropic:
    def __init__(self, responses: list[SimpleNamespace]) -> None:
        self.messages = FakeMessages(responses)


def test_plan_to_markdown() -> None:
    md = Plan(summary="s", todos=["a", "b"], files=["f.ts"], risks=["r"]).to_markdown()
    assert "**方案**：s" in md and "- [ ] a" in md and "`f.ts`" in md and "- r" in md


def test_planner_submits_plan_directly(tmp_path: Path) -> None:
    client = FakeAnthropic([
        _resp(_tool_use("submit_plan", "t1", {
            "summary": "改 title 为 line-clamp-2", "todos": ["改 CSS"], "files": ["Card.tsx"],
            "risks": ["注意行高"],
        })),
    ])
    planner = Planner(str(tmp_path), client=client)  # type: ignore[arg-type]
    plan = planner.make_plan("Tasks title 2 行", "支持 2 行")
    assert plan.summary == "改 title 为 line-clamp-2"
    assert plan.files == ["Card.tsx"] and plan.risks == ["注意行高"]


def test_planner_runs_grep_then_submits(tmp_path: Path) -> None:
    (tmp_path / "Card.tsx").write_text("export const Card = () => <div className='truncate'/>")
    client = FakeAnthropic([
        _resp(_tool_use("grep", "g1", {"pattern": "truncate"})),
        _resp(_tool_use("submit_plan", "t1", {
            "summary": "s", "todos": ["改"], "files": ["Card.tsx"],
        })),
    ])
    planner = Planner(str(tmp_path), client=client)  # type: ignore[arg-type]
    plan = planner.make_plan("t", "d")
    assert client.messages.calls == 2  # 先 grep 再 submit
    assert plan.summary == "s"


def test_planner_raises_when_no_plan(tmp_path: Path) -> None:
    client = FakeAnthropic([_resp()])  # 没工具调用
    planner = Planner(str(tmp_path), client=client)  # type: ignore[arg-type]
    with pytest.raises(PlannerError):
        planner.make_plan("t", "d")


def test_safe_path_blocks_traversal(tmp_path: Path) -> None:
    planner = Planner(str(tmp_path), client=FakeAnthropic([]))  # type: ignore[arg-type]
    with pytest.raises(PlannerError):
        planner._safe_path("../../etc/passwd")
