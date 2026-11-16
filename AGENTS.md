# Repository Guidelines

## Coding Principles

Check each item when writing and reviewing code. All AI coding tools and team members follow these.

1. **Read before you write** — Understand the intent of the existing implementation before changing it. Don't write code based on guesses.
2. **Fix it properly, don't work around it** — Find the root cause; no workarounds. `as any`, `@ts-ignore`, `eslint-disable`, `# type: ignore`, and `# noqa` are forbidden unless a comment explains why it is the only option.
3. **Minimal changes** — Change only what needs changing. No drive-by refactors, no unrelated improvements.
4. **Use industry-standard approaches** — If the industry has a mature pattern for a feature, use the common solution instead of designing your own. If the module already has a pattern, reuse it instead of inventing a new one.
5. **System view** — Before changing anything, consider where it sits in the whole system: interface changes affect upstream and downstream; data changes need migrations.
6. **Defend at the boundary, trust inside** — Be defensive at system boundaries; inside, trust the type system.
7. **Efficiency** — Watch complexity and unnecessary IO, but don't sacrifice readability for micro-optimizations.
8. **Low redundancy without over-abstraction** — Remove real duplication. Three repeated lines beat an abstraction used once.
9. **Observable critical paths** — Log state changes and system boundaries; enough to locate problems.
10. **Self-review when done** — After implementing, review the full diff against the principles above and fix any issues immediately.

## Current Architecture

The PIN AI backend is a **uv workspace monorepo** under `backend/` (Python / FastAPI / LangChain + DeepAgents), split into three mutually independent services + two shared libs:

- **api** (`services/api/`, package `pinai_api`) — the trusted main process: control plane + domains + public edge; holds the master credentials.
- **agent-engine** (`services/agent-engine/`, package `agent_engine`) — the untrusted agent execution engine: runs all agents (chat / generator / evolve / rollup_semantic); depends only on `libs/contracts`.
- **reward-dashboard** (`services/reward-dashboard/`, package `pinai_reward_dashboard`) — backend for the internal review tool: read-only access to the product DB, zero dependency on product code, does not hold master credentials.
- **libs/contracts** (`pinai_contracts`) — shared api↔agent-engine protocol (SSE envelope, api models, agent_run); **libs/db** (`pinai_db`) — cross-service db foundation (pool / rls / audit / base) + shared pure-SQL repos (patterns / user_fingerprint).

The frontend of the internal card review tool is **internal-reward-dashboard** (a standalone Vite React app; login via Supabase Auth). All LLM calls are routed through **LiteLLM**. Backend re-architecture design SSOT: [`docs/plans/2026-06-21-backend-rearchitecture.mdx`](docs/plans/2026-06-21-backend-rearchitecture.mdx).

The user-facing product frontend is "**one shared layer + multiple platform shells**": cross-platform logic and UI live in `packages/*`; each platform only writes its shell.

Shared layer `packages/` (bottom-up; inter-package boundaries enforced by rules in the root `eslint.config.mjs`; all four packages are shared by both web and RN):
- `@pin-ai/core` — pure TS: transport/SSE, API domain functions, domain types, pure state machines, platform ports interfaces (no react / capacitor / electron / browser globals).
- `@pin-ai/design` — cross-platform design token SSOT (`tokens.cjs/mjs/json`, shared by web Tailwind and RN NativeWind; change color values only here).
- `@pin-ai/state` — cross-platform React hooks: TanStack Query / zustand / business orchestration / auth glue; depends on core (no react-dom / platform APIs).
- `@pin-ai/ui-kit` — dual-platform design system layer: `cn` utility / component contracts / cva variants / motion presets / `locales/` (single source of truth for i18n strings on both platforms); platform-agnostic, depends on design.

Platform shells:
- **apps/web** — the desktop web app with the zebra design (Vite + React 19 + react-router), consumes core/state/ui-kit, **live in dev/prod**. The feature layer is in `src/ui-web/` (formerly the shared package `@pin-ai/ui-web`; after the Capacitor shell was retired this app was its only consumer, so it was moved in 2026-07). Design SSOT: [`docs/plans/2026-06-12-zebra-web-app-port.mdx`](docs/plans/2026-06-12-zebra-web-app-port.mdx).
- **apps/desktop** — Electron macOS shell; the renderer reuses the Vite root of apps/web ("one zebra UI, two shells: web + desktop"); the desktop side only has main + preload. Local only via `make macos`; no automated deployment yet.
- **apps/mobile** — Expo / React Native iOS app with an independently implemented UI; the business layer consumes core/design/state/ui-kit. **Has taken over iOS delivery (TestFlight; not yet on the App Store)**: dev builds automatically on push to main, prod is dispatched manually (both via `build-rn-ios.yml`; both verified end to end).
- **proactive-ai-frontend** (Capacitor) — **retired and deleted (2026-07-09)**: the former production iOS frontend; TestFlight delivery was taken over by apps/mobile (RN) and the web form by apps/web. The source lives in git history.

The two web shells (apps/web / apps/desktop) import `packages/*/src` directly via vite alias + tsconfig paths (no build step; package changes take effect immediately); apps/mobile uses npm workspace dependencies (resolved by metro). Frontend layering SSOT: [`research/2026-06-10-frontend-layering.mdx`](research/2026-06-10-frontend-layering.mdx); dual-platform design system SSOT: [`docs/plans/2026-06-13-dual-platform-design-system.mdx`](docs/plans/2026-06-13-dual-platform-design-system.mdx).

The three legacy repo directories `apis/` (Node backend + container orchestration + gateway), `pinai-openclaw/` (per-user container image + plugin), and `miniapp/` (Telegram mini app) have been removed; all their responsibilities moved to `backend/`:

- Control plane (auth / device / connector / payment / scheduler / migrations) → **api process** (`pinai_api`).
- LLM paths (chat / generate / evolve agents + Daytona sandbox tools) → **agent-engine process** (`agent_engine`).
- Internal reward review backend (reward ledger / casebook / trace / pattern curate / data snapshot) → **reward-dashboard process** (`pinai_reward_dashboard`), read-only product DB.
- The per-user OpenClaw containers and the gateway proxy are fully retired; the frontend calls `pinai_api` HTTP/SSE directly.
- **Current fly deployment**: **all three environments are split into three separate fly apps** — `proactive-ai-{api,engine,reward}-{dev,test,prod}` (api = trusted edge holding master credentials / engine = untrusted LLM loop with scoped secrets / reward = read-only review backend). Configs are in `backend/deploy/fly-split/fly.{api,engine,reward}.{dev,test,prod}.toml`; CI deploys them via `deploy-agents-split` in `_deploy.yml` (per-app scoped secrets + deploy). The old single-app setup (`proactive-ai-agents-{dev,prod}`) is retired; its tomls and CI job are gone. Inside the fly private network, api→engine uses **6PN service discovery** (`proactive-ai-engine-<env>.internal:8001`, **not flycast** — see Gotchas §9).

