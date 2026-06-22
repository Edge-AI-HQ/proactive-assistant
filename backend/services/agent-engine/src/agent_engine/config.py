"""Agent-engine process configuration.

Trust boundary: the engine is the untrusted LLM execution surface. It runs
the agent loop over un-trusted input and MUST NOT see master credentials
(Supabase service_role, HMAC signing key, Composio key, …). As a standalone
workspace package `agent_engine` does not depend on `backend`
(web) at all, so it physically cannot import `WebSettings` / the master
credentials — the isolation is enforced by the package dependency graph, not
just a lint rule.

`ChatSettings` here is a copy of the chat-process slice that used to live in
`pinai_agents.config`: the shared `_BaseAppSettings` base fields plus the
engine-only fields (web URL, JWT verify pubkey, checkpointer DSN, LangSmith).
The web package keeps its own `WebSettings` with the master credentials.

Usage:

    from agent_engine.config import get_chat_settings
    settings = get_chat_settings()
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class _BaseAppSettings(BaseSettings):
    """Fields common to web and engine — anything with credentials lives in a
    subclass scoped to one process group."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    service_name: str = "backend"
    deploy_env: str = "dev"
    # Default LLM for agent runs — a LiteLLM model alias from
    # ops/litellm/litellm_config.yaml. Chat falls back to it when a run
    # doesn't specify a model; web probes it when checking a virtual key
    # still covers what agents need (litellm_provisioning).
    # Per-env override via DEFAULT_MODEL (dev runs glm-5.2; prod stays
    # on the code default).
    default_model: str = "claude-sonnet-4-6"

    # Small/fast model for internal annotations — currently the chat
    # work-group titles (harness/group_title.py). Cheap by design: one
    # short call per closed tool group. Override via GROUP_TITLE_MODEL.
    group_title_model: str = "claude-haiku-4-5"

    # Full-pipeline budget (seconds) for /agent/generate. The chat route's
    # asyncio.timeout guard uses it directly; web's httpx read timeout adds
    # +30s and the generator task lease adds +120s so each outer layer
    # outlives the inner one (chat's own 504 wins the race, the lease
    # covers the whole run). Default keeps today's behaviour; raise via env
    # GENERATE_TIMEOUT_SECONDS for local dev where real-account context +
    # local LLM latency overflow 600s (docker-compose.override.yml).
    generate_timeout_seconds: float = 600.0


class ChatSettings(_BaseAppSettings):
    """Chat process settings — no master credentials.

    Step F-1 will add PAI_HMAC_VERIFY_SECRET (HS256 verify-only),
    WEB_INTERNAL_URL (for native @tool HTTPS calls). DAYTONA_API_KEY is
    consumed directly by the daytona SDK from env, no field needed here.
    """

    # web URL the chat process reaches (Fly 6PN internal in prod,
    # docker-compose service-name DNS in dev).
    web_internal_url: str = "http://api:8000"
    # Ed25519 public key, base64(raw 32 bytes). Chat verifies-only; never
    # has the private key (one-way trust direction enforced at the env level).
    pai_jwt_verify_pubkey: str | None = None

    # LiteLLM gateway (OpenAI-compatible). docker-compose: http://litellm:4000/v1
    litellm_base_url: str = "http://litellm:4000/v1"

    # LangGraph Postgres checkpointer. Same Supabase instance as Step A's
    # pai_*; isolated under `langgraph` schema. Step A's
    # 024_pai_chat_role.sql introduces a schema-scoped DB user
    # (`pai_chat`) so this URL never grants pai_* visibility.
    database_url: str | None = None
    langgraph_schema: str = "langgraph"

    # ── LangSmith observability ──
    # LangChain's tracing client reads LANGCHAIN_TRACING_V2 / LANGCHAIN_API_KEY
    # / LANGCHAIN_PROJECT / LANGCHAIN_ENDPOINT directly from env. We expose
    # them on settings as the SSOT, then chat/app.py re-exports to env at
    # boot so the LC client picks them up without touching the CMD wrapper.
    # Disabled by default — flip langsmith_tracing=True (or env
    # LANGSMITH_TRACING=true) to enable per-deploy.
    langsmith_tracing: bool = False
    langsmith_api_key: str | None = None
    langsmith_project: str = "pinai-agents-chat"
    langsmith_endpoint: str = "https://api.smith.langchain.com"


@lru_cache
def get_chat_settings() -> ChatSettings:
    return ChatSettings()
