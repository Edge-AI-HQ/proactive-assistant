# fly app split — ready, NOT active

These toml files are the **deploy-layer landing** of the backend
re-architecture (docs/plans/2026-06-21-backend-rearchitecture.mdx §四/§十二).
They split the single `proactive-ai-agents-*` fly app (`[processes]` web+chat)
into independent fly apps so the trust boundary becomes physical at the deploy
layer too — the engine app simply never receives master credentials.

> ⚠️ **READY BUT NOT ACTIVE.** No CI caller activates this. By default
> `.github/workflows/_deploy.yml` still deploys the single app via
> `backend/fly.{dev,test,prod}.toml`. The split is gated behind an opt-in CI
> input (`agents_split`, default `false`) that no caller passes — see
> **Activation runbook** step 5. These files are templates + a runbook. **App
> names, flycast addresses, IP allocation and the reward-dashboard call path are
> PLACEHOLDERS** — verified by ops against the real fly apps before first deploy.
> Nothing here has run on fly; treat every value as a proposal, not a fact.
>
> What ships ready-inactive in this directory + repo:
> - `fly.{api,engine,reward}.{dev,prod,test}.toml` — all three apps × three envs.
> - `_deploy.yml` `deploy-agents-split` job — gated `if: inputs.agents_split`
>   (default false ⇒ skipped ⇒ current single-app `deploy-agents` runs unchanged).
> - `backend/db/migrations/107_pai_reward_role.sql` — the `pai_reward` scoped
>   role (additive; creating an unused role is harmless).
> - `internal-reward-dashboard` nginx `/api/reward-dashboard/*` prefix split,
>   defaulted to the single agents app (no behavior change until repointed).

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

Both scoped roles ship passwordless — `CREATE ROLE ... LOGIN` with no password,
so nobody can connect until an operator sets a password and puts the DSN in the
matching env var. The superuser `DATABASE_URL` (still on the api app) is what the
api's `release_command` uses to run migrations.

