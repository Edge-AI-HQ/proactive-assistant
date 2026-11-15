# PIN AI Assistant Monorepo

PIN AI Assistant's main product line is Proactive AI. The backend is a uv workspace monorepo under `backend/`, split into three services: api (the trusted main process), agent-engine (the untrusted agent execution engine), and reward-dashboard (the internal review backend). The frontend is "one shared layer (`packages/*`) + multiple platform shells (`apps/*`)"; login goes through Supabase Auth, and all model calls are routed through LiteLLM.

The single source of truth for rules, hard constraints, and AI coding conventions is [`AGENTS.md`](AGENTS.md); this README is only an entry point.

## Development Docs

Team development and AI agent lookups treat `docs/modules/` as authoritative:

- [Data Connectors](docs/modules/data-connectors.mdx): Composio, device, and mobile data ingestion.
- [Memory](docs/modules/memory.mdx): the three lifelong-memory layers + projection pipeline + evolve.
- [Generation](docs/modules/generation.mdx): the card generation pipeline.
- [Execution](docs/modules/execution.mdx): chat-stream, agent tool surface, browser tool, control mode.
- [Feedback](docs/modules/feedback.mdx): feedback events and the learning feedback loop.
- [Background Tasks](docs/modules/background-tasks.mdx): task queue, scheduler, reconciler.
- [Internal Reward Dashboard](docs/modules/internal-reward-dashboard.mdx): the internal card review tool.
- [Runtime & Deployment](docs/modules/runtime-deployment.mdx): local startup, deployment, security, billing overview.

Mintlify entry point: [`docs/index.mdx`](docs/index.mdx).

## Key Directories

```text
backend/                      # Python uv workspace: api / agent-engine / reward-dashboard services + libs/{contracts,db}
packages/                     # cross-platform frontend shared layer (web + RN): core / design / state / ui-kit
apps/web/                     # zebra desktop web app (Vite + React, live in dev/prod; feature layer in src/ui-web)
apps/desktop/                 # Electron macOS shell; renderer reuses apps/web (local only)
apps/mobile/                  # Expo React Native iOS app (distributed via TestFlight)
internal-reward-dashboard/    # frontend of the internal card review tool (standalone Vite app)
ops/litellm/                  # LiteLLM config and deployment
docs/                         # team development docs
docs/plans/                   # referenceable AI design plans, not a historical archive
```

## Local Development

First-time setup:

```bash
cd backend && uv sync && cd -
npm install                                      # root workspace: packages/* + apps/*
cd internal-reward-dashboard && npm install && cd -
# Get the dotenvx private key from a team member and put it in ~/.zshrc: export DOTENV_PRIVATE_KEY_DEV=...
make up
```

Common commands:

```bash
make up
make logs
make restart
make status
make urls        # this worktree's random host ports + ngrok URL
make help
```

Lightweight development (without Docker):

```bash
cd backend && uv run uvicorn pinai_api.asgi:app --reload --port 8000        # api process
cd backend && uv run uvicorn agent_engine.asgi:app --reload --port 8001     # agent-engine process
cd apps/web && npm run dev                                                  # zebra web (port 3005)
```

Verification:

```bash
cd backend && uv run ruff check && uv run lint-imports && uv run mypy services libs && uv run pytest
npm run check:packages
cd apps/web && npm run type-check && npm test
```

For the full command list and the per-scope verification matrix, see the "Local Development" section of [`AGENTS.md`](AGENTS.md).

## Maintenance Rules

- Rules, hard constraints, and AI coding conventions: see [`AGENTS.md`](AGENTS.md).
- Current module facts: see `docs/modules/*.mdx`.
- Referenceable AI design plans: see `docs/plans/*.mdx`; a plan is kept only while a module doc references it.
- When changing a core flow, update the corresponding module doc at the same time.
