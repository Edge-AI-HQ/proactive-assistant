"""Linear webhook 样例载荷（按官方文档形态构造，M4 对照 live 校正）。"""

from __future__ import annotations

from typing import Any

# 真实形态(实测 2026-06-13)：agentSession 在顶层，不在 data 里。
AGENT_SESSION_CREATED: dict[str, Any] = {
    "action": "created",
    "type": "AgentSessionEvent",
    "createdAt": "2026-06-13T15:11:45.656Z",
    "webhookId": "wh_1",
    "webhookTimestamp": 1_000_000_000_000,
    "agentSession": {
        "id": "agses_abc",
        "issueId": "issue_42",
        "creator": {"name": "Smile Hu"},
        "comment": {"id": "cmt_x", "body": "@proactive-ai-dev  加一个刷新按钮"},
        "issue": {"id": "issue_42", "identifier": "EDG-42", "title": "加一个刷新按钮"},
    },
}

AGENT_SESSION_PROMPTED: dict[str, Any] = {
    "action": "prompted",
    "type": "AgentSessionEvent",
    "webhookId": "wh_2",
    "webhookTimestamp": 1_000_000_000_000,
    "agentSession": {
        "id": "agses_abc",
        "issueId": "issue_42",
        "creator": {"name": "Smile Hu"},
        # 这是开 session 的原始评论；prompted 的新回复在顶层 agentActivity
        "comment": {"id": "cmt_orig", "body": "@proactive-ai-dev fix it"},
        "issue": {"id": "issue_42", "identifier": "EDG-42"},
    },
    "agentActivity": {"content": {"type": "prompt", "body": "按钮放右上角"}},
}

ISSUE_CREATED: dict[str, Any] = {
    "action": "create",
    "type": "Issue",
    "webhookId": "wh_3",
    "webhookTimestamp": 1_000_000_000_000,
    "data": {"id": "issue_99", "identifier": "EDG-99", "title": "支持导出 CSV"},
}

COMMENT_CREATED: dict[str, Any] = {
    "action": "create",
    "type": "Comment",
    "webhookId": "wh_4",
    "webhookTimestamp": 1_000_000_000_000,
    "data": {
        "id": "cmt_1",
        "body": "CI 挂了，帮我修一下",
        "issue": {"id": "issue_42"},
        "user": {"name": "Smile Hu"},
    },
}
