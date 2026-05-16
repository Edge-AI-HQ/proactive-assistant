"""Single source of truth for the chat process trust boundary.

The chat process is the LLM loop — it must NOT see master credentials.
Anything in `FORBIDDEN_ENVS` would let chat impersonate the trust
authority (mint LiteLLM virtual_keys, sign Supabase admin requests
with the secret key, issue PAI JWTs, etc.). Three independent
enforcement points read this list:

  1. ``chat/asgi.py`` — boot fail-fast assert; the process exits if any
     forbidden var is present in the environment.
  2. ``Makefile`` (target ``ensure-env-pinai-agents``) — derives
     ``pinai-agents/.env.chat`` from ``.env`` by stripping these keys,
     so the local docker-compose chat container never receives them.
  3. ``scripts/sync_fly_secrets.py`` — when CI auto-syncs ``.env.test``
     to fly secrets, the chat process group gets the full set MINUS
     these. Web gets everything.

Keep this module side-effect free so any consumer can ``import`` it
without booting the chat app.
"""

from __future__ import annotations

# NOTE: DATABASE_URL is intentionally NOT forbidden — chat uses it for
# its own LangGraph checkpointer (langgraph schema). The original
# design split web/chat onto separate DB roles (`postgres` vs
# `pai_chat`, scoped via 024_pai_chat_role.sql) so each process gets
# its own scoped DSN under the same DATABASE_URL var name. That role
# split isn't wired in test today; both processes connect with the
# same superuser DSN. Trust boundary degraded for now — re-tighten
# when web/chat split into separate fly apps with per-app secrets.
FORBIDDEN_ENVS: tuple[str, ...] = (
    "SUPABASE_SECRET_KEY",        # Supabase admin (`sb_secret_*`) — only web
    "PAI_JWT_SIGNING_KEY",        # EdDSA private key — only web (signs)
    "COMPOSIO_API_KEY",           # Composio master — only web (connector ingest)
    "STRIPE_SECRET_KEY",          # Stripe master — only web
    "STRIPE_WEBHOOK_SECRET",      # Stripe webhook signing — only web
    "LITELLM_MASTER_KEY",         # LiteLLM master — only web (mints virtual_keys)
    "APNS_AUTH_KEY",              # APNs .p8 private key — only web (signs push JWTs)
)
