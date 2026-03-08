# API-Controlled Ready Greeting Design

## Goal
Replace the current assistant-triggered onboarding greeting with an APIs-controlled ready greeting that is deterministic, fast, and stable in dev/prod. The greeting must support `HiPin` treatment for subscribed users, mention join date and total days with PINAI, and ask for preferred form of address only when no explicit preference exists.

## Problem
The current first greeting depends on an internal private webhook into the assistant runtime. That path is sensitive to cold-start timing and sometimes fails or arrives late. The fallback greeting solves delivery but loses the intended PINAI-specific structure and membership context.

## Recommended Approach
APIs should become the primary sender of the first ready greeting. The message should be rendered from deterministic data already available to APIs:
- Telegram language (`language_code`), with English as default
- Active subscription state
- User join date (`users.created_at` / resolved account creation date)
- Telegram display name and any future explicit naming preference

The assistant-triggered onboarding greeting should no longer be the main path for the first message. If AI-based personalization is needed later, it should become an optional follow-up message, not the required first greeting.

## Data Rules
### Language
Priority:
1. persisted preferred locale (if present later)
2. Telegram `language_code`
3. default English

For this implementation:
- `zh*` => Chinese
- otherwise => English

### Membership framing
- If the user has an active subscription: use `HiPin` framing / respected PINAI member wording.
- If not active: use a neutral welcome, without premium framing.

### Tenure
- Use the user join date, not subscription start date.
- Compute total full days since join date.
- Mention both join date and total days where available.

### Preferred name question
- If an explicit preference field exists later, do not ask.
- In the current codebase, there is no stable explicit preference field wired into this flow.
- Therefore first implementation asks the naming question by default.
- Telegram `first_name` can be used as display context, but not as proof of explicit preference.

## Message Shape
### English
Block 1:
- short welcome line

Block 2:
- `HiPin` or neutral membership line
- join date
- total days with PINAI

Block 3:
- ask how to address the user
- ask whether responses should be concise or detailed
- close with `How can I help you today?`

### Chinese
Block 1:
- 简短欢迎

Block 2:
- 尊贵 PINAI 用户 / 中性欢迎
- 加入日期
- 陪伴天数

Block 3:
- 询问如何称呼
- 询问偏好简洁还是详细
- 以“今天想先处理什么？”收尾

## Architecture
1. Keep the existing ready notification path in `infraRuntime.ts`.
2. Replace the current dependency on `triggerReadyGreetingForAssistant()` as the primary greeting sender.
3. Add a deterministic greeting renderer in `apis/src/domain/onboarding/ready_greeting.ts` (or adjacent helper).
4. Resolve required user state before sending:
- assistant owner telegram user id
- user join date
- subscription active state
- telegram language
5. Send the rendered message directly through APIs Telegram send pipeline.
6. Keep `onboarding_greeted_at` metadata semantics so greeting remains single-send.
7. Remove cold-start retry dependence for the first greeting path.

## Error Handling
- If greeting render data is partially unavailable, degrade gracefully:
  - missing join date => omit exact date, keep generic welcome
  - missing language => default English
  - missing subscription => default neutral welcome
- If Telegram send fails, log and keep current ready flow intact.
- Do not block assistant ready notification on greeting send failure.

## Testing
- unit test English subscribed greeting with join date and day count
- unit test Chinese subscribed greeting
- unit test unsubscribed greeting uses neutral wording
- unit test missing join date degrades without crashing
- unit test ready flow sends API greeting instead of fallback internal trigger path

## Rollout
- Implement on the feature worktree only
- Verify with `npm run test --workspace @pin-ai/apis` and `npm run type-check --workspace @pin-ai/apis`
- Then merge back to `develop`
