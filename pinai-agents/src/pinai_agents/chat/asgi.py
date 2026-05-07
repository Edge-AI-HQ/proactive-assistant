"""Chat ASGI entrypoint shim.

Run with: `uvicorn pinai_agents.chat.asgi:app --port 8001`

Allowed to import `pinai_agents.chat` (per ruff per-file-ignores) but
NEVER `pinai_agents.web` — see pyproject.toml banned-api rules.

Trust boundary (TEMPORARILY DISABLED): the planned design was for the
chat process to fail-fast if it sees any master credential, with the
forbidden list canonicalized in `chat/trust_boundary.py`. fly secrets
turned out to be app-level only (no per-process-group flag in flyctl
0.4.48), so chat sees the same env as web. The check below is
commented out until web/chat split into separate fly apps. The
trust_boundary.py module is kept (re-enable is one line).
"""

import logging

# from pinai_agents.chat.trust_boundary import FORBIDDEN_ENVS


# def _assert_no_master_creds() -> None:
#     import os
#     import sys
#     leaked = [k for k in FORBIDDEN_ENVS if os.environ.get(k)]
#     if leaked:
#         sys.stderr.write(
#             f"FATAL chat asgi entrypoint leaked master credentials: {leaked}. "
#             f"Check fly.toml [processes.chat.env] / docker-compose env.\n"
#         )
#         sys.exit(1)
#
#
# _assert_no_master_creds()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

# Import AFTER the assert so chat package doesn't load anything that
# might lazy-read forbidden env vars before we've checked.
from pinai_agents.chat.app import create_app  # noqa: E402

app = create_app()
