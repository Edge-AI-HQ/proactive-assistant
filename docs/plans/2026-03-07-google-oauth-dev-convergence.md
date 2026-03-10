# Google OAuth Dev Convergence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all local-testing-only logic from the Google OAuth branch, converge the code to a dev-ready miniapp flow at `https://pinclaw-api-dev.fly.dev/mini`, and document the removed local testing approach separately under `docs/`.

**Architecture:** Keep Google OAuth, miniapp management, Telegram confirmation, and runtime credential sync as product code. Remove local-only branches, scripts, proxy paths, and bypass behavior from shared code. Standardize the dev callback on `/mini/google/callback` and document a single runtime configuration pattern: platform-owned secrets, runtime-specific file materialization into `/app/data/<provider>/...`.

**Tech Stack:** TypeScript, Express, React/Vite miniapp, Fly Machines API, Docker provider, OpenClaw image build, Node test runner.

---

### Task 1: Document and isolate the local-testing-only work

**Files:**
- Create: `docs/google-oauth/local-testing-notes.md`
- Modify: `docs/plans/2026-03-07-google-oauth-dev-convergence.md`

**Step 1: Write the local-testing notes document**

Document:
- which local-only flows were introduced during development
- which code paths/scripts/proxies are being removed from shared code
- why they are being removed
- how to reproduce equivalent local testing later using temporary local patches instead of committed code

**Step 2: Capture the new runtime configuration convention**

Add a short section describing the recommended long-term pattern:
- platform stores raw config/secret source
- runtime sync layer materializes files into `/app/data/<provider>/...`
- product code consumes file paths only

### Task 2: Remove all local-testing-only code from shared product paths

**Files:**
- Modify: `apis/src/domain/common/config.ts`
- Modify: `apis/src/types/index.ts`
- Modify: `apis/src/domain/telegram-bot/commands.ts`
- Modify: `apis/src/domain/telegram-router/routes.ts`
- Modify: `apis/src/domain/container/providers/docker/provider.ts`
- Modify: `apis/src/server.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete if still present in branch diff: local-only scripts/docs/examples

**Step 1: Remove local flags and local bypass behavior**

Delete any shared-code support for:
- `APP_ENV=local`
- `ENABLE_LOCAL_*`
- local subscription bypass
- local Anthropic auth bootstrap
- any remaining local miniapp proxy/bootstrap behavior

**Step 2: Remove personal local tooling from shared repository diff**

Ensure this branch no longer introduces:
- local helper scripts
- local npm commands
- local-only env example files
- local-only AGENTS/process notes

**Step 3: Keep only product-safe startup/runtime behavior**

Ensure startup behavior only supports shared environments (dev/prod) and does not depend on local assumptions.

### Task 3: Converge Google OAuth and miniapp flow to the dev deployment contract

**Files:**
- Modify: `apis/src/controller/dashboard_routes.ts`
- Modify: `apis/src/controller/api_route_handler.ts`
- Modify: `apis/src/domain/google-oauth/miniapp.ts`
- Modify: `apis/src/domain/google-oauth/service.ts`
- Modify: `miniapp/src/App.tsx`
- Modify: `miniapp/src/components/AgentCard.tsx`
- Modify: `miniapp/src/components/ManageAgentDialog.tsx`
- Modify: `miniapp/src/components/CreateAgentFlow.tsx`
- Modify: `miniapp/src/components/TopStatus.tsx`
- Modify: `miniapp/src/googleRedirectState.ts`
- Modify: `miniapp/vite.config.ts`

**Step 1: Standardize miniapp URLs**

Converge all dev-facing URLs to:
- miniapp entry: `https://pinclaw-api-dev.fly.dev/mini`
- OAuth callback: `https://pinclaw-api-dev.fly.dev/mini/google/callback`

Remove obsolete references to:
- `/tg-subscription-mini`
- `/google/manage`
- legacy local callback/test routes

**Step 2: Keep only the product authorization loop**

Preserve this behavior:
- user connects Google from miniapp manage UI
- callback stores credentials
- callback syncs credentials to runtime
- callback redirects back to `/mini?...`
- bot proactively sends `google_connected`

**Step 3: Make the UI and route messages dev-ready**

Ensure miniapp and Telegram messages assume the shared dev deployment, not local browser/dev-only usage.

### Task 4: Preserve runtime credential sync and align it with the long-term config-file model

**Files:**
- Modify: `apis/src/domain/google-oauth/service.ts`
- Modify: `apis/src/domain/container/providers/fly/fly_client.ts`
- Modify: `apis/src/domain/container/providers/fly/assistant_machine.ts`
- Modify: `apis/src/domain/container/providers/fly/types.ts`
- Modify: `apis/src/domain/container/providers/shared/google_workspace_credentials.ts`
- Modify: `apis/src/domain/container/providers/shared/google_workspace_credentials.test.ts`
- Modify: `infra/container-manager/images/openclaw/Dockerfile`
- Modify: `infra/container-manager/images/openclaw/skills/gws/SKILL.md`
- Modify: `infra/container-manager/images/openclaw/skills/gws-gmail/SKILL.md`
- Modify: `infra/container-manager/images/openclaw/skills/gws-shared/SKILL.md`

**Step 1: Keep Docker and Fly sync paths, but only as product runtime behavior**

Do not remove Google credential sync. Instead, align it with the documented long-term model:
- platform-owned secret/config source
- runtime materialization into `/app/data/google/...`

**Step 2: Verify there is no local-only credential bootstrap left**

Docker/Fly runtime code may still write files, but only because product runtime needs them, not because local testing needs shortcuts.

**Step 3: Confirm image/runtime assumptions are documented**

Document the remaining deploy-time requirement: updated OpenClaw image digest must be rolled out for gws to exist in new containers.

### Task 5: Validate, summarize, and prepare a clean branch commit

**Files:**
- Modify: `docs/plans/2026-03-07-google-oauth-dev-convergence.md`

**Step 1: Run validation**

Run:
- `npm run type-check --workspace @pin-ai/apis`
- `npm run test --workspace @pin-ai/apis`
- `npm run type-check:miniapp`

Expected: all PASS.

**Step 2: Review final diff against `origin/develop`**

Confirm the branch diff contains only:
- product code for Google OAuth / miniapp / runtime sync / image updates
- the new docs note about removed local testing logic

Confirm it does not contain:
- local helper scripts
- local bypass flags
- local proxy/bootstrap logic
- personal environment workflow changes

**Step 3: Commit the converged branch state**

Create a new commit summarizing the convergence to dev-ready behavior, but do not merge to `develop` yet.

**Step 4: Report remaining external requirements**

List exactly what still must be configured outside code before dev rollout, including:
- OAuth client redirect URI
- dev secret/file injection method for Google client secret
- OpenClaw image build + digest rollout
- Fly runtime verification for credential materialization
