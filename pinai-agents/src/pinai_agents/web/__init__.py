"""Web process group — holds master credentials.

FastAPI server that takes Supabase JWT from the frontend, exposes
`/api/*` (UI) and `/api/agent/*` (agent), runs Repository against
service_role Postgres, signs EdDSA JWTs for chat process / sandbox.

ruff banned-api forbids `pinai_agents.chat` imports from here — the LLM
loop must stay isolated in the chat process. See
docs/plans/2026-05-04-pinai-agents-backend-consolidation.mdx § trust 边界.
"""
