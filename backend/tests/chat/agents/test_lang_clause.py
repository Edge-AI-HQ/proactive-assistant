"""lang_clause 必须覆盖全部 8 种 SupportedGenerationLanguage。

历史 bug:generator 私有 _lang_clause 只认 zh/en,用户选 ja/ko/es/fr/de/pt
时卡片仍生成英文。本测试钉死 8 语言全覆盖 + 未知值回落英文。
"""

import pytest
from agent_engine.agents.prompts import lang_clause


@pytest.mark.parametrize(
    ("language", "name"),
    [
        ("en", "English"),
        ("zh-Hans", "Simplified Chinese"),
        ("zh", "Simplified Chinese"),
        ("ja", "Japanese"),
        ("ko", "Korean"),
        ("es", "Spanish"),
        ("fr", "French"),
        ("de", "German"),
        ("pt", "Portuguese"),
    ],
)
def test_lang_clause_covers_all_supported_languages(language: str, name: str) -> None:
    assert lang_clause(language) == f"Use {name} for all user-visible text fields"


def test_lang_clause_unknown_falls_back_to_english() -> None:
    assert "English" in lang_clause("ru")
    assert "English" in lang_clause("")


def test_dream_crystallize_evolve_prompts_inject_language() -> None:
    from agent_engine.agents.crystallize import _crystallize_system_prompt
    from agent_engine.agents.dream import _dream_system_prompt
    from agent_engine.agents.evolve import _evolve_system_prompt

    for build in (_dream_system_prompt, _crystallize_system_prompt, _evolve_system_prompt):
        assert "Use Japanese for all user-visible text fields" in build("ja")
        assert "Use English for all user-visible text fields" in build("en")
