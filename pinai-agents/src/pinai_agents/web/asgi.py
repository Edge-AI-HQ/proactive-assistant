"""Web ASGI entrypoint shim.

Run with: `uvicorn pinai_agents.web.asgi:app`

All construction lives in `pinai_agents.web.app.create_app`. This shim
exists so the uvicorn import path is stable even as the app factory
internals evolve (Step C will mount a lot more here).

Trust separation: this entrypoint is allowed to import `pinai_agents.web`
(per ruff per-file-ignores) but NEVER `pinai_agents.chat` — see
pyproject.toml banned-api rules.
"""

import logging

from pinai_agents.web.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

app = create_app()
