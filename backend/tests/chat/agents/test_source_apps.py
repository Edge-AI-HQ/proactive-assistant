"""derive_source_apps — 引文前缀 → 用户可见 app slug 的确定性映射。

新 citation 形状(agentic generator):`{toolkit} event id={event id}, title=…`,
首词 = event structured.toolkit(connector 事件)或 event source(world/device/
ambient)。解析不出前缀的字符串(LLM 大幅改写)直接丢弃——审计串永远不该
泄漏进 UI。chat 测试 import 需要 TAVILY_API_KEY,见 conftest。
"""

from __future__ import annotations

from agent_engine.agents.generator import derive_source_apps


def test_each_known_prefix_maps() -> None:
    assert derive_source_apps(["gmail event id=evt_1, title=s"]) == ["gmail"]
    assert derive_source_apps(["googlecalendar event id=evt_2, title=t"]) == ["gcal"]
    assert derive_source_apps(["gcal event id=evt_2, title=t"]) == ["gcal"]
    assert derive_source_apps(["world event id=evt_3, title=t"]) == ["web"]
    assert derive_source_apps(["device event id=evt_4, title=t"]) == ["device"]
    assert derive_source_apps(["ambient event id=evt_5, title=t"]) == ["ambient"]


def test_unknown_toolkit_passes_through() -> None:
    # 未映射 toolkit 直接透传 token 本身(slack/github/… 新 connector 免维护)。
    assert derive_source_apps(["slack event id=evt_6, title=t"]) == ["slack"]
    assert derive_source_apps(["github event id=evt_7, title=t"]) == ["github"]


def test_dedupe_keeps_first_seen_order() -> None:
    assert derive_source_apps(
        [
            "world event id=evt_1, title=a",
            "gmail event id=evt_2, title=b",
            "world event id=evt_3, title=c",
        ]
    ) == ["web", "gmail"]


def test_unparseable_citations_dropped() -> None:
    assert derive_source_apps(["scheduled-reminder"]) == []
    assert derive_source_apps(["totally rewritten by the llm"]) == []
    assert derive_source_apps([]) == []
