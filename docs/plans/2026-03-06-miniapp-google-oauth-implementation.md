# MiniApp Google OAuth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make miniapp the only user-facing Google OAuth entry, with callback returning to miniapp, refreshing Google status, and notifying the Telegram bot.

**Architecture:** Reuse existing Google OAuth service in `apis`, extend mini state with Google connection info, and wire miniapp manage UI to server-owned OAuth start/callback/disconnect routes. Keep token exchange and container sync server-side.

**Tech Stack:** Express, TypeScript, React, existing mini session cookies, existing Google OAuth service.

---

### Task 1: Extend mini state with Google connection data

**Files:**
- Modify: `apis/src/controller/dashboard_routes.ts`
- Test: `apis/src/controller/dashboard_routes.test.ts` or nearest existing dashboard route test file

**Step 1: Write the failing test**
Assert `/api/mini/state` payload includes `google.connected/email/scopes/updatedAt`.

**Step 2: Run test to verify it fails**
Run targeted `apis` test command.

**Step 3: Write minimal implementation**
Call `getGoogleConnectionStatus(telegramUserId)` inside `buildMiniStatePayload` and append `google` field.

**Step 4: Run test to verify it passes**
Run targeted test and `npm run type-check`.

**Step 5: Commit**
`git commit -m "feat(miniapp): expose google status in mini state"`

### Task 2: Add miniapp-specific Google routes

**Files:**
- Modify: `apis/src/controller/dashboard_routes.ts`
- Reuse: `apis/src/domain/google-oauth/service.ts`
- Test: route tests near dashboard routes

**Step 1: Write the failing test**
Cover:
- `GET /mini/google/start` requires mini session and redirects to Google
- `POST /api/mini/google/disconnect` disconnects for current mini session user
- `GET /mini/google/callback` redirects back to `/mini?google=connected`

**Step 2: Run test to verify it fails**
Run targeted tests.

**Step 3: Write minimal implementation**
Add routes in dashboard router and reuse Google OAuth service functions.

**Step 4: Run test to verify it passes**
Run targeted tests and `npm run type-check`.

**Step 5: Commit**
`git commit -m "feat(miniapp): add google oauth routes"`

### Task 3: Send bot confirmation from callback without blocking redirect

**Files:**
- Modify: `apis/src/domain/google-oauth/service.ts`
- Modify: `apis/src/domain/telegram-bot/commands.ts` if copy changes are needed
- Test: `apis/src/domain/google-oauth/*.test.ts`

**Step 1: Write the failing test**
Assert callback success path triggers bot confirmation payload construction and preserves redirect result.

**Step 2: Run test to verify it fails**
Run targeted tests.

**Step 3: Write minimal implementation**
On callback success, enqueue or directly send a bot message with mailbox + example prompts; do not fail OAuth if bot send fails.

**Step 4: Run test to verify it passes**
Run targeted tests and `npm run type-check`.

**Step 5: Commit**
`git commit -m "feat(google): send bot confirmation after mini callback"`

### Task 4: Wire miniapp state and query-param refresh behavior

**Files:**
- Modify: `miniapp/src/App.tsx`
- Test: `miniapp` component tests if present; otherwise add focused test file

**Step 1: Write the failing test**
Assert that `google=connected` triggers state reload and success toast.

**Step 2: Run test to verify it fails**
Run miniapp targeted test.

**Step 3: Write minimal implementation**
Extend `StatePayload`, parse query params, reload state, show success/error toast, clean URL state.

**Step 4: Run test to verify it passes**
Run targeted test and miniapp build/test command.

**Step 5: Commit**
`git commit -m "feat(miniapp): refresh google state after oauth return"`

### Task 5: Add Google management UI to Manage dialog

**Files:**
- Modify: `miniapp/src/components/ManageAgentDialog.tsx`
- Modify: `miniapp/src/components/AgentCard.tsx`
- Test: component tests for manage dialog

**Step 1: Write the failing test**
Assert disconnected state shows Connect button; connected state shows email and Disconnect button.

**Step 2: Run test to verify it fails**
Run targeted test.

**Step 3: Write minimal implementation**
Pass google state and handlers from `App` -> `AgentCard` -> `ManageAgentDialog`; implement connect/disconnect actions.

**Step 4: Run test to verify it passes**
Run targeted test and miniapp build.

**Step 5: Commit**
`git commit -m "feat(miniapp): add google management entry"`

### Task 6: Verify local end-to-end flow

**Files:**
- Modify if needed: `AGENTS.md`

**Step 1: Start local services**
Run `npm run local:up` in worktree and start miniapp locally.

**Step 2: Configure callback**
Point Google redirect URI to miniapp ngrok callback.

**Step 3: Run manual acceptance**
- Open miniapp in Telegram
- Connect Google
- Confirm redirect to miniapp manage page
- Confirm bot success message arrives
- Disconnect Google

**Step 4: Run final verification**
- `npm run type-check`
- `npm run test --workspace @pin-ai/apis`
- miniapp test/build command used during implementation

**Step 5: Commit**
`git commit -m "test(miniapp): verify google oauth local flow"`
