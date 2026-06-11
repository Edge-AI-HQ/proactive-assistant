"""derive_source_apps — 引文前缀 → 用户可见 app slug 的确定性映射。

引文唯一生产者是 _citation_for;前缀首词即 source_type。解析不出
前缀的字符串(LLM 大幅改写 / "scheduled-reminder")直接丢弃——审计
串永远不该泄漏进 UI。chat 测试 import 需要 TAVILY_API_KEY,见 conftest。
"""

from __future__ import annotations

from pinai_agents.chat.agents.generator import derive_source_apps


def test_each_known_prefix_maps() -> None:
    assert derive_source_apps(["signal id=sig_1, title=t"]) == ["device"]
    assert derive_source_apps(["memory id=mem_1, text=t"]) == ["memory"]
    assert derive_source_apps(["gmail message id=abc, subject=s"]) == ["gmail"]
    assert derive_source_apps(["gcal event id=e1, title=t"]) == ["gcal"]
    assert derive_source_apps(["world id=world_1, title=t"]) == ["web"]
    assert derive_source_apps(["profile id=primary, summary=s"]) == ["profile"]
    assert derive_source_apps(["goal id=g1, title=t"]) == ["goal"]
    assert derive_source_apps(["preference id=p1, statement=s"]) == ["preference"]


def test_generic_connected_raw_prefix_passes_through() -> None:
    # _citation_for 的 generic 分支:f"{source_type} id=..."
    assert derive_source_apps(["slack id=m1, text=t"]) == ["slack"]
    # prompt 示例风格 "slack message id=" 的首词同样命中
    assert derive_source_apps(["slack message id=m1, user=u, text=t"]) == ["slack"]
    assert derive_source_apps(["gdrive file id=f1, name=n"]) == ["gdrive"]


def test_dedupe_keeps_first_seen_order() -> None:
    assert derive_source_apps(
        [
            "world id=w1, title=a",
            "gmail message id=m1, subject=b",
            "world id=w2, title=c",
        ]
    ) == ["web", "gmail"]


def test_unparseable_citations_dropped() -> None:
    assert derive_source_apps(["scheduled-reminder"]) == []
    assert derive_source_apps(["totally rewritten by the llm"]) == []
    assert derive_source_apps([]) == []
