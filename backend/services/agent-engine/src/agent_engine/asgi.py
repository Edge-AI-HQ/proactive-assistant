"""Agent-engine ASGI entrypoint shim.

Run with: `uvicorn agent_engine.asgi:app --port 8001`

This is a standalone workspace package: it depends only on
`pinai-contracts`, never on the web package — the trust boundary is
enforced physically by the dependency graph, not just by lint rules.

Trust boundary — boot fail-fast (flag-gated, ready but not yet active):
the engine process must NOT see master credentials. On boot it can
fail-fast if any `FORBIDDEN_ENVS` var is present, refusing to run the
LLM loop with credentials it should never hold.

This is **gated behind `ENGINE_TRUST_FAILFAST`** (default OFF) because
fly secrets are app-level only (no per-process-group flag in flyctl
0.4.48): today web+engine share one fly app, so the engine process
sees the same env as web and an *active* check would crash boot. The
gate flips ON only after web/engine split into separate fly apps with
per-app secrets (`sync_fly_secrets.py --exclude-master` scopes the
engine app's secrets) — then the engine app sets
`ENGINE_TRUST_FAILFAST=1` and this becomes the runtime defence-in-depth
behind the deploy-layer isolation. See
docs/plans/2026-06-21-backend-rearchitecture.mdx §四/§十二.
"""

import logging
import os
import sys


def _assert_no_master_creds() -> None:
    """Exit the process if any master credential leaked into the engine env.

    No-op unless ``ENGINE_TRUST_FAILFAST`` is truthy — see module docstring
    for why this is gated (single fly app shares env until the app split).
    """
    # Imported lazily so the gate-off path stays cheap and tests can
    # monkeypatch the env before this module-level call runs.
    from agent_engine import trust_boundary

    if not trust_boundary.failfast_enabled(os.environ):
        return
    leaked = trust_boundary.leaked_master_creds(os.environ)
    if leaked:
        sys.stderr.write(
            f"FATAL agent-engine entrypoint saw master credentials: {leaked}. "
            f"per-app secret scoping is broken — the engine fly app must be "
            f"synced with `sync_fly_secrets.py --exclude-master`.\n"
        )
        sys.exit(1)


_assert_no_master_creds()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)

# Import AFTER the assert so the engine package doesn't load anything that
# might lazy-read forbidden env vars before we've checked.
from agent_engine.app import create_app  # noqa: E402

app = create_app()
