"""Planner —— agent 的"脑子"。这是方案 1 区别于"直接 @codex"的核心价值。

收到需求后不直接转发，而是：用 Claude + grep/read 工具**真去读相关代码**（"重"版，
对应"先读后写"），产出一个具体 plan（to-do / 改哪些文件 / 风险），贴回去等用户确认。

实现：Anthropic Messages API 手动 agentic loop（claude-api skill 核对过）。
- 工具：grep（搜代码）、read_file（读文件）、submit_plan（结构化交付，strict schema）。
- 模型默认 claude-opus-4-8 + adaptive thinking + effort high。
- 单一可注入 seam：`client`（Anthropic）+ `repo_root`（grep/read 根），测试 mock client。
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from anthropic import Anthropic

_SYSTEM = """你是 PIN AI 代码库的规划 agent。收到一个产品需求后，先用 grep / read_file
真去读相关代码，理解现有实现，再产出一个具体、能落地的 plan。

要求：
- 先探代码（grep 关键词、read 命中的文件）再下结论，不基于猜测。
- plan 要具体：列出要改哪些文件、每步做什么、有什么风险。
- 探完后调用 submit_plan 提交结构化 plan。不要在 submit_plan 之外写长篇大论。
- 保持改动最小化，复用现有 pattern，不发明新写法。"""

GREP_TOOL: dict[str, Any] = {
    "name": "grep",
    "description": "在代码库里按正则搜索，返回命中的文件:行。先用它定位相关代码。",
    "input_schema": {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "正则 / 关键词"},
            "path": {"type": "string", "description": "可选：限定子目录"},
        },
        "required": ["pattern"],
    },
}

READ_TOOL: dict[str, Any] = {
    "name": "read_file",
    "description": "读一个文件的内容（相对 repo 根的路径）。用它看 grep 命中的实现。",
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "max_lines": {"type": "integer", "description": "最多读多少行，默认 200"},
        },
        "required": ["path"],
    },
}

SUBMIT_PLAN_TOOL: dict[str, Any] = {
    "name": "submit_plan",
    "description": "提交最终 plan。探完代码后调用一次。",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "一句话方案概述"},
            "todos": {"type": "array", "items": {"type": "string"}, "description": "to-do 步骤"},
            "files": {"type": "array", "items": {"type": "string"}, "description": "要改的文件"},
            "risks": {"type": "array", "items": {"type": "string"}, "description": "风险 / 注意点"},
        },
        "required": ["summary", "todos", "files"],
    },
}


@dataclass
class Plan:
    summary: str
    todos: list[str]
    files: list[str]
    risks: list[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        lines = [f"**方案**：{self.summary}", "", "**To-do**："]
        lines += [f"- [ ] {t}" for t in self.todos]
        if self.files:
            lines += ["", "**会改的文件**："] + [f"- `{f}`" for f in self.files]
        if self.risks:
            lines += ["", "**风险 / 注意**："] + [f"- {r}" for r in self.risks]
        return "\n".join(lines)


class PlannerError(RuntimeError):
    pass


class Planner:
    def __init__(
        self,
        repo_root: str,
        *,
        client: Anthropic | None = None,
        model: str = "claude-opus-4-8",
        max_iterations: int = 20,
    ) -> None:
        self._root = Path(repo_root).resolve()
        self._client = client or Anthropic()
        self._model = model
        self._max_iterations = max_iterations

    def make_plan(self, title: str, description: str) -> Plan:
        prompt = (
            f"产品需求：\n标题：{title}\n描述：{description}\n\n"
            "先探相关代码，再 submit_plan。"
        )
        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]

        for _ in range(self._max_iterations):
            # dict 字面量是 Anthropic SDK 文档用法；mypy strict 无法把它收窄成 SDK 的
            # TypedDict overload（thinking/output_config/messages），故此处忽略 call-overload。
            resp = self._client.messages.create(  # type: ignore[call-overload]
                model=self._model,
                max_tokens=16000,
                thinking={"type": "adaptive"},
                output_config={"effort": "high"},
                system=_SYSTEM,
                tools=[GREP_TOOL, READ_TOOL, SUBMIT_PLAN_TOOL],
                messages=messages,
            )
            tool_uses = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]
            if not tool_uses:
                raise PlannerError("planner 没调工具也没 submit_plan")

            messages.append({"role": "assistant", "content": resp.content})
            results: list[dict[str, Any]] = []
            for tu in tool_uses:
                if tu.name == "submit_plan":
                    return _plan_from_input(tu.input)
                output = self._run_tool(tu.name, tu.input)
                results.append(
                    {"type": "tool_result", "tool_use_id": tu.id, "content": output}
                )
            messages.append({"role": "user", "content": results})

        raise PlannerError(f"planner 超过 {self._max_iterations} 轮还没出 plan")

    def _run_tool(self, name: str, args: dict[str, Any]) -> str:
        if name == "grep":
            return self._grep(args["pattern"], args.get("path"))
        if name == "read_file":
            return self._read(args["path"], int(args.get("max_lines", 200)))
        return f"unknown tool: {name}"

    _GREP_EXCLUDE = (
        "node_modules", ".git", ".venv", "dist", "build", ".next", "__pycache__",
        ".claude", "ios", "android", "Pods",
    )

    def _grep(self, pattern: str, sub: str | None) -> str:
        target = self._safe_path(sub) if sub else self._root
        cmd = ["grep", "-rniI", "-l"]
        cmd += [f"--exclude-dir={d}" for d in self._GREP_EXCLUDE]
        cmd += [pattern, str(target)]
        try:
            out = subprocess.run(  # noqa: S603
                cmd, capture_output=True, text=True, timeout=20
            ).stdout
        except (subprocess.SubprocessError, OSError) as e:
            return f"grep error: {e}"
        files = [str(Path(f).relative_to(self._root)) for f in out.splitlines()[:40] if f]
        return "命中文件:\n" + "\n".join(files) if files else "无命中"

    def _read(self, rel: str, max_lines: int) -> str:
        path = self._safe_path(rel)
        if not path.is_file():
            return f"文件不存在: {rel}"
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[:max_lines]
        return f"# {rel} (前 {len(lines)} 行)\n" + "\n".join(lines)

    def _safe_path(self, rel: str) -> Path:
        # 防目录穿越：解析后必须仍在 repo 根内
        p = (self._root / rel).resolve()
        if not str(p).startswith(str(self._root)):
            raise PlannerError(f"path escapes repo root: {rel}")
        return p


def _plan_from_input(data: dict[str, Any]) -> Plan:
    return Plan(
        summary=str(data.get("summary", "")),
        todos=[str(t) for t in data.get("todos", [])],
        files=[str(f) for f in data.get("files", [])],
        risks=[str(r) for r in data.get("risks", [])],
    )
