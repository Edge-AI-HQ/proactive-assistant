"""Chat ASGI entrypoint shim — fails fast if it ever sees master creds.

Run with: `uvicorn pinai_agents.chat.asgi:app --port 8001`

Trust separation: this process must NOT hold master credentials. The
fail-fast block below crashes the process immediately if a Fly secret
config or docker-compose env block accidentally exposes a master env
var to the chat process group. Crashing loud beats running silently
with confused-deputy capabilities.

Allowed to import `pinai_agents.chat` (per ruff per-file-ignores) but
NEVER `pinai_agents.web` — see pyproject.toml banned-api rules.

The forbidden list lives in `chat/trust_boundary.py` (single source of
truth, also consumed by Makefile and scripts/sync_fly_secrets.py).
"""

import logging
import os
import sys

from pinai_agents.chat.trust_boundary import FORBIDDEN_ENVS


def _assert_no_master_creds() -> None:
    leaked = [k for k in FORBIDDEN_ENVS if os.environ.get(k)]
    if leaked:
        sys.stderr.write(
            f"FATAL chat asgi entrypoint leaked master credentials: {leaked}. "
            f"Check fly.toml [processes.chat.env] / docker-compose env. "
            f"See docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx "
            f"§ trust 边界三道墙.\n"
        )
        sys.exit(1)


_assert_no_master_creds()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

# Import AFTER the assert so chat package doesn't load anything that
# might lazy-read forbidden env vars before we've checked.
from pinai_agents.chat.app import create_app  # noqa: E402

app = create_app()
