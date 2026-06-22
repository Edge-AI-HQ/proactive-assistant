"""Agent-engine service — the untrusted LLM execution surface.

Does NOT hold master credentials. Runs the LangGraph / DeepAgents loop.
Reaches user data only via HTTPS calls to web `/api/agent/*` with EdDSA
JWT. Holds: LiteLLM virtual key (per-user scope), Daytona token,
LangGraph checkpointer DB user (schema-scoped).

Trust boundary is physical: this is a standalone workspace package that
depends only on `pinai-contracts`, never on `backend` (web). It
cannot import the web package / master credentials. Runtime fail-fast
assert in `asgi.py` is the defense-in-depth layer.
"""