## Process Trust Boundary (api vs agent-engine)

The three services are physically separate packages in the `backend/` monorepo (no imports between them), with a **single trust boundary**:

- **api process** (`pinai_api`): holds the master credentials (`SUPABASE_SECRET_KEY` / `PAI_JWT_SIGNING_KEY` / `COMPOSIO_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `LITELLM_MASTER_KEY`). Responsible for actions taken "on behalf of the user": signing JWTs, minting LiteLLM virtual keys, writing to Supabase Storage, calling the Supabase Auth admin API, running Composio ingest, etc.
- **agent-engine process** (`agent_engine`): runs the LLM loop and **must not** see master credentials. Talks to api over HTTPS with per-run JWTs signed with EdDSA (Ed25519); its input is treated as untrusted.
- **reward-dashboard process** (`pinai_reward_dashboard`): internal review tool, read-only access to the product DB (via `pinai_db`), does **not** hold master credentials, does **not** depend on `pinai_api`.
- **Runtime defenses — current state** (single source of truth for FORBIDDEN_ENVS: `backend/services/agent-engine/src/agent_engine/trust_boundary.py`):
  - **Local compose still enforces it**: the Makefile target `ensure-env-backend` derives `.env.chat`, so the local agent-engine container cannot see master credentials.
  - **Runtime defenses are enabled in all three fly environments**: after the three-app split, engine is a separate fly app (`proactive-ai-engine-{dev,test,prod}`). CI's `sync_fly_secrets.py --exclude-master` keeps master credentials out, and `fly.engine.{dev,test,prod}.toml` sets `ENGINE_TRUST_FAILFAST="1"` to arm the boot fail-fast — the engine process exits immediately if it receives a master credential. (Before the 2026-07-07 split, prod ran in a degraded single-app form: flyctl has no per-process-group secrets, so the engine process could see master credentials and failfast was OFF.)
- **Static defenses (still active)**: ruff `flake8-tidy-imports.banned-api` forbids `pinai_api` from importing `agent_engine`; import-linter (`uv run lint-imports`) runs 6 forbidden contracts on the merged import graph (each pair of the three services forbids imports both ways) + api-internal layering contracts (platform is the foundation layer); CI runs `scripts/check_trust_boundary.sh` as a fallback grep check of import direction; shared types live in `libs/contracts` (`pinai_contracts`, pure models / protocols). Read the docstring of `agent_engine/trust_boundary.py` before changing the trust boundary.

## Environment Topology

| Env | backend | Web (zebra) | Internal reward dashboard | LiteLLM |
|------|---------|-------------|---------------------------|---------|
| dev | `proactive-ai-{api,engine,reward}-dev` (three apps) | `proactive-ai-web-dev` | `proactive-ai-reward-dashboard-dev` | `proactive-ai-litellm-dev` |
| test | `proactive-ai-{api,engine,reward}-test` (three apps) | none yet (skipped in CI) | no separate app yet | `proactive-ai-litellm-test` |
| prod | `proactive-ai-{api,engine,reward}-prod` (three apps) | `proactive-ai-web-prod` | no separate app yet | `proactive-ai-litellm-prod` |

> ⚠️ In the backend column, dev `proactive-ai-reward-dev` is **the reward-dashboard backend service from the three-app split** (`pinai_reward_dashboard`). It is a different app from `proactive-ai-reward-dashboard-dev` in the "Internal reward dashboard" column (the internal-reward-dashboard Vite **frontend** app used by reviewers). Don't mix them up.

All fly apps are in the `iad` / `ord` regions. The Daytona sandbox is the remote execution environment of the agent-engine process (python_exec and the browser tool run there); it is not a fly app.

The table above is by fly app. **apps/desktop** (Electron desktop) and **apps/mobile** (Expo RN, distributed via TestFlight) are not fly apps; see "Changes & Deployment" for how they ship. The three web fly apps of the old proactive-ai-frontend (`proactive-ai-frontend-{dev,test,prod}`) were suspended on 2026-07-09 (machines=0, shell kept; `flyctl scale count 1` revives them; they will be destroyed after an observation period).

## Secrets Management (dotenvx)
All environment variables (backend secrets + frontend VITE_*) are encrypted and checked in with [dotenvx](https://dotenvx.com/), with one private key per environment.

```
backend/.env.dev / .env.test / .env.production       # encrypted source of truth for backend + VITE_* (checked in)
ops/litellm/.env.dev / .env.test / .env.production        # encrypted source of truth for LiteLLM
./.env.dev                                                # root: encrypted source of truth for NGROK_AUTHTOKEN (reuses the DEV keypair, checked in)
backend/.env.keys / ops/litellm/.env.keys            # private key files, not checked in; or use DOTENV_PRIVATE_KEY_* env vars (~/.zshrc) — pick one
backend/.env / backend/.env.chat / ops/litellm/.env / ./.env  # local plaintext, generated by make ensure-env; don't edit by hand, don't commit
```

`.env.chat` is derived from `.env` by `make ensure-env-backend` — it strips the master credentials listed in `FORBIDDEN_ENVS` and is used only by the local `agent-engine` container (the FORBIDDEN_ENVS source of truth is `backend/services/agent-engine/src/agent_engine/trust_boundary.py`). For dotenvx CLI usage see the [official dotenvx docs](https://dotenvx.com/); for Fly secret sync see `backend/scripts/sync_fly_secrets.py`; for CI secret injection see `.github/workflows/deploy-{dev,test,prod}.yml`.

**Supabase API key naming** (always use Supabase's current names; the legacy names `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` are **forbidden**):
- `VITE_SUPABASE_PUBLISHABLE_KEY` (public `sb_publishable_*`) — the same value is shared by the frontend and by the backend for JWT verification. The backend can read this env var or set `SUPABASE_PUBLISHABLE_KEY` separately; the two are equivalent.
- `SUPABASE_SECRET_KEY` (private `sb_secret_*`) — a master credential of the api process. Used for admin calls that bypass RLS, such as Supabase Storage writes and `/auth/v1/admin/users/{id}`. **Must never** enter the agent-engine process.
- Get them from the Supabase dashboard: Project Settings → API Keys. Don't use the legacy "Anon / service_role" tab.

## Key Directories
- `backend/pyproject.toml`: uv workspace root (`members = libs/* services/*`) + import-linter contracts + ruff/mypy config.
- `backend/services/api/src/pinai_api/config.py`: pydantic-settings config center; all env reads go through here.
- `backend/services/api/src/pinai_api/`: api process (FastAPI app + control plane + domains + public edge). Entry points `app.py` / `asgi.py`.
- `backend/services/api/src/pinai_api/platform/`: private foundation layer (unreachable from agent-engine / reward-dashboard), containing `auth/` (deps + user_service + supabase/agent JWT), `db/` (including `repositories/` = api-private repos such as chat_messages/threads, devices, scheduled_tasks, jti_revocations), `litellm/`, `middleware/`, `storage.py`, `notification.py`, `embeddings.py`, `llm_json.py` (voice ASR is in `domains/voice/`).
- `backend/services/api/src/pinai_api/domains/`: product domains, organized vertically. Each domain has `ui.py` (frontend-facing, `current_user`) + `agent.py` (internal API authenticated by the `current_agent_run` JWT; domains with multiple routers add a topic prefix, e.g. `composio_agent.py`; memory has its own `ui.py`/`agent.py` in each subpackage) + service + repository. Domains include `identity/`, `memory/` (the four lifelong-memory subpackages `events/` (L1 storage + retrieval + event_source drill-down) / `projection/` (L0→L1 projection + rollup window) / `portrait/` (L2 portrait + seed) / `curation/` (evolve audit + surface); module map in §11 of [`docs/plans/2026-06-23-lifelong-memory-system.mdx`](docs/plans/2026-06-23-lifelong-memory-system.mdx)), `user_model/` (settings/skills), `connector/{apps,device,world}/`, `billing/` (including `payments/`, `metering.py`), `generation/` (single multi-turn agent run, including `context_anchor.py`, `card_fanout.py`), `feedback/`, `chat_history/`, `browser/`, `voice/`.
- `backend/services/api/src/pinai_api/control/`: actor control kernel (`kernel.py` / `worker.py` / `sessions.py` / `mailbox.py` / `runs.py` / `framebus.py` / `bus.py` + `execution_client.py` which calls agent-engine + `conversation.py` execution entry + `chat_turn_recorder.py` + `chat_proxy.py` one-shot signed proxy for history/generate + `agent_runs.py` frontend agent-run status surface).
- `backend/services/api/src/pinai_api/orchestration/`: scheduler (`tick_loop.py` / `dispatcher.py` / `cron.py`) + `account_lifecycle.py` + `retime.py` (recomputes cron tasks when the device time zone drifts).
- `backend/services/agent-engine/src/agent_engine/`: agent-engine process (LLM loop + DeepAgents harness + Daytona sandbox). Entry points `app.py` / `asgi.py`; `trust_boundary.py` = FORBIDDEN_ENVS source of truth.
- `backend/services/agent-engine/src/agent_engine/transport/routes/`: `chat.py`, `generate.py`, `history.py`, `run.py`.
- `backend/services/agent-engine/src/agent_engine/agents/`: agent implementations such as generator / main_chat / card_execution / evolve (absorbed the former dream; crystallize was deleted) / rollup_semantic / generation_context.
- `backend/services/agent-engine/src/agent_engine/tools/` + `tools/browser/`: sandbox tools (python_exec, browser via Browserbase); `harness/` = deepagents adapter (factory / compaction / checkpoint / middleware).
- `backend/services/reward-dashboard/src/pinai_reward_dashboard/`: internal reward review backend (`routes.py` = `/api/reward-dashboard/*` + `reward.py` / `trace_artifacts.py` / `pattern_extractor.py` / `pattern_health.py` / `personal_data_snapshot.py`). Read-only product DB, zero dependency on product code.
- `backend/libs/contracts/src/pinai_contracts/`: pure models / protocols shared by api/agent-engine (`sse_envelope.py` / `api_models.py` / `agent_run.py` / `composio_policy.py` side-effect classification / `rollup_policy.py`); must not import any service.
- `backend/libs/db/src/pinai_db/`: cross-service db foundation (`pool.py` / `rls.py` / `audit.py` / `base.py` / `raw_sources.py`) + `repositories/` (`patterns.py` / `user_fingerprint.py`, pure-SQL repos shared by generation and reward-dashboard).
- `backend/packages/pinai_sdk/`: Python SDK used inside the Daytona sandbox; the sandbox calls back to the api process via `PAI_API_URL`.
- `backend/db/migrations/`: yoyo-style SQL migrations named `NNN_<topic>.sql` (by convention, migrations touching pai schema tables get a `pai_` prefix, e.g. `015_pai_background_tasks.sql`).
- `backend/db/ingest_recipes/`: declarative recipes for connector ingest.
- `backend/infra/daytona/`: Daytona snapshot build scripts.
- `backend/scripts/`: `sync_fly_secrets.py` (trust boundary guard), `regen_sdk.py`, `check_trust_boundary.sh`, `validate_ingest_recipe.py`.
- `packages/core/src/`, `packages/state/src/`: cross-platform pure logic layer (`@pin-ai/core` = transport/SSE/API/domain types/state machines/ports; `@pin-ai/state` = TanStack Query/zustand/orchestration hooks); platform-agnostic, boundaries enforced by the root eslint config.
- `packages/design/`: cross-platform design token SSOT (`@pin-ai/design`, `tokens.cjs/mjs/json`, shared by web Tailwind + RN NativeWind).
- `packages/ui-kit/src/`: dual-platform design system layer (`@pin-ai/ui-kit`, `cn` / component contracts / cva / motion presets); platform-agnostic, shared by web and RN.
- `apps/web/src/ui-web/`: apps/web feature layer (auth / chat stack / sphere / cards / connect / voice / browser / settings sections; formerly the shared package `@pin-ai/ui-web`, moved into the app in 2026-07). Hard rule: "must run as pure web"; desktop capabilities are detected and injected via the desktop-bridge (the consumer side of the core ports registration points registerSignOutCleanup / registerFeedbackOutbox / registerLocalThreadStore lives here).
- `apps/web/src/`: zebra desktop web app (standalone Vite app; shell = ZebraShell/panels/⌘K, features = shared layer). Live in dev/prod (see "Changes & Deployment").
- `apps/desktop/src/`: Electron macOS shell (`main` + `preload`; the renderer reuses apps/web, see `electron.vite.config.ts`). Local `make macos`; no automated deployment yet.
- `apps/mobile/src/`: Expo / React Native iOS app (independently implemented UI, consumes core/design/state/ui-kit; native data collection in `apps/mobile/modules/`). In development, not yet released; local `make rn`.
- `research/2026-06-10-frontend-layering.mdx`: frontend layering SSOT (three layers core/state/apps; three platforms web/Electron/RN).
- `internal-reward-dashboard/src/`: internal reward review app (`/runs`, `/cards/:cardId`, `/casebook`, `/traces/:runId`, `/personal-data`), local port `3004`; don't mix it into the main product frontend.
- `ops/litellm/`: LiteLLM config + fly toml + deploy scripts.

## Docs Reading Rules (required for AI)
`docs/` is the shared context for team development and AI agent lookups. Read it progressively, in this order:

1. Start with [`docs/index.mdx`](docs/index.mdx) to identify which module the task belongs to.
2. Then read the relevant `docs/modules/*.mdx`. Module docs are the current facts; treat them as authoritative before changing code.
3. Only read `docs/plans/*.mdx` when a module doc lists it in the "Related AI Plans" section at the bottom, or when the task explicitly involves that design trade-off.
4. Don't treat `docs/plans/` as a historical archive. A plan is just a referenceable AI design plan; it does not replace module docs.
5. If code behavior conflicts with the docs, verify the current facts against the code and update the corresponding module doc.

> Module docs went through a full alignment pass on 2026-07-10 (three-app split / lifelong-memory / card generation v2 / Composio side-effect gate / RN taking over the frontend). For any later conflicts between code and docs, the code wins; update the module doc while you're there. The design SSOT for the three-service backend re-architecture is [`docs/plans/2026-06-21-backend-rearchitecture.mdx`](docs/plans/2026-06-21-backend-rearchitecture.mdx).

## Docs Maintenance Rules
- `docs/modules/*.mdx`: one current-facts doc per module; each must cover boundaries, core flows, development entry points, how to verify, and gotchas.
- `docs/plans/*.mdx`: keep only AI plans that still explain the current design, or design drafts still being brainstormed.
- The default path for a new plan is `docs/plans/YYYY-MM-DD-<topic>.mdx`; long-term architecture plans may use a stable slug.
- After adding a plan, you must register a row in the table in `docs/plans/README.mdx` (with status: brainstorm draft / finalized).
- Plans should preferably be referenced from a module doc's "Related AI Plans" section; brainstorm drafts may be listed only in the `plans/README` index at first.
- A plan may be deleted and removed from the README index only after **its implementation is live and the module doc has fully absorbed the key design points**; no archive is created. Plans in the design phase or with implementation in progress are always kept.
- The Mintlify sidebar contains only `docs/index.mdx` + `docs/modules/*.mdx` + `docs/plans/README.mdx` (the AI Plans index); individual plans are not in the sidebar and are reached via the index or a module page's "Related AI Plans" section.

## Current Module Docs
- [`docs/modules/data-connectors.mdx`](docs/modules/data-connectors.mdx) — Composio, device registry, mobile ingest, connection status matrix.
- [`docs/modules/memory.mdx`](docs/modules/memory.mdx) — the three lifelong-memory layers (L0 `pai_raw_apps`/`pai_raw_device`/`pai_world_signals` / L1 `pai_events` / L2 `pai_user_strings` portrait) + projection pipeline + evolve. **Must read before changing `domains/memory/`, the events/portrait/raw schemas, or evolve-related code**; design SSOT = [`docs/plans/2026-06-23-lifelong-memory-system.mdx`](docs/plans/2026-06-23-lifelong-memory-system.mdx).
- [`docs/modules/generation.mdx`](docs/modules/generation.mdx) — `/generate`, pipeline, unified generator, evaluation, card selection, auto-generate.
- [`docs/modules/execution.mdx`](docs/modules/execution.mdx) — chat-stream, card chat, agent prompt + memory tool surface (events_search/event_source/event_append/memory_edit + portrait injection), browser tool, control mode. **Must read before changing code related to `agent_engine/transport` / `agent_engine/agents` / `agent_engine/tools/browser` / `pinai_api/control` / the frontend MainChatView**.
- [`docs/modules/feedback.mdx`](docs/modules/feedback.mdx) — feedback events, card action, card chat feedback, intent state, learning feedback loop.
- [`docs/modules/internal-reward-dashboard.mdx`](docs/modules/internal-reward-dashboard.mdx) — internal card review Vite app, reward ledger, reviewer score, casebook, LangSmith trace artifacts. **Must read before changing `internal-reward-dashboard/`, `/api/reward-dashboard/*`, `pai_card_reward_events` / `pai_card_casebook` / `pai_trace_artifacts`**.
- [`docs/modules/background-tasks.mdx`](docs/modules/background-tasks.mdx) — `background_tasks` queue, scheduler tick, reconciler, connector init/sync/evolve (per-user coalesce), auto evolution (periodic sweep; the kind is still named `auto.dreaming`).
- [`docs/modules/runtime-deployment.mdx`](docs/modules/runtime-deployment.mdx) — local startup, runtime topology, deployment, security, billing overview (aligned on 2026-07-10 with the state after the three-app split + Capacitor frontend retirement).

## Local Development

First-time setup:
```bash
cd backend && uv sync && cd -
npm install                # root workspace installs packages/* + apps/*
cd internal-reward-dashboard && npm install && cd -
# Get the dotenvx private key from a team member and put it in ~/.zshrc (one DEV key decrypts all .env.dev files):
#   export DOTENV_PRIVATE_KEY_DEV=...
# (or the old way: put .env.keys files in backend/ and ops/litellm/ — pick one)
make up                    # decrypts .env.dev → .env automatically, builds and starts all services
```

Full stack (Docker Compose):
```bash
make up                    # starts postgres + redis + litellm + api + agent-engine + reward-dashboard + web(zebra)
make logs                  # follow all logs
make logs-api              # api process only
make logs-agent-engine     # agent-engine process only
make restart               # rebuild api + agent-engine after backend code changes
make restart-web           # after changing apps/web (container version)
make reset                 # wipe data and start from scratch (data will be lost)
make status                # container status
make urls                  # this group's random host ports + ngrok URL
```

Parallel worktrees: each worktree runs its own docker group (`COMPOSE_PROJECT_NAME=pinai-<worktree path hash>`; containers/networks/volumes/ports are isolated automatically), so you can `make up` in several at once without collisions.
- Host ports are **random** (no longer fixed at 8000/3000/54322); use `make urls` to see this group's actual ports. Browser web testing uses each group's own localhost and **does not need ngrok** (same-origin + nginx inside the container reverse-proxies to the compose service `api:8000`).
- Containers have **no fixed names**; to enter a container or view logs use `docker compose exec <service>` / `docker compose logs <service>`, **not** `docker exec pin-ai-xxx`.
- Worktrees share Docker Desktop memory: litellm is trimmed to 1 worker + a 1.5g cap, ~1.25GB per group, so 7.65GB fits ~6 in parallel.

Lightweight development (without Docker):
```bash
cd backend && uv sync --all-packages           # install Python deps for the whole workspace
cd backend && uv run uvicorn pinai_api.asgi:app --reload --port 8000        # api process
cd backend && uv run uvicorn agent_engine.asgi:app --reload --port 8001     # agent-engine process
cd apps/web && npm run dev                          # zebra desktop web dev server (port 3005)
cd internal-reward-dashboard && npm run dev -- --host 127.0.0.1 --port 3004  # internal review app
```

Locally, `internal-reward-dashboard` splits traffic between two backends via a Vite same-origin proxy: `/api/reward-dashboard/*` → reward-dashboard (default `127.0.0.1:8002`), all other `/api/*` → api (default `127.0.0.1:8000`). With random worktree ports, point `VITE_REWARD_PROXY_TARGET` / `VITE_PIN_API_PROXY_TARGET` at the actual ports from `make urls`. Supabase `VITE_*` values are read from `backend/.env` by default. It is currently not part of the root npm workspace; its dev environment is the standalone Fly app `proactive-ai-reward-dashboard-dev`.

The Daytona sandbox (`python_exec` for generate / evolve) needs to call back to `api` over the public internet (RN on a physical device doesn't — `make rn` by default connects directly to the local api via LAN IP on the same WiFi). `NGROK_AUTHTOKEN` is encrypted and checked in at the root `./.env.dev` (decrypted automatically by `make ensure-env`); ngrok gives each worktree a **stable subdomain** `https://<project-name>.ngrok.app` (compose uses `--url=https://${COMPOSE_PROJECT_NAME}.ngrok.app`, a paid-plan feature). **`make up` does not start the tunnel automatically** (web testing doesn't need it, and it saves ngrok endpoint hours); start it explicitly when needed:
```bash
make tunnel-up             # start ngrok (random URL) + inject the URL into agent-engine (used by the generator)
make tunnel-status         # show the current URL
make tunnel-down
```
Each worktree uses its own `.ngrok.app` subdomain (= project hash), so **multiple worktrees and multiple people sharing the same token can each run a tunnel concurrently without conflicts** (each gets its own URL). This requires **paid ngrok** — the free plan only allows the account's single dev domain, and opening more fails with ERR_NGROK_334; only the paid plan allows arbitrary `<name>.ngrok.app` subdomains.

iOS (RN, apps/mobile) multi-environment and signing hard rules:
- **The dev/prod pair of apps is intentional multi-environment design**: dev = bundle id `ai.pin.proactive.development` (display name "PIN AI Dev"), prod = `ai.pin.proactive` ("PIN AI"); each uses its own distribution profile and both can coexist on one device. Bundle id / display name / OAuth scheme are injected by `apps/mobile/app.config.js` based on `APP_VARIANT` (unset = local `ai.pin.proactive.dev` / `ci-dev` / `prod`); scheme = bundle id (the Supabase allowlist is configured accordingly); don't edit Xcode by hand. In CI, `APP_VARIANT` must be carried through both the prebuild and Archive steps (see docs/frontend/troubleshooting.mdx for the incident notes). dev builds automatically on push and uploads to TestFlight; prod is dispatched manually (both via `build-rn-ios.yml`). Push notifications: dev's `APNS_BUNDLE_ID=ai.pin.proactive.development` + `APNS_USE_SANDBOX=false` (production endpoint) serve the TestFlight build; local builds signed with a personal team don't receive push (development signing yields sandbox tokens), regardless of bundle id.
- **Never switch ids to work around a problem**: don't add or change a bundle id / package name / scheme / target to get around signing failures, unmet permissions/capabilities, or validation errors. When signing/profile requirements aren't met, stop and report the real blocker instead of switching ids.
- Installs within one environment overwrite the app using that environment's original bundle id; don't create a third id beyond these two just to have them coexist.

Expo RN two-layer daily development and physical-device verification rules:
- **Use Debug by default; don't use Release for daily development**. Release is only for TestFlight, formal delivery, or when explicitly asked to verify that the app "launches standalone without Metro"; `DEV=1` / `PROD=1` only select the backend environment and don't change the Debug/Release build type.
- **Fast layer (pure JS bundle changes)**: when the device already has a Development Build, for changes to TS/TSX/JS, styles, copy, or pure TS logic in shared packages, run `make rn-start DEV=1` to start Metro only; saving triggers Fast Refresh. To re-run initialization, press `r` in Metro or restart the app — neither recompiles nor reinstalls.
- **Native layer**: when changing `apps/mobile/modules/*/ios/*.swift`, native dependencies, Pods, Expo Module config, permissions, scheme, background modes, `app.config.js`, or the Expo SDK, run `make rn DEV=1` for an incremental Debug build and overwrite install. When app config / config plugins / the native dependency graph are involved, first run `npx expo prebuild --platform ios --clean` in `apps/mobile`, then go back to the repo root and run `make rn DEV=1`.
- `TUNNEL=1` only makes Metro reachable over the public internet; it doesn't change the API address. When the phone and Mac are on different networks, use `make rn-start DEV=1 TUNNEL=1` or `make rn DEV=1 TUNNEL=1`.
- **Use `agent-device` by default for the iOS physical-device UI loop**: the first time, run `agent-device doctor` and `agent-device help workflow`, and treat the installed CLI's help as the source of truth for commands. Sequence: discover/open → `snapshot -i` → screenshot → press/fill/scroll (add `--settle` to every mutating action that supports it) → verify the settled diff → screenshot → close. Old refs are invalid after an action; only re-run `snapshot -i` when the settled diff doesn't give you the next target. Keep app data; don't use `reinstall` unless the user explicitly asks. Signing/profile blockers in the XCTest runner must be fixed at the root cause; if signing is correct but `agent-device` itself still fails on compatibility/session issues, troubleshoot with Appium's official `xcuitest-real-device-config` / `appium-troubleshooting`. UI automation via Expo MCP, `ios-debugger-agent`, and XcodeBuildMCP is for the Simulator only and cannot replace physical-device acceptance.

Local builds for desktop (Electron, apps/desktop) and RN (Expo, apps/mobile):
```bash
make macos                 # Electron desktop shell (renderer reuses apps/web) against this worktree's backend; DEV=1 fly dev, PROD=1 fly prod
make rn-start DEV=1        # Development Build already installed: start Metro + Fast Refresh only, no compile/reinstall
make rn DEV=1              # Debug build + overwrite install + Metro; SIM=1 for simulator, TUNNEL=1 to route Metro through ngrok
```
`make macos` = `npm run dev --workspace=@pin-ai/desktop` (electron-vite; `/api` is same-origin proxied to api, identical to web dev, zero CORS). `make rn-start` only runs `expo start --dev-client`; `make rn` does a Debug build/install via `expo run:ios`. Expo only prebuilds automatically when `ios/` doesn't exist; if it exists, config changes require an explicit `expo prebuild --clean`. Both commands map `VITE_*` to `EXPO_PUBLIC_*`. **apps/mobile has taken over iOS delivery** (dev/prod TestFlight both verified); apps/desktop runs locally only, and signing/notarization for packaging (`npm run package --workspace=@pin-ai/desktop` produces a dmg) is not configured.

Verification:
```bash
cd backend && uv run ruff check               # static checks (including trust-boundary banned-api)
cd backend && uv run ruff format --check      # format check (hard CI gate; a separate check from ruff check)
cd backend && uv run lint-imports             # import-linter (trust boundary + layering contracts)
cd backend && uv run mypy services libs       # type check (hard CI gate; incremental cache, reruns take seconds)
cd backend && uv run pytest                   # backend tests
cd internal-reward-dashboard && npm run type-check  # internal review app type check
cd internal-reward-dashboard && npm test            # internal review app unit tests
cd apps/web && npm run type-check && npm test       # zebra web app
cd apps/desktop && npm run type-check               # Electron desktop shell (types only)
cd apps/mobile && npm run type-check                # Expo RN (types only)
npm run check:packages                              # core/state/ui-kit boundary lint + types + unit tests
```

How to verify a change (pick the lightest option for the scope):
- Pure Python logic/types → `uv run ruff format --check` + `uv run ruff check` + `uv run lint-imports` + `uv run mypy services libs` + relevant `uv run pytest tests/<path>`
- Changed `backend/services/api/` → `make restart`, check `make logs-api` comes up + hit the target endpoint (ports are random; see `make urls`)
- Changed `backend/services/agent-engine/` → `make restart`, check `make logs-agent-engine` + send a message from the frontend
- Changed `apps/web/` → `cd apps/web && npm run dev` (port 3005) + `cd apps/web && npm run type-check && npm test`
- Changed `apps/desktop/` → `cd apps/desktop && npm run type-check` + `make macos` and check Electron starts
- Changed `apps/mobile/` → `cd apps/mobile && npm run type-check` + `make rn SIM=1` and click through in the simulator
- Changed `packages/` (shared layer) → `npm run check:packages` (core/state/ui-kit boundaries + types + unit tests); these packages are shared by multiple platforms, so also run the consumers' type-check depending on what changed (apps/web additionally runs unit tests; desktop / mobile only have type-check)
- Changed `internal-reward-dashboard/` → `npm run type-check` + `npm test` + `npm run dev -- --host 127.0.0.1 --port 3004`, and click through real flows in `/runs` / `/traces/:runId`
- Changed `/api/reward-dashboard/*` or the reward schema → `uv run ruff check .` + `uv run pytest tests/web/db/repositories/test_reward_repo.py tests/web/routes/test_reward_dashboard.py tests/web/services/test_trace_artifacts.py`
- Changed a db migration (new SQL file in `db/migrations/`) → run `make build-backend` **first, then** `make migrate`, and confirm the schema was applied. ⚠️ Migration SQL is baked into the image (Dockerfile `COPY db`); running only `make migrate` without rebuilding the image executes the **old** SQL and silently ignores the new file (it still prints "db-migrate complete" but the table isn't created)
- Touched the Daytona sandbox / pinai_sdk → `make restart` (automatically refreshes the `pinai-sandbox:local` snapshot with the latest SDK) + `make tunnel-up` + run a generate once and check that the sandbox can call back to web

**Test-fix loop limit**: on failure, read the logs and find the root cause before changing anything. If it still fails after **at most 2 rounds**, stop and report the symptoms, the fixes you tried, and your current suspicion to the user instead of continuing to force it.

**docker healthy ≠ working**: local containers coming up only means "the code can start". Flows that depend on Supabase tokens / real user data / Stripe webhooks / Composio OAuth can't be verified locally; say plainly "locally I only verified startup + types", and don't treat healthy containers as a pass.

**Mock data is OK for empty test DBs**: when tables like pai_events / pai_raw_* / cards / feedback are empty in the local DB, flows can't reach the branch you want to test. You may temporarily insert a minimal batch of mock rows (same user_id + required status / created_at fields) to get the test running, but: (1) local/dev only, never seed prod; (2) give mock data an identifiable marker (e.g. `note='__mock__'` or a fixed id prefix) for easy cleanup; (3) clean it up after testing, don't leave it in the shared dev DB to pollute others. Prefer a script (add a one-off seed under `backend/scripts/`) over hand-typed SQL.

**Don't worry about LLM token or Daytona costs**: just run the tests; don't shrink test cases, skip flows, or switch to mocks to "save calls". If it should run for real, run it for real.

Full command list: `make help`

## Tracing / Debugging (LangSmith)
Agent flows (chat / generator / evolve / rollup_semantic, etc.) report to [LangSmith](https://docs.langchain.com/langsmith) automatically via LangChain. To debug prompts, tool calls, tokens, or errors, pull traces directly with the LangSmith CLI instead of opening the web UI.

Install (one-time; skip if already installed):
```bash
curl -fsSL https://cli.langsmith.com/install.sh | sh   # installs to ~/.local/bin/langsmith
langsmith self-update                                  # upgrade
```

`LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` are already in `backend/.env` (decrypted by dotenvx from `.env.dev`; the dev project is `pinai-agents-dev`). Source it before local use:
```bash
set -a && . backend/.env && set +a
```

Common commands:
```bash
langsmith project list                                            # list tracing projects
langsmith trace list --project pinai-agents-dev --format pretty   # recent traces
langsmith run list --project pinai-agents-dev --run-type llm      # LLM calls
langsmith thread list --project pinai-agents-dev                  # chat, by thread
```
Output is JSON by default (handy for grep / jq); add `--format pretty` for a table. Full docs: <https://docs.langchain.com/langsmith/langsmith-cli>.

## Sandbox Debugging (Daytona)
Tools of the agent-engine process such as `python_exec` / browser run in [Daytona](https://www.daytona.io/docs/) cloud sandboxes. To check sandbox status, inspect snapshots, or run commands remotely, use the Daytona CLI instead of opening the web console.

Install (pick one; skip if already installed):
```bash
brew install daytonaio/cli/daytona                                            # officially recommended
# or download the darwin-arm64 binary to ~/.local/bin/daytona (fallback when brew fails)
curl -fsSL -o ~/.local/bin/daytona https://github.com/daytonaio/daytona/releases/latest/download/daytona-darwin-arm64 && chmod +x ~/.local/bin/daytona
```

`DAYTONA_API_KEY` is in `backend/.env` (decrypted by dotenvx from `.env.dev`). The first time, write it to a local profile:
```bash
set -a && . backend/.env && set +a
daytona login --api-key "$DAYTONA_API_KEY"   # one-time; profile is stored in ~/.daytona
```

Common commands:
```bash
daytona list                        # list all sandboxes (id / state / region / last activity)
daytona info <sandbox-id>           # details of one sandbox (resources, image, env)
daytona exec <sandbox-id> -- <cmd>  # run a command inside the sandbox
daytona snapshot list               # available snapshots (chat/generate fork from these by default)
```
Note: the `organization` subcommand is unavailable with API key auth (the CLI asks you to log in via the browser instead). Full docs: <https://www.daytona.io/docs/en/tools/cli/>.

Snapshot build scripts are in `backend/infra/daytona/`; CI (the `build-daytona-snapshot` job in `_deploy.yml`) refreshes each environment's `pinai-sandbox:{dev,test,production}` before every deploy. Local compose uses a separate `pinai-sandbox:local`: `make up` / `make restart` rebuilds it automatically when `packages/pinai_sdk` or the builder definition changes (`scripts/ensure_daytona_snapshot.sh`, based on a content hash); force a rebuild with `make daytona-snapshot-local`. Don't point local at the three CI names — they are deleted and recreated on every deploy.

## Changes & Deployment

**Branch model**: `main` is the only long-lived trunk and is protected by a ruleset — **direct pushes are forbidden**; every change goes through a PR + CI gate (`pinai-agents-checks` / `frontend-check` must be green) before it can merge. Cut feature branches from `main` and set the PR base to `main`. The old `main` is archived as `main-legacy`.

### Dev environment
After a push to `main`, deployment runs automatically based on what changed (CI workflow: `.github/workflows/deploy-dev.yml` → reuses `_deploy.yml`):
- Changed `backend/` → deploy the backend. **The dev backend uses three apps**: CI runs `_deploy.yml`'s `deploy-agents-split`, which syncs per-app scoped secrets and deploys `proactive-ai-{api,engine,reward}-dev` separately.
- Changed `apps/web/` or `packages/` (shared layer) → deploy apps/web (zebra); changes to `packages/` also trigger a frontend redeploy
- Changed `ops/litellm/` → deploy LiteLLM
- The Daytona snapshot is refreshed along with backend deploys

`apps/web` (zebra desktop web app) uses the unified deploy pipeline (the `deploy-web` job in `_deploy.yml` + the `web_toml` input): dev follows pushes to main, prod follows `v*` tags. The test environment doesn't deploy web for now (the caller doesn't pass `web_toml`, so the job is skipped automatically). On PRs, type-check for all three platforms (apps/web / apps/desktop / apps/mobile) + packages boundary lint/types/unit tests are all covered by the frontend-check in `ci.yml` (including a docker build check of the apps/web image).

**apps/desktop (Electron) only runs CI type-check and has no automated deployment** — local `make macos` only; electron-builder packaging/signing/notarization is still to do. **iOS TestFlight builds have moved to RN (apps/mobile)**: `build-rn-ios.yml` builds dev → TestFlight automatically on push to main (when `apps/mobile/` / `packages/` change); prod is dispatched manually (bundle id dev=`ai.pin.proactive.development`, prod=`ai.pin.proactive`, reusing the same pair of TestFlight app records from the Capacitor era; build numbers are 1000+run#, higher than the old track). Final entitlement state (2026-07-08): focus-status was dropped (the declaration was removed from `apps/mobile/app.config.js`; see the comments in that file for how to restore it); healthkit.background-delivery needs no action in the Apple developer portal — the HealthKit capability toggle there grants all three entitlement keys together, and the existing profiles were verified to cover it (CI builds were signed and uploaded). The workflow keeps only `Normalize entitlements` (normalizes aps-environment to production). Builds use a rolling ccache (check `clear_cache` on dispatch = clear the cache and rebuild): warm cache measured at ~10min (100% hits), cold cache ~30min (first run / cleared cache / Xcode upgrade); caches are isolated per branch. The Capacitor `build-ios.yml` was deleted along with the proactive-ai-frontend directory (2026-07-09); emergency rollback = dig the code out of git history.

`internal-reward-dashboard/` uses its own workflow `.github/workflows/internal-reward-dashboard-dev.yml`: PRs only run type-check / test / build; on push to `main` with changes in that directory, it deploys to the Fly dev app `proactive-ai-reward-dashboard-dev` (default URL `https://proactive-ai-reward-dashboard-dev.fly.dev`).

### Test environment
Manually trigger **Deploy Test** (`deploy-test.yml`) from the GitHub Actions page. It can deploy from any branch, and is used to run the full flow on fly before merging.

### Prod environment
Pushing a `v*` tag triggers **Deploy Prod** automatically (the tag is the source of truth for versions); it can also be triggered manually from the GitHub Actions page (select the `main` branch). The production environment is gated by a branch/tag policy (allows `v*` tags + `main`); manual approval isn't enabled yet and will be added later.

To release, use `scripts/release.sh v0.1.0`: after checking that you're on main, the working tree is clean, and it matches origin/main, the script creates and pushes a `v*` annotated tag, which triggers Deploy Prod above.

### Local deployment (fallback)
When CI/CD is unavailable, use the Makefile:
```bash
make deploy-pinai-dev       # backend three apps (api → engine → reward deployed in order) → dev
make deploy-pinai-prod      # backend three apps (api → engine → reward deployed in order) → prod
make deploy-reward-dashboard-dev  # internal reward dashboard → dev
make deploy-web-dev         # apps/web (zebra) → dev
make deploy-web-prod        # apps/web (zebra) → prod
make deploy-litellm-dev     # LiteLLM → dev
make deploy-litellm-prod    # LiteLLM → prod
```
All deploy commands have `env -u all_proxy -u http_proxy -u https_proxy` built in to avoid flyctl failures caused by a machine-wide proxy. See the corresponding targets in the `Makefile` for details.

## Production Hard Rules
- Production deploys go through GitHub Actions whenever possible (audit log; manual approval isn't enabled yet and will be added later).
- Never run database changes directly against production; migrations must run automatically as part of deployment.
- All production changes must go through code review + CI/CD.
- Fly secrets are synced via `backend/scripts/sync_fly_secrets.py`; **don't** run `flyctl secrets set` manually for a single key, or you'll bypass the trust boundary.

## Security Constraints (P0)
- **Trust boundary**: master credentials (`SUPABASE_SECRET_KEY` / `PAI_JWT_SIGNING_KEY` / `COMPOSIO_API_KEY` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `LITELLM_MASTER_KEY`) must never enter the agent-engine process environment. The single source of truth is `FORBIDDEN_ENVS` in `backend/services/agent-engine/src/agent_engine/trust_boundary.py`. After changing code related to agent-engine secret injection, confirm that all three defenses are still in place: the boot fail-fast in `agent_engine/asgi.py` (`ENGINE_TRUST_FAILFAST` gate), the Makefile `.env.chat` derivation, and `backend/scripts/sync_fly_secrets.py`. reward-dashboard (`pinai_reward_dashboard`) likewise holds no master credentials and has read-only product DB access.
- **Composio side effects are controlled**: side-effect classification uses a slug VERB heuristic (`pinai_contracts.composio_policy.is_side_effecting`, **fail-closed** — any non-read-only VERB counts as a side effect, and unknown tools are treated as side-effecting by default). read/query tools are allowed by default. For side-effecting slugs: **the sandbox code-mode path (`/api/agent/composio/{execute,multi_execute}`) rejects them outright with 403** (the sandbox has no interactive HITL, so they must go through native); **native `COMPOSIO_MULTI_EXECUTE_TOOL` requires human approval via agent-engine HITL** (`bypass_permissions` is derived server-side from `pai_user_settings.permission_mode`; the client cannot bypass it). Don't instruct agents to run side-effecting slugs like `GMAIL_SEND_EMAIL` in the sandbox.
- **Destructive browser actions force a takeover**: when the AI drives the browser and clicks an element whose accessible name matches a destructive keyword (pay/order/checkout/transfer/delete and their Chinese equivalents, etc.), the click is intercepted at runtime and control is forcibly handed back to the user for confirmation (`is_destructive_label` in `tools/browser/control_state.py`); this doesn't rely on the agent choosing to call `request_takeover`. The takeover happens even with bypass enabled (human in the loop for irreversible actions).
- **JWT signing isolation**: the api process signs per-run agent JWTs with an Ed25519 private key; agent-engine only holds the Ed25519 public key for verification (even if agent-engine leaks, new tokens can't be forged — the core security upgrade over an HS256 symmetric key). The private key only ever lives in the api process.
- **dotenvx private keys** (`.env.keys`) must never be checked in; get them from a team member.
- **Dev auth bypass is local-only**: the fixed `X-Dev-Auth` marker headers (`pinai-local-dev-user` / `pinai-dev-reviewer`) are honored only when `DEV_AUTH_BYPASS=1` **and** `DEPLOY_ENV=dev`. Only `docker-compose.yml` and `scripts/local_dev.sh` set the flag. Never put it in `backend/.env.*` (those feed fly secrets) or a fly toml — fly dev runs `DEPLOY_ENV=dev` on a public URL, and the marker values are in this public source.
- **User identifier convention**: `users.id` (BIGINT) is only for DB-internal FKs / RLS / `user_scoped_tx` / the `user_id` claim of internal JWTs, and **never leaves this system** — BIGSERIAL is an independent sequence in local docker / dev fly / prod fly, so values will collide across environments. Any external namespace (Composio user_id, LiteLLM user_id / key_alias, Supabase Storage path prefix, Stripe metadata primary key, other third-party SaaS) must use `users.supabase_user_id` (UUID NOT NULL, globally unique, never reused by Supabase, consistent across environments).

## Database Change Rules
- Write a new migration file in `backend/db/migrations/` for every schema change, named `NNN_<topic>.sql`; by convention, migrations touching pai schema tables get a `pai_` prefix (e.g. `015_pai_background_tasks.sql`), others just describe the topic (e.g. `001_users.sql` / `030_drop_legacy_user_columns.sql`).
- Once a migration file is merged to main, it must not be modified.
- Migrations are additive only (add tables, add columns); dropping/altering columns goes through expand-contract across two releases.
- Migrations use **yoyo** (pure SQL, forward-only); config is in `backend/yoyo.ini`, table is `pai_yoyo_migration_log`.
- dev/test/prod deploys run `yoyo apply` automatically via fly `release_command`; locally, `make migrate` runs everything in one go (including creating the litellm database). **Never connect to the prod DB manually to run SQL.**
- RLS policies are in `023_pai_rls.sql`; any new table holding user data must add an RLS policy at the same time.

## Gotchas
1. **The agent-engine process fails to start if it receives a master credential (and `ENGINE_TRUST_FAILFAST` is armed)**: the fail-fast assert in `agent_engine/asgi.py` exits immediately; the first log line tells you which forbidden var leaked in (**engine is a separate app with `ENGINE_TRUST_FAILFAST=1` armed in all three environments**).
2. **The Daytona sandbox must call back to api via a public URL**: compose's internal DNS doesn't resolve inside the cloud sandbox, so locally you must run `make tunnel-up` to start ngrok, otherwise `python_exec` fails with ConnectError.
3. **`make restart` only rebuilds api/agent-engine**: for the apps/web container use `make restart-web`; for LiteLLM config changes run `make up` for the full stack. restart uses `--no-deps`, so **it won't create services newly added to compose after merging main** (e.g. redis) — after pulling main, run `make up` once before going back to the restart loop, otherwise the new code depends on a service that never started (real incident: with redis missing, messages went unconsumed and the conversation page returned 500, hit on 2026-06-10).
4. **A machine-wide proxy makes `flyctl` fail**: the Makefile deploy commands have `env -u` built in, but if you run `flyctl deploy` directly you need to unset them yourself.
5. **`.env.chat` doesn't sync with `.env` automatically**: after editing `.env` by hand, only `make ensure-env-backend` re-derives `.env.chat`; a plain docker compose up won't trigger it. If needed, `make env-local` forces a re-decrypt.
6. **`apis/` / `pinai-openclaw/` / `miniapp/` are paths from the retired era**: if old scripts, old docs, or leftover local directories mention them, don't revive the old services; `backend/` is the source of truth for the backend. `proactive-ai-frontend/` and `capacitor-plugins/` were also retired and deleted on 2026-07-09; `packages/*` + `apps/*` are the source of truth for the frontend.
7. **`internal-reward-dashboard/` is a standalone internal tool**: don't mix dashboard pages into the user-facing product frontend (`apps/*`), and don't spread `/api/reward-dashboard/*` as if it were a regular product API. User confirm / dismiss / snooze / text feedback still writes to `pai_feedback_events`; only card open / score / reviewer score / casebook / trace go through the reward dashboard path.
8. **Containers have no fixed names (multi-worktree isolation)**: compose dropped `container_name`; each worktree is its own group (`pinai-<path hash>`, can `make up` concurrently without collisions). The old `docker exec pin-ai-xxx` no longer works; use `docker compose exec <service>` / `docker compose logs <service>` instead (run in the corresponding worktree directory to target that group automatically). Host ports are random, see `make urls`; `make up` doesn't start the tunnel automatically — when the generator needs it, run `make tunnel-up` (each worktree has its own `.ngrok.app` subdomain, concurrent, paid plan); RN on a physical device via `make rn` connects directly over the same WiFi LAN by default and doesn't need a tunnel.
9. **In the three-app setup, api→engine must use 6PN `.internal`, not flycast**: engine is a private app (no public IP), so `CHAT_INTERNAL_URL` must be `http://proactive-ai-engine-<env>.internal:8001` (6PN service discovery connects directly to the container port). **flycast is wrong** — flycast exposes the `[http_service]` external ports (80/443), not the container's 8001, so connecting to `flycast:8001` always fails with `ConnectError: No address`. Engine must also run with `auto_stop_machines='off'`: 6PN resolves **all** of the app's machines (including suspended ones), and a suspended host causes intermittent api→engine ConnectErrors. The frontend (web form) is the opposite — it goes through an nginx reverse proxy (`NGINX_UPSTREAM_URL` points at the api app's public URL, same-origin `/api/*`); only native/Electron packaged builds use the absolute `VITE_PIN_API_URL`. (Verified on dev on 2026-06-22; this was the root cause of a full chat outage.)

## Commit Conventions
- Conventional Commits: `feat(...)` / `fix(...)` / `chore(...)` / `docs(...)`.
- All commit messages and PR titles/descriptions must be written in English.
- Each commit focuses on one change.
- Before committing, at minimum run: `cd backend && uv run ruff format --check && uv run ruff check && uv run lint-imports && uv run mypy services libs` (for Python changes) + frontend checks by scope: for `packages/` run `npm run check:packages`; for a given platform run its `npm run type-check` (apps/web additionally runs `npm test`).

## Single Source of Truth for Rules
- `AGENTS.md` is the SSOT.
- `CLAUDE.md`, `GEMINI.md`, and `.cursor/rules/agents.mdc` all point to this file.
- Don't add fallbacks without permission.
- Write in plain, direct, restrained technical language. No corporate buzzwords ("empower", "closed loop", "leverage", "synergy", etc.). Prefer precise engineering terms and start from concrete facts.
