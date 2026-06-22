"""API ASGI entrypoint shim.

Run with: `uvicorn pinai_api.asgi:app`

All construction lives in `pinai_api.app.create_app`. This shim
exists so the uvicorn import path is stable even as the app factory
internals evolve.

This is a standalone workspace package (services/api, pinai_api): it
holds the master credentials and never imports `agent_engine`
(the LLM-loop process). The trust boundary is enforced physically by
the dependency graph (api does not depend on the engine package) plus
the ruff banned-api rule.
"""

import logging

from pinai_api.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

app = create_app()
