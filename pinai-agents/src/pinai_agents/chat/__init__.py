"""Chat process group — does NOT hold master credentials.

Runs LangGraph / DeepAgents loop. Reaches user data only via HTTPS
calls to web `/api/agent/*` with EdDSA JWT. Holds: LiteLLM virtual
key (per-user scope), Daytona token, LangGraph checkpointer DB user
(schema-scoped).

ruff banned-api forbids `pinai_agents.web` imports from here. Runtime
fail-fast assert in `chat/asgi.py` rejects forbidden master env vars
on boot.
"""
