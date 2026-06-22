"""配置中心。所有 env 读取从这里走（对齐 pinai-agents 的 pydantic-settings 习惯）。

密钥本体在 ops/dev-pipeline/.env（gitignored）。测试不依赖真值——所有字段都有默认，
真链路才需要 .env 填齐。
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Linear ---
    linear_api_key: str = ""
    linear_oauth_client_id: str = ""
    linear_oauth_client_secret: str = ""
    linear_oauth_redirect_uri: str = ""
    linear_webhook_secret: str = ""
    linear_api_url: str = "https://api.linear.app/graphql"

    # --- GitHub / target repo ---
    target_repo: str = "Edge-AI-HQ/PIN-AI-ASSISTANT"
    # Codex agent 在 Linear 的 user id（确认后 delegate 给它触发干活）
    codex_linear_assignee_id: str = ""

    # --- planner（agent 的"脑子"：读代码 → 出 plan）---
    anthropic_api_key: str = ""
    planner_model: str = "claude-opus-4-8"
    planner_max_iterations: int = 20
    # 意图路由用的快模型（听懂用户 @ 这句话想干嘛，不靠关键词）
    intent_model: str = "claude-haiku-4-5"
    # 目标 repo 的本地 checkout 根目录（planner grep/read 用）；空=自动取 git 根
    repo_root: str = ""

    # --- 状态存储（app token / plan 草稿 / awaiting 标记）---
    store_path: str = "dev_pipeline.sqlite"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
