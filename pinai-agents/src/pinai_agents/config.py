"""Process-scoped runtime configuration.

Trust split: the web process holds master credentials (Supabase service_role,
HMAC signing key, Composio key); the chat process must NOT. Each process
loads only the Settings subclass it needs, so a misconfigured Fly secret or
docker-compose env block fails loudly instead of silently exposing master
creds to the LLM loop. Runtime fail-fast in `chat/asgi.py` is the
defense-in-depth layer.

Usage:

    # web/asgi.py / web/app.py
    from pinai_agents.config import get_web_settings
    settings = get_web_settings()

    # chat/asgi.py / chat/...
    from pinai_agents.config import get_chat_settings
    settings = get_chat_settings()

ruff banned-api stops chat code from importing `get_web_settings` (and vice
versa) — see pyproject.toml.
"""

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class _BaseAppSettings(BaseSettings):
    """Fields common to web and chat. Identity / deploy env only — anything
    with credentials lives in a subclass scoped to one process group."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    service_name: str = "pinai-agents"
    deploy_env: str = "dev"


class WebSettings(_BaseAppSettings):
    """Web process settings."""

    # service_role connection. Step A's 023_pai_rls.sql relies on
    # `current_setting('app.user_id')::bigint` matching row user_id —
    # repository code wraps every query in BEGIN; SET LOCAL; ...; COMMIT
    # so RLS fires per request.
    # Aligned with Python ORM / LangGraph / LiteLLM convention. The
    # web pool and the chat checkpointer both read this from env, but
    # they're scoped to different schemas: web → pai_*, chat →
    # langgraph (see ChatSettings.langgraph_schema below).
    database_url: str | None = None
    # pg.Pool tuning. 12 mirrors apis pool size; raise as workload grows.
    db_pool_max: int = 12
    db_pool_min: int = 1

    # Scheduler tick interval. 3s = ceiling: PG LISTEN/NOTIFY wakes the
    # loop instantly on manual triggers, so this only matters for
    # cron-like schedules and as a fallback if NOTIFY drops. Each tick
    # is a SKIP LOCKED CTE (cheap, sub-millisecond on empty queue).
    scheduler_tick_seconds: int = 3
    # Per-task lease window. Renewed by heartbeat; reaper resets stale.
    scheduler_lease_seconds: int = 60

    # ── Supabase Auth ──
    # Token verification calls `${SUPABASE_URL}/auth/v1/user` with the
    # anon (publishable) key as `apikey` header — same network path
    # apis used. The frontend build already needs this value as
    # VITE_SUPABASE_PUBLISHABLE_KEY, so we accept either name; backend
    # ops can set the unprefixed `SUPABASE_ANON_KEY` if they want a
    # backend-only override.
    supabase_anon_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "SUPABASE_ANON_KEY", "VITE_SUPABASE_PUBLISHABLE_KEY",
        ),
    )

    # ── Per-run JWT signing (EdDSA only) ──
    # Ed25519 keypair, base64(raw 32-byte). Web holds private key (signs);
    # chat holds public key only (verifies). Asymmetric design = chat
    # process compromise can't mint new JWTs.
    pai_jwt_signing_key: str | None = None     # base64 32 bytes (web only)
    pai_hmac_issuer: str = "pinai-agents-web"        # JWT iss claim
    pai_hmac_audience: str = "pinai-agents-internal" # JWT aud claim
    # Per-run JWT lifetime. 1 hour by default; long-running dream tasks
    # extend via heartbeat refresh (not implemented yet).
    pai_run_jwt_ttl_seconds: int = 3600

    # Composio master key (single, shared across all users — see plan v2 § Q6).
    composio_api_key: str | None = None

    # ── Supabase REST + Storage (master credentials) ──
    # Used for: storing device-uploaded ambient media in the pai-media
    # bucket (signed URL for download). The service-role key bypasses RLS
    # — it MUST stay in web process only.
    supabase_url: str | None = None
    supabase_service_role_key: str | None = None
    # Bucket name. Must exist + have RLS configured (only service_role
    # writes; signed URLs grant per-object reads).
    supabase_media_bucket: str = "pai-media"

    # ── Stripe (master credentials) ──
    # Stripe SDK key for server-side checkout / subscription queries.
    # WEBHOOK_SECRET is the signing secret Stripe issues per webhook
    # endpoint — used to verify the X-Stripe-Signature header.
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    # Public base URL Stripe redirects users back to after checkout.
    payment_public_base_url: str | None = None

    # ── Browserbase (browser tool) ──
    # Both processes use these: chat creates / drives Browserbase sessions;
    # web lazily provisions per-user persistent contexts (one-shot bb.contexts.create
    # on first chat-send) and stores the id on users.browserbase_context_id.
    # Optional — empty string disables the browser tool surface.
    browserbase_api_key: str | None = None
    browserbase_project_id: str | None = None

    # ── CORS ──
    # Comma-separated list of origins allowed to call /api/* + /api/agent/*.
    # Frontend lives on a different origin (different host/port), so the
    # browser preflights every cross-origin call. Production should pin
    # to the frontend Fly URL; dev allows the docker-compose nginx port.
    # Example: "http://localhost:3000,https://proactive-ai-frontend-prod.fly.dev"
    cors_allowed_origins: str = (
        "http://localhost:3000,"
        "http://127.0.0.1:3000,"
        "capacitor://localhost,"
        "https://localhost"
    )

    # ── LiteLLM gateway (server-side service calls) ──
    # `litellm_base_url` is the LiteLLM HTTP endpoint (admin REST + OpenAI-
    # compatible completions live on the same host). `litellm_master_key`
    # is the deployment's admin token (Bearer auth on /user/new,
    # /key/generate, etc.) — keep on web only; chat reads per-user
    # virtual keys via JWT claim, never the master.
    litellm_base_url: str = "http://litellm:4000/v1"
    litellm_master_key: str | None = None

    # Per-user virtual key provisioning. `default_budget_usd` is the cap
    # we burn through a budget cycle; `default_budget_duration` is the
    # rolling reset window LiteLLM enforces (e.g. "30d", "7d"); allowed
    # models is the list passed to /key/generate so users can't switch
    # to a model the deploy hasn't whitelisted. RPM/TPM stay None unless
    # ops want per-key rate limits.
    litellm_default_budget_usd: float = 1000.0
    litellm_default_budget_duration: str = "30d"
    # Comma-separated list of LiteLLM model aliases (e.g.
    # "claude-sonnet-4-6,gpt-4o"). Empty = let LiteLLM apply its own
    # global allowlist (typically all configured models).
    litellm_allowed_models: str = ""
    litellm_default_rpm_limit: int | None = None
    litellm_default_tpm_limit: int | None = None

    # ── LangSmith read side for internal reward dashboard ──
    # chat process emits traces; web process only reads them on demand to
    # materialize deterministic trace artifacts for reviewers.
    langsmith_api_key: str | None = None
    langsmith_project: str = "pinai-agents-chat"
    langsmith_endpoint: str = "https://api.smith.langchain.com"


class ChatSettings(_BaseAppSettings):
    """Chat process settings — no master credentials.

    Step F-1 will add PAI_HMAC_VERIFY_SECRET (HS256 verify-only),
    WEB_INTERNAL_URL (for native @tool HTTPS calls). DAYTONA_API_KEY is
    consumed directly by the daytona SDK from env, no field needed here.
    """

    # web URL the chat process reaches (Fly 6PN internal in prod,
    # docker-compose service-name DNS in dev).
    web_internal_url: str = "http://pinai-web:8000"
    # Ed25519 public key, base64(raw 32 bytes). Chat verifies-only; never
    # has the private key (one-way trust direction enforced at the env level).
    pai_jwt_verify_pubkey: str | None = None

    # LiteLLM gateway (OpenAI-compatible). docker-compose: http://litellm:4000/v1
    litellm_base_url: str = "http://litellm:4000/v1"
    # LiteLLM model alias from ops/litellm/litellm_config.yaml
    default_model: str = "claude-sonnet-4-6"

    # LangGraph Postgres checkpointer. Same Supabase instance as Step A's
    # pai_*; isolated under `langgraph` schema. Step A's
    # 024_pai_chat_role.sql introduces a schema-scoped DB user
    # (`pai_chat`) so this URL never grants pai_* visibility.
    database_url: str | None = None
    langgraph_schema: str = "langgraph"

    # Step 1 service-to-service token (APIs → pinai-agents). Kept for
    # backward-compat through the transition; superseded by HS256 JWT in
    # Step F-1.
    pinai_agents_service_token: str | None = None

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
def get_web_settings() -> WebSettings:
    return WebSettings()


@lru_cache
def get_chat_settings() -> ChatSettings:
    return ChatSettings()
