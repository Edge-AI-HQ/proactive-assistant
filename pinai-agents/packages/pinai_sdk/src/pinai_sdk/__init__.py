"""pinai_sdk — async Python client for /api/agent/*.

Hand-written for now. Step E will replace with `openapi-python-client`
codegen output once the openapi.json contract stabilizes (after Step C
endpoint shapes settle).

Used in two places:
  1. Sandboxed Code Mode runs (generator / dream / evolve / crystallize):
     the LLM imports `from pinai_sdk import client` and calls methods.
  2. Native @tool wrappers can use it instead of raw http_client (Step F+
     refactor — current code uses http_client directly to keep deps lean).

Auth: reads `PAI_SANDBOX_TOKEN` from env (preferred — phantom token
issued by web's /api/agent/sandbox/phantom/mint). Falls back to
`PAI_RUN_JWT` for legacy callers that haven't migrated to phantom.
The chat process / Daytona sandbox sets one of these in env before
running the script. The web internal URL comes from `PAI_API_URL`
env (or defaults to http://pinai-web:8000 for compose dev).
"""

from __future__ import annotations

from ._client import SDK_CHEAT_SHEET, SUPPORTED_RAW_SOURCES, client

__all__ = ["SDK_CHEAT_SHEET", "SUPPORTED_RAW_SOURCES", "client"]
