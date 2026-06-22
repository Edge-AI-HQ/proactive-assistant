"""Reward-dashboard ASGI entrypoint shim.

Run with: `uvicorn pinai_reward_dashboard.asgi:app`

All construction lives in `pinai_reward_dashboard.app.create_app`. This shim
exists so the uvicorn import path is stable even as the app factory internals
evolve.

This is a standalone workspace package (services/reward-dashboard,
pinai_reward_dashboard): it is an internal review tool that holds NO master
credential and never imports the api process's package. The isolation is
enforced physically by the dependency graph (this package depends only on
`pinai-db` + third-party libs) plus the import-linter contract.
"""

import logging

from pinai_reward_dashboard.app import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

app = create_app()
