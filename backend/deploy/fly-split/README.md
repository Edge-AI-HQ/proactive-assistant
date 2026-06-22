# fly app split — ready, NOT active

These toml files are the **deploy-layer landing** of the backend
re-architecture (docs/plans/2026-06-21-backend-rearchitecture.mdx §四/§十二).
They split the single `proactive-ai-agents-*` fly app (`[processes]` web+chat)
into independent fly apps so the trust boundary becomes physical at the deploy
layer too — the engine app simply never receives master credentials.

> ⚠️ **NOT referenced by any CI workflow.** `.github/workflows/_deploy.yml`
> still deploys the single app via `backend/fly.{dev,test,prod}.toml`.
> These files are templates + a runbook. **App names, flycast addresses, IP
> allocation and the reward-dashboard call path are PLACEHOLDERS** — verified by
> ops against the real fly apps before first deploy. Nothing here has run on
> fly; treat every value as a proposal, not a fact.

## Why

Single fly app can't do per-process-group secrets (flyctl 0.4.48 has no such
flag — see `scripts/sync_fly_secrets.py`). So today the `chat` process group
sees the same env as `web`, including master credentials; the engine boot guard
(`agent-engine/asgi.py`, gated by `ENGINE_TRUST_FAILFAST`) stays OFF because
turning it on would crash boot. Separate apps fix this: per-app secrets +
`--exclude-master` keep master credentials out of the engine/reward apps, and
the boot guard arms.

## Target topology (dev)

| app (placeholder)            | process                              | exposure                  | secrets |
|------------------------------|--------------------------------------|---------------------------|---------|
| `proactive-ai-api-dev`       | `uvicorn pinai_api.asgi:app`         | public anycast :8000      | full set (trusted) |
| `proactive-ai-engine-dev`    | `uvicorn agent_engine.asgi:app`| flycast-only :8001        | `--exclude-master` + `ENGINE_DATABASE_URL` (pai_chat scoped DSN) |
| `proactive-ai-reward-dev`    | `uvicorn pinai_reward_dashboard.asgi:app` | (call path TBD) :8002 | `--exclude-master` + `REWARD_DATABASE_URL` (scoped role DSN — see DB roles) |

- **api → engine**: engine has NO public IP; api reaches it over fly's private
  network (`*.flycast`). `CHAT_INTERNAL_URL` in the api toml points at the
  engine app's flycast address — verify the exact name.
- **engine → api**: callbacks (sandbox `PAI_API_URL`, internal calls) go to the
  api app's public URL, same as today.
- **reward-dashboard call path**: the `internal-reward-dashboard` Vite app
  currently proxies `/api/*` to the single agents app. After the split it must
  point at `proactive-ai-reward-dev`. Decide public vs flycast for that app
  based on how the Vite app is served (nginx same-origin proxy ⇒ can be private;
  direct browser HTTPS ⇒ must be public). **TBD — confirm before activating.**

## Migrations

Only the **api** app runs `release_command` (yoyo apply) — it holds the
superuser `DATABASE_URL`. The engine and reward apps must NOT run migrations
(their scoped DSNs can't, by design). Their toml have no `[deploy]
release_command`.

## DB roles

- **engine → `pai_chat`** (`024_pai_chat_role.sql`, already exists): full DML
  on the `langgraph` schema (its checkpointer), `public` schema explicitly
  OFF-LIMITS (can't see `pai_*` / `users`). `ENGINE_DATABASE_URL` is this role's
  DSN — operators set its password + connection URL (the role ships passwordless).
- **reward → a new scoped role** (NOT pure read-only; NOT yet written): the
  reward-dashboard *reads* product tables (`pai_card_*` / `pai_feedback_events`
  / `pai_pipeline_runs` / `pai_personal_signals`) but *writes its own*
  (`pai_card_casebook`, `pai_card_reward_events`, `pai_trace_artifacts`),
  *curates* the shared `pai_card_patterns` (read+write), and first-touch
  *upserts* `users` (auth). The exact grants must be designed from this
  read/write set and shipped as a migration **when activating** — deliberately
  not pre-written here: a role migration is immutable once merged, and the
  `users` INSERT grant in particular needs a trust review first (should an
  internal read tool write `users`, or should its auth assume the row exists
  and 401 otherwise?).

## Activation runbook (ops, per environment)

1. `flyctl apps create proactive-ai-api-<env>` (+ `-engine-`, `-reward-`).
2. Allocate IPs: api gets a public IP; engine gets **none** (flycast-only);
   reward per the call-path decision above.
3. Add the scoped DSNs to the dotenvx env file: `ENGINE_DATABASE_URL` (the
   `pai_chat` role from `024_pai_chat_role.sql` — already exists) and
   `REWARD_DATABASE_URL` (a new role — see **DB roles** below; design + ship
   its migration when activating, it does NOT exist yet).
4. Sync secrets per app:
   ```
   python scripts/sync_fly_secrets.py --app proactive-ai-api-<env>    --env-file .env.<env>
   python scripts/sync_fly_secrets.py --app proactive-ai-engine-<env> --env-file .env.<env> \
       --exclude-master --database-url-from ENGINE_DATABASE_URL
   python scripts/sync_fly_secrets.py --app proactive-ai-reward-<env> --env-file .env.<env> \
       --exclude-master --database-url-from REWARD_DATABASE_URL
   ```
5. Set `ENGINE_TRUST_FAILFAST=1` on the engine app (arms the boot guard).
6. First deploy each (`flyctl deploy --config deploy/fly-split/fly.<svc>.<env>.toml`),
   api first (runs migrations), then engine + reward.
7. Cut frontend `/api` traffic + `internal-reward-dashboard` proxy to the new
   api / reward apps; verify `CHAT_INTERNAL_URL` reaches the engine.
8. Update `.github/workflows/_deploy.yml` `deploy-agents` to deploy all three
   (per-app sync + per-app `flyctl deploy`), then retire the single app.

Only step 8 changes CI — until then the single app keeps deploying unchanged.

## prod

Copy the `*.dev.toml` here to `*.prod.toml`, then change: `app` →
`proactive-ai-{api,engine,reward}-prod`, all `*-dev.fly.dev` / `*-dev.flycast`
URLs → `-prod`, `DEPLOY_ENV='prod'`, `PINAI_DAYTONA_SNAPSHOT='pinai-sandbox:production'`,
and bump `min_machines_running` to the prod baseline. Do NOT pre-create prod
toml before the dev split is verified on fly.
