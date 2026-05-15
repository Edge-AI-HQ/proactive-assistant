# Internal Reward Dashboard

Dense internal tool for reviewing generated PIN AI cards, scoring reward,
building a casebook, and inspecting generation traces.

## Local Run

The app reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from
`../pinai-agents/.env` through Vite's `envDir`.

```bash
cd internal-reward-dashboard
npm install
npm run dev -- --host 127.0.0.1 --port 3004
```

The OAuth callback is normalized to `http://localhost:3004` for local loopback
hosts. Use `localhost:3004` as the Supabase redirect URL; otherwise Supabase
may fall back to the configured Fly site URL.

Local API calls use same-origin `/api/*` and Vite proxies them to
`http://127.0.0.1:8000` by default. Override with
`VITE_PIN_API_PROXY_TARGET` in `pinai-agents/.env` if the web process runs
elsewhere.

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
Pushes to `proactive-ai-v3` that touch `internal-reward-dashboard/**` trigger
the standalone `.github/workflows/internal-reward-dashboard-dev.yml` workflow.
The workflow verifies the app, builds this app's Dockerfile, and serves the
static bundle with nginx; runtime `/api/*` traffic is proxied to
`https://proactive-ai-agents-dev.fly.dev`.

Useful local checks after logging in:

- `/runs`: real generation runs, batch metrics, reviewed/unreviewed,
  user AHA/reviewer AHA/dead-card, trigger, and date filters.
- `/runs/:runId`: per-card evaluator feedback, sources, reviewer score,
  and casebook controls.
- `/casebook`: label/score/basket/intent/gap/date filters and markdown export.
- `/traces/:runId`: deterministic trace artifact with data-collector,
  planner, card-generator, and evaluator stages, or an explicit missing/failed
  reason.
