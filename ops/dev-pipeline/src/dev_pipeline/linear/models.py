"""Linear webhook 载荷模型 + 归一化触发器。

注意：AgentSession 相关 webhook 是 Linear Developer Preview，嵌套结构可能变。
这里按官方文档形态建模并防御性取值（多数字段 optional）；fixture 反映文档形态，
M4 真链路时对照 live payload 校正。
docs: https://linear.app/developers/agent-interaction
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class WebhookEnvelope(BaseModel):
    """Linear webhook 顶层信封（所有事件共用）。"""

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    action: str
    type: str
    # 普通数据 webhook(Issue/Comment) 的实体在 data 里；
    # AgentSessionEvent 的实体(agentSession) 在顶层，没有 data 包裹。
    data: dict[str, Any] = Field(default_factory=dict)
    agent_session: dict[str, Any] | None = Field(default=None, alias="agentSession")
    # prompted 事件：用户的新回复在顶层 agentActivity.content.body（不在 agentSession.comment）
    agent_activity: dict[str, Any] | None = Field(default=None, alias="agentActivity")
    url: str | None = None
    created_at: str | None = Field(default=None, alias="createdAt")
    webhook_timestamp: int | None = Field(default=None, alias="webhookTimestamp")
    webhook_id: str | None = Field(default=None, alias="webhookId")


class TriggerKind(StrEnum):
    AGENT_SESSION_CREATED = "agent_session_created"
    AGENT_SESSION_PROMPTED = "agent_session_prompted"
    ISSUE = "issue"
    COMMENT = "comment"
    UNKNOWN = "unknown"


class PipelineTrigger(BaseModel):
    """从 webhook 信封归一化出的、编排层真正消费的触发器。

    把 Linear 多种事件形态收敛成统一字段，下游状态机不必再认 Linear 的嵌套结构。
    """

    kind: TriggerKind
    issue_id: str | None = None
    issue_identifier: str | None = None  # e.g. EDG-123
    issue_title: str | None = None
    issue_description: str | None = None
    agent_session_id: str | None = None
    # 用户最新一句话（agent_session_prompted / comment），驱动"反复改"的 follow-up
    prompt: str | None = None
    actor: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


def _dig(data: dict[str, Any], *path: str) -> Any:
    cur: Any = data
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _strip_mentions(text: str) -> str:
    """去掉 @mention（如 @proactive-ai-dev），留下真正的指令。"""
    words = [w for w in text.split() if not w.startswith("@")]
    return " ".join(words).strip()


def parse_trigger(env: WebhookEnvelope) -> PipelineTrigger:
    """把 webhook 信封归一化成 PipelineTrigger。无法识别时返回 kind=UNKNOWN。"""
    data = env.data

    if env.type == "AgentSessionEvent":
        # agentSession 在顶层（不在 data 里）。实测 payload 见 svc 日志。
        sess = env.agent_session or {}
        issue = sess.get("issue") if isinstance(sess.get("issue"), dict) else {}
        issue = issue or {}
        instruction: str | None
        if env.action == "prompted":
            # 新回复在顶层 agentActivity.content.body（agentSession.comment 是原始评论）
            activity = env.agent_activity or {}
            instruction = _strip_mentions(
                _dig(activity, "content", "body") or _dig(activity, "body") or ""
            )
            kind = TriggerKind.AGENT_SESSION_PROMPTED
        else:
            # created：指令在开 session 的 @提及评论里；没有则回落到 issue 标题
            instruction = _strip_mentions(_dig(sess, "comment", "body") or "") or issue.get("title")
            kind = TriggerKind.AGENT_SESSION_CREATED
        return PipelineTrigger(
            kind=kind,
            issue_id=sess.get("issueId") or issue.get("id"),
            issue_identifier=issue.get("identifier"),
            issue_title=issue.get("title"),
            issue_description=issue.get("description"),
            agent_session_id=sess.get("id"),
            prompt=instruction,
            actor=_dig(sess, "creator", "name"),
            raw=sess,
        )

    if env.type == "Issue":
        return PipelineTrigger(
            kind=TriggerKind.ISSUE,
            issue_id=data.get("id"),
            issue_identifier=data.get("identifier"),
            prompt=data.get("title"),
            raw=data,
        )

    if env.type == "Comment":
        return PipelineTrigger(
            kind=TriggerKind.COMMENT,
            issue_id=_dig(data, "issue", "id") or data.get("issueId"),
            prompt=data.get("body"),
            actor=_dig(data, "user", "name"),
            raw=data,
        )

    return PipelineTrigger(kind=TriggerKind.UNKNOWN, raw=data)
