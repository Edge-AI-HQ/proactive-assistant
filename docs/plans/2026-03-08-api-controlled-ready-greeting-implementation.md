# API-Controlled Ready Greeting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current fallback-style ready greeting with an APIs-controlled deterministic greeting that includes PINAI tenure framing, language selection, and stable prompt wording.

**Architecture:** Keep the existing `notifyReady()` entrypoint in APIs, but move the first-user-facing greeting to a deterministic renderer in the onboarding domain. Resolve language, subscription state, and join date in APIs, render a stable template, and send it directly through the Telegram notify path. Preserve one-time greeting semantics through runtime metadata.

**Tech Stack:** Node.js, TypeScript, Express APIs, Postgres runtime metadata, Telegram Bot API proxy helpers, existing onboarding/profile lookup.

---

### Task 1: Add deterministic ready greeting renderer

**Files:**
- Modify: `apis/src/domain/onboarding/ready_greeting.ts`
- Test: `apis/src/domain/onboarding/ready_greeting.test.ts`

**Step 1: Write failing tests**
- Add tests for:
  - subscribed English greeting includes `HiPin`, join date, and day count
  - subscribed Chinese greeting includes `尊贵 PINAI 用户` and陪伴天数
  - unsubscribed greeting stays neutral
  - missing join date degrades safely

**Step 2: Run test to verify failure**
Run: `npm run test --workspace @pin-ai/apis -- ready_greeting`
Expected: FAIL because renderer helpers do not exist yet.

**Step 3: Write minimal implementation**
- Add pure helpers to build the rendered greeting from:
  - locale
  - subscription active
  - join date
  - tenure days
  - whether to ask for preferred name
- Keep output compact and Telegram-friendly.

**Step 4: Run test to verify pass**
Run: `npm run test --workspace @pin-ai/apis -- ready_greeting`
Expected: PASS.

### Task 2: Resolve greeting input data in APIs

**Files:**
- Modify: `apis/src/domain/onboarding/ready_greeting.ts`
- Modify: `apis/src/domain/common/infraRuntime.ts`
- Check: `apis/src/domain/telegram-bot/client.ts`

**Step 1: Write failing tests**
- Add tests for a new orchestration helper that resolves:
  - Telegram locale
  - subscription-active framing
  - join date / tenure
  - one-time send semantics

**Step 2: Run test to verify failure**
Run: `npm run test --workspace @pin-ai/apis -- ready_greeting`
Expected: FAIL because orchestration helper is missing.

**Step 3: Write minimal implementation**
- Reuse assistant owner telegram id lookup
- Resolve user join date from local user record first; fallback to legacy profile account creation if needed
- Determine subscription-active wording from APIs-side subscription state
- Build greeting text through the new renderer
- Send via `sendTelegramMessage()` directly from `notifyReady()`
- Stop treating the internal webhook trigger as the primary first greeting path

**Step 4: Run tests**
Run: `npm run test --workspace @pin-ai/apis -- ready_greeting`
Expected: PASS.

### Task 3: Preserve single-send behavior and remove brittle fallback dependence

**Files:**
- Modify: `apis/src/domain/common/infraRuntime.ts`
- Modify: `apis/src/domain/onboarding/ready_greeting.ts`
- Test: `apis/src/domain/onboarding/ready_greeting.test.ts`

**Step 1: Write failing tests**
- Add test that ready notification plus greeting only sends once when metadata already exists.

**Step 2: Run test to verify failure**
Run: `npm run test --workspace @pin-ai/apis -- ready_greeting`
Expected: FAIL.

**Step 3: Write minimal implementation**
- Keep `onboarding_ready_notified_at` and `onboarding_greeted_at` semantics
- Use APIs-controlled greeting as the main path
- Keep internal trigger code only if still needed for future personalization, but do not rely on it for first message delivery

**Step 4: Run tests**
Run: `npm run test --workspace @pin-ai/apis -- ready_greeting`
Expected: PASS.

### Task 4: Verify full APIs test and type-check

**Files:**
- No new files

**Step 1: Run unit tests**
Run: `npm run test --workspace @pin-ai/apis`
Expected: PASS.

**Step 2: Run type-check**
Run: `npm run type-check --workspace @pin-ai/apis`
Expected: PASS.

### Task 5: Commit

**Step 1: Commit worktree changes**
Run:
```bash
git add docs/plans/2026-03-08-api-controlled-ready-greeting-design.md \
        docs/plans/2026-03-08-api-controlled-ready-greeting-implementation.md \
        apis/src/domain/onboarding/ready_greeting.ts \
        apis/src/domain/onboarding/ready_greeting.test.ts \
        apis/src/domain/common/infraRuntime.ts

git commit -m "fix(onboarding): move ready greeting to apis"
```
Expected: commit created on `feat/google-miniapp-oauth-reset`.
