"""Runtime configuration loaded from env vars (decrypted by dotenvx at startup).

Step 1.2 adds LiteLLM compat config. Modal / Postgres added in 1.3 / 1.4.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Service identity
    service_name: str = "pinai-agents"
    deploy_env: str = "dev"

    # LiteLLM gateway. base URL is the OpenAI-compatible endpoint (includes /v1).
    # In docker compose: http://litellm:4000/v1. In Fly: the prod LiteLLM URL.
    litellm_base_url: str = "http://litellm:4000/v1"

    # Default model alias as registered in ops/litellm/litellm_config.yaml.
    default_model: str = "claude-sonnet-4-6"

    # Postgres URL for LangGraph checkpointer. Same Supabase instance as
    # pai_* tables (Step 2); schema-isolated under `langgraph`.
    # In docker compose: postgresql://postgres:postgres@postgres:5432/postgres.
    database_url: str | None = None

    # Schema name for LangGraph checkpoint tables. Set as Postgres
    # search_path so AsyncPostgresSaver creates checkpoints / checkpoint_blobs
    # / checkpoint_writes / checkpoint_migrations under this schema instead
    # of polluting `public`.
    langgraph_schema: str = "langgraph"

    # Service-to-service auth (set in Step 1.6 when APIs starts proxying).
    # APIs sends `Authorization: Bearer <PINAI_AGENTS_SERVICE_TOKEN>` on every
    # request; we compare in constant time. Both sides read from the same
    # encrypted env value.
    pinai_agents_service_token: str | None = None


settings = Settings()
