# Internal Reward Dashboard

Dense internal tool for reviewing generated PIN AI cards, scoring reward,
building a casebook, and inspecting generation traces.

## Local Run

The app reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from
`../backend/.env` through Vite's `envDir`.

```bash
cd internal-reward-dashboard
npm install
npm run dev -- --host 127.0.0.1 --port 3004
```

This frontend expects both backend services to be running locally:

- `pinai_api` on `127.0.0.1:8000`
- `pinai_reward_dashboard` on `127.0.0.1:8002`

The simplest path is `make up` from the repo root. For lightweight local
debugging, start both uvicorn entrypoints manually.

The OAuth callback is normalized to `http://localhost:3004` for local loopback
hosts. Use `localhost:3004` as the Supabase redirect URL; otherwise Supabase
may fall back to the configured Fly site URL.

Local API calls use same-origin `/api/*` and Vite proxies them by prefix:

- `/api/reward-dashboard/*` → `http://127.0.0.1:8002` by default
- other `/api/*` → `http://127.0.0.1:8000` by default

Override with `VITE_REWARD_PROXY_TARGET` and `VITE_PIN_API_PROXY_TARGET`
in `backend/.env` if those processes run elsewhere.

Authentication uses Supabase Google OAuth. Use the same Google account as the
main PIN AI app.

## Verification

```bash
npm run type-check
npm test
npm run build
```

## Fly Dev Deploy

The dev Fly app is `proactive-ai-reward-dashboard-dev`:

```bash
make deploy-reward-dashboard-dev
```

The deployed URL is `https://proactive-ai-reward-dashboard-dev.fly.dev`.
Pushes to `main` that touch `internal-reward-dashboard/**` trigger
the standalone `.github/workflows/internal-reward-dashboard-dev.yml` workflow.
The workflow verifies the app, builds this app's Dockerfile, and serves the
static bundle with nginx. Current `fly.toml` still points both
`NGINX_UPSTREAM_URL` and `NGINX_REWARD_UPSTREAM_URL` at
`https://proactive-ai-agents-dev.fly.dev`, so the Fly dev frontend has not
yet been cut over to the split `proactive-ai-api-dev` +
`proactive-ai-reward-dev` backends.

Useful local checks after logging in:

- `/runs`: real generation runs, batch metrics, reviewed/unreviewed,
  user AHA/reviewer AHA/dead-card, trigger, and date filters.
- `/runs/:runId`: per-card evaluator feedback, sources, reviewer score,
  and casebook controls.
- `/casebook`: label/score/basket/intent/gap/date filters and markdown export.
- `/traces/:runId`: deterministic trace artifact with data-collector,
  planner, card-generator, and evaluator stages, or an explicit missing/failed
  reason.
