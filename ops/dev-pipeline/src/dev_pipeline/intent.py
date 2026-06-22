"""AI 意图路由：用快模型理解用户在 Linear 里 @ 这句话到底想干嘛，不靠关键词硬撞。

dev-pipeline agent 是 Linear 里一个"有大脑的运维同事"——该理解自然语言、带上下文消歧、
不清楚就反问，而不是规则匹配。这个模块就是它的"听懂人话"那一层。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from anthropic import Anthropic

# agent 能干的事 = 路由的目标意图
INTENTS = (
    "new_request",  # 提一个新需求/改动 → 读代码出方案
    "refine_plan",  # 对待确认的方案提反馈/要调整
    "confirm",      # 同意方案 → 交给 Codex 实现
    "deploy",       # 起 preview 环境看效果
    "teardown",     # 拆掉 preview 环境
    "forward",      # 已委派后，补一条对实现/PR 的修改要求 → 转 Codex
    "clarify",      # 意思不清 → 反问
    "chitchat",     # 打招呼/问能干嘛之类元对话
)


@dataclass(frozen=True)
class IntentContext:
    """路由时喂给模型的当前状态，用于消歧。"""

    awaiting_plan: bool   # 有一版方案在等用户确认
    delegated: bool       # 已经把活委派给 Codex（之后大概率有 PR）
    issue_title: str = ""  # 这条 issue 的标题（判 new_request 的关键——需求在 issue 里）
    issue_desc: str = ""   # issue 描述（截断喂入）


@dataclass(frozen=True)
class IntentResult:
    intent: str
    reply: str = ""  # clarify 的反问句 / chitchat 的简短回应；其它意图留空


_SYSTEM = """\
你是一个内部研发流水线 agent 的"意图路由器"。这个 agent 在 Linear 里像个有大脑的运维同事，
用户 @ 它来推进一个需求。读用户这句话 + 当前上下文，判断 ta 想干嘛，**只选一个意图**。

意图：
- new_request：提出一个新的需求/改动，要 agent 去读代码出方案
- refine_plan：对"当前待确认的方案"提反馈/要调整（只在 awaiting_plan=true 时合理）
- confirm：同意当前方案、让 agent 交给 Codex 实现（只在 awaiting_plan=true 时合理）
- deploy：起一个 preview 环境看效果 / 部署 / 上线瞅一眼
- teardown：拆掉、关掉、销毁 preview 环境
- forward：在已委派 Codex（delegated=true）之后，补一条对实现/PR 的修改要求，转给 Codex
- clarify：意思不清楚、模棱两可 → 需要反问用户
- chitchat：打招呼、问 agent 能干嘛之类的元对话

规则：
- **issue 本身就是需求**：用户在一条 issue 下 @ 你，需求写在 issue 标题/描述里。所以像
  「plan it」「handle it」「做一下」「安排」这种泛泛指令，只要 issue 标题/描述有实质内容，
  就是 **new_request**（去读代码出方案）——**别反问**。issue 标题/描述为空才考虑 clarify。
- **拿不准才选 clarify**，在 reply 里给一句简短具体的反问，别瞎猜。
- 充分用上下文消歧：例如「ok/可以/行」在 awaiting_plan=true 时通常是 confirm；没有待确认
  方案时它可能是别的意图甚至 chitchat。
- 不要靠字面关键词：「看看效果」「上线瞅一眼」「起个环境」即使没出现"部署"二字也是 deploy；
  「这版不行，换个做法」是 refine_plan。
- chitchat 时在 reply 里给一句友好简短的回应。
- 其它意图把 reply 留空。"""

_ROUTE_TOOL: dict[str, Any] = {
    "name": "route",
    "description": "把用户这句话路由到一个意图。",
    "input_schema": {
        "type": "object",
        "properties": {
            "intent": {"type": "string", "enum": list(INTENTS)},
            "reply": {
                "type": "string",
                "description": "clarify 的反问句 / chitchat 的简短回应；其它意图留空字符串。",
            },
        },
        "required": ["intent"],
    },
}


class IntentRouter:
    def __init__(self, client: Anthropic, model: str = "claude-haiku-4-5") -> None:
        self._client = client
        self._model = model

    def route(self, message: str, ctx: IntentContext) -> IntentResult:
        issue = (ctx.issue_title or "（无标题）") + (
            f"\n描述：{ctx.issue_desc.strip()[:500]}" if ctx.issue_desc.strip() else ""
        )
        user = (
            f"当前 issue：{issue}\n\n"
            f"状态：awaiting_plan={str(ctx.awaiting_plan).lower()}, "
            f"delegated={str(ctx.delegated).lower()}\n\n"
            f"用户这句话：{message.strip() or '（空）'}"
        )
        # dict 字面量 vs SDK 的 ToolParam/ToolChoice TypedDict —— 唯一选项是 type:ignore
        resp = self._client.messages.create(  # type: ignore[call-overload]
            model=self._model,
            max_tokens=300,
            system=_SYSTEM,
            tools=[_ROUTE_TOOL],
            tool_choice={"type": "tool", "name": "route"},
            messages=[{"role": "user", "content": user}],
        )
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use" and block.name == "route":
                data = block.input if isinstance(block.input, dict) else {}
                intent = str(data.get("intent", "clarify"))
                if intent not in INTENTS:
                    intent = "clarify"
                return IntentResult(intent=intent, reply=str(data.get("reply", "")))
        return IntentResult(intent="clarify", reply="没太理解你的意思，能再说具体点吗？")
