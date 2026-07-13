"""Single source of truth for the chat process trust boundary.

The chat process is the LLM loop — it must NOT see master credentials.
Anything in `FORBIDDEN_ENVS` would let chat impersonate the trust
authority (mint LiteLLM virtual_keys, sign Supabase admin requests
with the secret key, issue PAI JWTs, etc.). Three independent
enforcement points read this list:

  1. ``chat/asgi.py`` — boot fail-fast assert; the process exits if any
     forbidden var is present in the environment.
  2. ``Makefile`` (target ``ensure-env-backend``) — derives
     ``backend/.env.chat`` from ``.env`` by stripping these keys,
     so the local docker-compose chat container never receives them.
  3. ``scripts/sync_fly_secrets.py`` — when CI auto-syncs ``.env.test``
     to fly secrets, the chat process group gets the full set MINUS
     these. Web gets everything.

Keep this module side-effect free so any consumer can ``import`` it
without booting the chat app.
"""

from __future__ import annotations

from collections.abc import Mapping

# NOTE: DATABASE_URL is intentionally NOT forbidden — chat uses it for
# its own LangGraph checkpointer (langgraph schema). The original
# design split web/chat onto separate DB roles (`postgres` vs
# `pai_chat`, scoped via 024_pai_chat_role.sql) so each process gets
# its own scoped DSN under the same DATABASE_URL var name. That role
# split isn't wired in test today; both processes connect with the
# same superuser DSN. Trust boundary degraded for now — re-tighten
# when web/chat split into separate fly apps with per-app secrets.
FORBIDDEN_ENVS: tuple[str, ...] = (
    "SUPABASE_SECRET_KEY",  # Supabase admin (`sb_secret_*`) — only web
    "PAI_JWT_SIGNING_KEY",  # EdDSA private key — only web (signs)
    "COMPOSIO_API_KEY",  # Composio master — only web (connector ingest)
    "STRIPE_SECRET_KEY",  # Stripe master — only web
    "STRIPE_WEBHOOK_SECRET",  # Stripe webhook signing — only web
    "LITELLM_MASTER_KEY",  # LiteLLM master — only web (mints virtual_keys)
    "APNS_AUTH_KEY",  # APNs .p8 private key — only web (signs push JWTs)
    "TENCENT_ASR_SECRET_KEY",  # Tencent RTASR master — only web (signs BLE mint URLs)
)


def failfast_enabled(env: Mapping[str, str]) -> bool:
    """Whether the engine boot guard (``asgi.py``) is armed.

    Gated by ``ENGINE_TRUST_FAILFAST`` (default OFF): a single fly app shares
    env across the web+engine process groups, so an active guard would crash
    boot until web/engine split into separate fly apps with per-app secrets.
    The engine app sets this to ``1`` after that split.
    """
    return env.get("ENGINE_TRUST_FAILFAST", "").strip().lower() in ("1", "true", "yes")


def leaked_master_creds(env: Mapping[str, str]) -> list[str]:
    """Master-credential env vars present in ``env``.

    Must be empty in the engine process — a non-empty result means per-app
    secret scoping failed (the engine fly app received secrets it should
    never hold). Consumed by ``asgi.py`` boot guard and the trust tests.
    """
    return [k for k in FORBIDDEN_ENVS if env.get(k)]
