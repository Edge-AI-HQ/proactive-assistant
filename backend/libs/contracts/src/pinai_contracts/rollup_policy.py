"""Per-source rollup strategy — the投影管线 stage that decides HOW a raw row
rolls into the L1 event stream (doc §4.2: off / window / semantic).

Single source of truth, shared across the trust boundary. Both sides read it,
neither imports the other, so the policy lives here in contracts:
  * projector (api) — drives off / window synchronously (no LLM, critical path).
  * rollup_semantic (agent-engine) — drives semantic asynchronously (LLM, bg);
    the projector SKIPs semantic sources, this collapses their firehose into
    episode events later.

doc 红线: strategy 就这三档, 别造可配置 rollup DSL.
"""

from __future__ import annotations

ROLLUP_OFF = "off"
ROLLUP_WINDOW = "window"
ROLLUP_SEMANTIC = "semantic"

# (source, entity) → 档. 缺省 off (离散数据, 1 raw → 1 event).
#   * semantic — firehose (ambient utterance / transcript): LLM 卷成 episode,
#     agent-engine 异步做; projector skip 这些, 不逐条上 L1.
#   * window — periodic-state (device health snapshot): 规则按天聚合, api projector.
#   * off (default) — 邮件 / 会议 / feedback 等离散事件, 直接 1→1.
# device apps / contacts 不在这里 (也不投 events): 它们是状态 / 参考数据 (装机列表 /
# 通讯录) 不是事件, projector 直接 skip, 留 L0 pai_raw_device 供 raw.list 查 (见
# event_projector._PROJECTION_SKIP_ENTITIES).
ROLLUP_POLICY: dict[tuple[str, str], str] = {
    # utterance (session_summary = 一次会话的成品转写, 离散终态) 走 off/1→1: projector
    # 实时投成 utterance event, 满足 ambient 实时录入 event 的需求 (2026-06-30). 真正的
    # firehose 是 transcript_window (几秒一个的中间证据窗口) — 它保留 semantic, 由
    # rollup_semantic 把一串窗口卷成 episode. 想恢复 utterance 的日聚合就加回
    # ("device", "utterance"): ROLLUP_SEMANTIC —— 但必须同步 rollup_semantic 的 prompt
    # (它硬编码读哪些 entity, 不读本表), 否则 projector + rollup 会对同一份 raw 双投.
    ("device", "transcript_window"): ROLLUP_SEMANTIC,
    ("device", "health"): ROLLUP_WINDOW,
}


def rollup_mode(source: str, entity: str) -> str:
    """The rollup stage a (source, entity) goes through. Unknown → off (1→1)."""
    return ROLLUP_POLICY.get((source, entity), ROLLUP_OFF)


def semantic_entities(source: str) -> list[str]:
    """Entities under `source` whose rollup is semantic — the projector skips
    these (agent-engine's rollup_semantic collapses their firehose into episode
    events). Order-stable for reproducible SQL params."""
    return [e for (s, e), m in ROLLUP_POLICY.items() if s == source and m == ROLLUP_SEMANTIC]


def window_entities(source: str) -> list[str]:
    """Entities under `source` whose rollup is window — the projector aggregates
    these by a fixed time window (api-side rollup.py) instead of 1→1. Order-stable
    for reproducible SQL params."""
    return [e for (s, e), m in ROLLUP_POLICY.items() if s == source and m == ROLLUP_WINDOW]
