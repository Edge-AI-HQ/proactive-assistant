"""测试 hermetic：不读 .env、不继承真 secret 环境变量，保证确定性。

否则 Settings 会把本地 .env 的真 key（如 ANTHROPIC_API_KEY）读进来，让"无 planner"
之类的测试意外打真 API。
"""

from __future__ import annotations

import pytest

from dev_pipeline.config import Settings, get_settings

_LEAKY_ENVS = (
    "ANTHROPIC_API_KEY", "LINEAR_API_KEY", "LINEAR_WEBHOOK_SECRET",
    "LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET",
    "STORE_PATH", "REPO_ROOT", "TARGET_REPO", "CODEX_LINEAR_ASSIGNEE_ID",
)


@pytest.fixture(autouse=True)
def _hermetic_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for key in _LEAKY_ENVS:
        monkeypatch.delenv(key, raising=False)
    get_settings.cache_clear()
