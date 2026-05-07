"""Single source of truth for the chat process trust boundary.

The chat process is the LLM loop — it must NOT see master credentials.
Anything in `FORBIDDEN_ENVS` would let chat impersonate the trust
authority (mint LiteLLM virtual_keys, sign Supabase service-role
queries, issue PAI JWTs, etc.). Three independent enforcement points
read this list:

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

FORBIDDEN_ENVS: tuple[str, ...] = (
    "SUPABASE_DB_URL",            # service_role DB connection — only web
    "SUPABASE_SERVICE_ROLE_KEY",  # Supabase Storage admin — only web
    "PAI_JWT_SIGNING_KEY",        # EdDSA private key — only web (signs)
    "COMPOSIO_API_KEY",           # Composio master — only web (connector ingest)
    "STRIPE_SECRET_KEY",          # Stripe master — only web
    "STRIPE_WEBHOOK_SECRET",      # Stripe webhook signing — only web
    "LITELLM_MASTER_KEY",         # LiteLLM master — only web (mints virtual_keys)
)
