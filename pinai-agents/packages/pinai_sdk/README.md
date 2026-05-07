# pinai_sdk

Async Python client for the Pin AI agent API. Lives in
`packages/pinai_sdk/` so it can be:

1. Built as a wheel + baked into the Daytona sandbox image
   (`infra/daytona/Dockerfile`) — agents call `from pinai_sdk import client`
   inside `python_exec`.
2. Optionally installed into pinai-agents itself for native @tool
   wrappers to share its types (today they go through
   `pinai_agents.chat.tools.http_client` directly to keep deps lean).

The SDK reads `PAI_API_URL` + (`PAI_SANDBOX_TOKEN` or legacy
`PAI_RUN_JWT`) from env at every call; the chat process / Daytona
sandbox launcher must set them at sandbox creation. `PAI_SANDBOX_TOKEN`
is a phantom token (industry pattern: opaque sandbox-scoped credential,
the user's chat-driving JWT and LiteLLM virtual_key never enter the
sandbox).

Step E (codegen): currently hand-written. When the
`/api/agent/*` shape stabilizes, replace `src/pinai_sdk/_client.py` with
output from `openapi-python-client` against the live OpenAPI doc — see
`scripts/regen_sdk.py`.
