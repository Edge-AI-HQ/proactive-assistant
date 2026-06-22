"""Reward-dashboard runtime configuration.

The reward dashboard is an *internal* review tool. Trust-wise it can read
the product DB but must NOT hold any master credential (Supabase
service_role / JWT signing key / Composio / Stripe / LiteLLM master). It
therefore carries its own tiny settings object instead of importing the api
process's full settings (which hold the entire master-credential surface).
The fields here are exactly what the dashboard needs:

  * DB connection (pool) — read the product `pai_*` schema.
  * Supabase Auth *verification* inputs (publishable key + project URL) —
    verify a reviewer's bearer token. Verification only; never the secret
    key (no admin / RLS-bypass).
  * LangSmith *read* side — materialize deterministic trace artifacts for
    reviewers (the chat process emits traces; we only read them).
  * CORS allowlist for the dashboard SPA origin.

Usage:

    from pinai_reward_dashboard.config import get_settings
    settings = get_settings()
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class RewardDashboardSettings(BaseSettings):
    """Minimal, non-master-credential settings for the reward dashboard."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    deploy_env: str = "dev"

    # ── DB ──
    # Same `pai_*` schema the api process writes; the dashboard reads it
    # (and writes only its own reward/casebook/trace tables). pool sizing
    # mirrors the api defaults.
    database_url: str | None = None
    db_pool_max: int = 12
    db_pool_min: int = 1

    # ── Supabase Auth (verification inputs only) ──
    # Token verification calls `${SUPABASE_URL}/auth/v1/user` with the
    # publishable key as the `apikey` header. Accept either name so the
    # env file can ship a single line shared with the frontend bundle.
    supabase_url: str | None = None
    supabase_publishable_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "SUPABASE_PUBLISHABLE_KEY",
            "VITE_SUPABASE_PUBLISHABLE_KEY",
        ),
    )

    # ── LangSmith read side ──
    # The dashboard only reads traces on demand to build trace artifacts;
    # it never writes. Project name matches the chat process emitter.
    langsmith_api_key: str | None = None
    langsmith_project: str = "pinai-agents-chat"
    langsmith_endpoint: str = "https://api.smith.langchain.com"

    # ── CORS ──
    # Comma-separated allowlist for the dashboard SPA origin. The SPA lives
    # on its own Fly host, so the browser preflights every cross-origin
    # /api/* call.
    cors_allowed_origins: str = "http://localhost:3004,http://127.0.0.1:3004"


@lru_cache
def get_settings() -> RewardDashboardSettings:
    return RewardDashboardSettings()