- **engine → `pai_chat`** (`024_pai_chat_role.sql`, already exists): full DML on
  the `langgraph` schema (its LangGraph checkpointer), `public` schema explicitly
  OFF-LIMITS (`REVOKE ALL ON SCHEMA public` ⇒ can't see `pai_*` / `users`).
  `ENGINE_DATABASE_URL` carries this role's DSN; `sync_fly_secrets.py
  --database-url-from ENGINE_DATABASE_URL` swaps it into `DATABASE_URL` for the
  engine app (agent-engine reads the standard `DATABASE_URL` var —
  `agent_engine/config.py`). The checkpointer creates its tables in a dedicated
  `langgraph` schema (search_path `langgraph,public`), so the public REVOKE does
  NOT break it — but **verify on first dev deploy** (see runbook landmine A).

- **reward → `pai_reward`** (`107_pai_reward_role.sql`, shipped here): NOT pure
  read-only. The grant set was derived by grepping the reward service's actual
  SQL + the two shared repos it imports (`pinai_db.repositories.{patterns,
  user_fingerprint}`, `pinai_db.raw_sources`) and validated against a throwaway
  Postgres. Summary:
  - **SELECT** product tables: `pai_pipeline_runs`, `pai_card_evaluations`,
    `pai_card_reward_events`, `pai_card_pattern_hits`, `pai_card_pattern_demos`,
    `pai_feedback_events`, `pai_world_signals`, plus the full personal-data
    snapshot set (`pai_profile` / `pai_user_settings` / `pai_goals` / `pai_memory`
    / `pai_skill_index` / `pai_personal_signals` / `pai_world_signal_user_view` /
    `pai_user_devices` / `pai_connector_labels` / `pai_connector_sync_cursors` /
    `pai_user_pattern_pref` / every `pai_raw_*` source table).
  - **INSERT/UPDATE/DELETE** (reward owns): `pai_card_casebook`,
    `pai_card_reward_events`, `pai_trace_artifacts`, `pai_card_pattern_demos`,
    `pai_user_pattern_pref`, `pai_user_intent_pref`.
  - **READ+WRITE** curate: `pai_card_patterns` (SELECT/INSERT/UPDATE/DELETE).
  - **`users`: SELECT + UPDATE, deliberately NO INSERT.** Trust-review decision:
    an internal read tool must not mint identities. The service's auth path
    (`auth.py:_upsert_user_by_supabase_id`) runs `INSERT … ON CONFLICT DO UPDATE`
    on first reviewer touch; without INSERT, an **un-seeded reviewer gets a 401**
    instead of being auto-provisioned. Reviewers must be pre-provisioned by the
    trusted api path / Supabase admin. (See runbook landmine B — this is a
    behavior change vs the superuser connection that today auto-creates the row.)
  - **RLS interaction**: `pai_reward` is not superuser, so it does NOT bypass
    RLS (`023_pai_rls.sql`). The migration does `GRANT service_role TO
    pai_reward` so the `TO service_role` fallback policy fires for the service's
    `service_tx` cross-user reads (reward review lists every user's cards).
    Verified: with the grant, `service_tx` (app.user_id unset) sees all users'
    rows; `user_scoped_tx` still scopes to one user; and a table with no GRANT is
    still denied (service_role membership widens RLS row-visibility only, never
    table reach). **Without** the grant, cross-user reads would silently return
    zero rows.

## Activation runbook (ops, per environment)

Each step is tagged **[ops]** (run by an operator against fly / Supabase / the
dotenvx env files) or **[code]** (already shipped in the repo — referenced, not
re-done). Run for one env (`dev` first) end-to-end before the next.

1. **[ops]** Create the three apps:
   `flyctl apps create proactive-ai-{api,engine,reward}-<env>`.
2. **[ops]** Allocate IPs:
   - api: a public IP (`flyctl ips allocate-v4 --shared` + `allocate-v6` as you
     do for the single app today).
   - engine: **none public** — `flyctl ips allocate-v6 --private -a
     proactive-ai-engine-<env>` (flycast-only; the LLM loop must be unreachable
     from the internet).
   - reward: per the call-path decision. Recommended **flycast-only** (private
     v6), because the `internal-reward-dashboard` nginx is a same-origin proxy,
     not a browser-direct call. If you choose browser-direct instead, give it a
     public IP and keep `force_https` in `fly.reward.<env>.toml`.
3. **[ops]** Produce scoped DSNs in Supabase (set passwords on the passwordless
   roles), then add all three to the dotenvx env file. The keys do NOT exist yet
   (only plaintext `DATABASE_URL` is encrypted there today) — `sync_fly_secrets.py`
   `--database-url-from` hard-exits if its key is absent, so this is fail-closed:
   ```
   # Set a password on each role (run once, via Supabase SQL editor or psql as
   # the superuser — NOT against prod by hand; use the api release path or a
   # one-off):
   #   ALTER ROLE pai_chat   PASSWORD '<engine-pw>';
   #   ALTER ROLE pai_reward PASSWORD '<reward-pw>';
   # Then dotenvx-set the DSNs (values are encrypted at rest — never commit plaintext):
   npx @dotenvx/dotenvx set ENGINE_DATABASE_URL "postgresql://pai_chat:<engine-pw>@<host>:<port>/<db>"   -f backend/.env.<env>
   npx @dotenvx/dotenvx set REWARD_DATABASE_URL "postgresql://pai_reward:<reward-pw>@<host>:<port>/<db>" -f backend/.env.<env>
   ```
   `APP_DATABASE_URL` (the api app's own scoped role, `pai_app`) is **P0-2's**
   concern (migration 104, PR #202) — only set it + add api's
   `--database-url-from APP_DATABASE_URL` once P0-2 has landed. Until then the api
   app keeps the superuser `DATABASE_URL` (it needs it for `release_command`
   anyway).
4. **[code]** Migration `107_pai_reward_role.sql` creates `pai_reward` + its
   grants; it runs automatically with the api app's first deploy `release_command`
   (step 6). Nothing to do here — listed so the order is explicit (the role must
   exist before reward connects).
5. **[ops]** Activate the split CI job. The single-app `deploy-agents` is gated
   `!inputs.agents_split`; the split `deploy-agents-split` is gated
   `inputs.agents_split`. Flip it by passing `agents_split: true` + the six split
   inputs to `_deploy.yml` from the env's caller (`deploy-<env>.yml`), e.g.:
   ```yaml
   with:
     agents_split: true
     api_app:    proactive-ai-api-<env>
     engine_app: proactive-ai-engine-<env>
     reward_app: proactive-ai-reward-<env>
     api_toml:    deploy/fly-split/fly.api.<env>.toml
     engine_toml: deploy/fly-split/fly.engine.<env>.toml
     reward_toml: deploy/fly-split/fly.reward.<env>.toml
   ```
   The split job runs three per-app `sync_fly_secrets.py` (api full set; engine +
   reward `--exclude-master --database-url-from {ENGINE,REWARD}_DATABASE_URL`)
   then `flyctl deploy` api → engine → reward (api first so its migration runs).
   `ENGINE_TRUST_FAILFAST=1` is already set in `fly.engine.<env>.toml`'s `[env]`,
   so the boot guard arms on first engine deploy — if any master credential leaks
   through, the engine crashes at boot (check the first log line). For a one-off
   verification before editing the caller, dispatch with these inputs manually.
6. **[ops]** First deploy via the activated job (or, to deploy out-of-band:
   `cd backend && flyctl deploy --config deploy/fly-split/fly.api.<env>.toml`
   first — runs migrations incl. 107 — then `fly.engine.<env>.toml` and
   `fly.reward.<env>.toml`).
7. **[ops]** Cut traffic:
   - Frontend `/api/*` → the new api app (point `proactive-ai-frontend` nginx /
     fly toml `VITE_PIN_API_URL` / web `/api` upstream at `proactive-ai-api-<env>`).
   - `internal-reward-dashboard`: in its `fly.toml`, set
     `NGINX_REWARD_UPSTREAM_URL` to the reward app
     (`https://proactive-ai-reward-<env>.fly.dev`, or its `.flycast` if
     flycast-only) and `NGINX_UPSTREAM_URL` to the api app, then redeploy that app
     (`internal-reward-dashboard-dev.yml`). The nginx `/api/reward-dashboard/*`
     vs `/api/*` longest-prefix split is already in the Dockerfile; this is the
     first time reward-dashboard endpoints leave the single agents app (they were
     404 on fly before — the reward backend was never mounted there; the split
     reward app serves `pinai_reward_dashboard.asgi:app` natively).
   - Verify `CHAT_INTERNAL_URL` in `fly.api.<env>.toml` resolves the engine over
     flycast (`fly ssh console -a proactive-ai-api-<env> -C 'curl -sf
     http://proactive-ai-engine-<env>.flycast:8001/health'`).
8. **[ops]** Verify the trust boundary actually holds (the whole point):
   ```
   # engine must hold ZERO master credentials — expect 0:
   fly ssh console -a proactive-ai-engine-<env> -C \
     'sh -c "env | grep -cE \"^(SUPABASE_SECRET_KEY|PAI_JWT_SIGNING_KEY|COMPOSIO_API_KEY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|LITELLM_MASTER_KEY|APNS_AUTH_KEY)=\""'
   # same check on reward — expect 0.
   # engine boot guard armed: grep the boot logs for the failfast assertion line
   # (it crashes if a forbidden var slipped through).
   fly logs -a proactive-ai-engine-<env> | grep -i 'trust\|forbidden\|failfast'
   # scoped DSNs can't see public schema's pai_*: connect with the engine DSN and
   # confirm `SELECT 1 FROM pai_memory` is permission-denied; with the reward DSN
   # confirm a non-granted table (e.g. pai_jti_revocations) is permission-denied
   # but pai_card_casebook is reachable.
   ```
9. **[ops]** Retire the single app once the split is healthy:
   `flyctl apps destroy proactive-ai-agents-<env>` (after confirming no traffic
   and snapshots/secrets are no longer needed). Revert is just flipping
   `agents_split` back to false and redeploying the single app — keep
   `fly.<env>.toml` until you're confident.

Until step 5 flips `agents_split`, **CI is byte-for-byte unchanged**: the
single-app `deploy-agents` job runs and `deploy-agents-split` is skipped.

### Landmines (check on first dev deploy)

- **A — engine `pai_chat` + `REVOKE ALL ON SCHEMA public` (024):** the engine's
  `AsyncPostgresSaver.setup()` (`agent_engine/harness/checkpoint.py`) creates
  checkpoint tables in the `langgraph` schema and connects with search_path
  `langgraph,public`. The `024` REVOKE on `public` should be fine (tables don't
  live there), but the search_path still lists `public` for builtin function
  resolution. If engine boot fails on first dev deploy with a permission error
  touching `public`, the fix is the minimal `GRANT USAGE ON SCHEMA public TO
  pai_chat;` (USAGE only — still no table grants, so `pai_*` stay invisible).
  Test in dev before prod.
- **B — reward `users` 401 for un-seeded reviewers (107):** because `pai_reward`
  lacks `users` INSERT, a reviewer whose `users` row was never created by the
  trusted api path will get a 401 from the dashboard rather than auto-provision.
  Seed reviewer rows ahead of cutover (or via the api). This is the deliberate
  trust-review posture, not a bug.

## prod / test

`fly.{api,engine,reward}.{prod,test}.toml` are already in this directory,
copied from the `*.dev.toml` with: `app` → `…-{prod,test}`, all `…-dev` URLs →
the env's, `DEPLOY_ENV` (`production` / `test`), `PINAI_DAYTONA_SNAPSHOT`
(`pinai-sandbox:{production,test}`), and VM sizes aligned to the single-app
`fly.{prod,test}.toml` (prod api = 4gb / engine = 2gb / reward = 1gb; test api =
2gb / engine = 1gb / reward = 1gb). They are templates like the dev set — verify
app names, flycast addresses and IPs against the real fly apps before the first
deploy in each env. Do not activate prod/test before the dev split is proven on
fly.
