"""Web-process authentication.

Three principal types:

  * Frontend user — Supabase JWT (HS256, project secret). See `supabase_jwt`.
  * Agent run — HS256 JWT signed by web, carried by chat/sandbox to call
    /api/agent/*. See `agent_jwt`.
  * System service — bare HMAC bearer (Composio webhooks, device ingest).
    Step C-sys, not yet wired.

FastAPI dependency factories live in `deps`. Routes use:

    user: User = Depends(current_user)              # /api/*
    run: AgentRun = Depends(current_agent_run)      # /api/agent/*
"""
