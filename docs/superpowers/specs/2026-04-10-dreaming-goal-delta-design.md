# Dreaming Goal Delta Design

## Summary

Extend Dreaming so each run can propose structured goal changes in addition to `profileDelta`.

The new output is `goalDelta`: a reviewable set of goal mutations inferred from the same Dreaming input window. Like `profileDelta`, `goalDelta` is generated during the Dreaming run, persisted with the run record and artifacts, shown in Control, and only applied when the user explicitly clicks an apply button.

This keeps Dreaming useful as a secretary-like reflection layer without letting it silently rewrite the user's goals.

## Current State

Today Dreaming produces:

- `summary`
- `profileDelta`
- `candidateCards`
- `dream.md`

But it does not propose or apply any goal changes.

The current goals system already supports lightweight structured operations:

- `upsertGoal({ key, title, priority?, summary? })`
- `closeGoal(key)`

Goal records currently include:

- `key`
- `title`
- `priority`
- `summary`
- `status`
- `closedAt`
- `updatedAt`

This means Dreaming does not need a brand-new goals subsystem. It needs a reviewable delta format plus a safe apply flow.

## Problem

Dreaming often notices recurring obligations, projects, or stale goals, but today it can only write profile-level memory. That leaves an obvious gap:

- important recurring work may belong in goals, not only profile facts
- stale goals may remain active even when Dreaming has enough evidence to suggest closure
- newly emerging themes from personal data may never become tracked goals

At the same time, goals are more consequential than profile facts, so they should not be auto-mutated in v1.

## Approaches

### Option A: Auto-apply Dreaming goal updates

Dreaming would directly create, update, or close goals when the run completes.

Pros:

- lowest friction
- goals stay tightly synchronized with Dreaming output

Cons:

- too risky for v1
- hard to debug or trust
- accidental goal churn would be very visible to users

### Option B: Generate `goalDelta`, require explicit apply

Dreaming produces a structured goal diff, persists it with the run, and the user applies it manually from the run detail page.

Pros:

- consistent with existing `profileDelta` review model
- safe and auditable
- easy to test
- keeps Dreaming independent from core pipeline execution

Cons:

- one extra click
- users may ignore suggested goal updates

### Option C: Only generate natural-language goal suggestions

Dreaming would write a journal section like “you may want to create a goal for X” without any structured delta.

Pros:

- simplest implementation
- no write-path risk

Cons:

- weak product value
- hard to apply cleanly
- does not leverage the existing goals API

## Recommendation

Use **Option B**.

It preserves the core Dreaming model:

- collect signals
- reflect with model intelligence
- produce reviewable structured output
- apply explicitly

This gives users visible control while making Dreaming more useful than a journal-only feature.

## Scope

### In scope

- Dreaming produces `goalDelta`
- `goalDelta` is stored in DB and artifacts
- Control UI displays `goalDelta`
- user can explicitly apply `goalDelta`
- applied goal changes use existing goals write APIs

### Out of scope

- automatic goal mutation
- goal deletion
- editing arbitrary goal fields from Dreaming
- merging `goalDelta` into NOW feed
- per-row partial apply in v1

## Goal Delta Model

Add a new Dreaming output object:

```json
{
  "changes": [
    {
      "action": "create",
      "key": "follow-up-board-review",
      "reason": "Recent calendar and Gmail activity both indicate repeated board review prep work.",
      "before": null,
      "after": {
        "key": "follow-up-board-review",
        "title": "Prepare board review follow-ups",
        "priority": "high",
        "summary": "Track board review tasks and required follow-ups."
      }
    }
  ]
}
```

Each change has:

- `action`: `create | update | close`
- `key`
- `reason`
- `before`
- `after`

### Allowed fields in `after`

For v1, Dreaming may only propose:

- `title`
- `priority`
- `summary`
- `status`

### Disallowed fields

Dreaming must not directly author:

- `updatedAt`
- `closedAt`
- any future system-maintained timestamps

`key` is allowed only as the stable identifier for `create` and `update`. It is not user-editable through the diff UI.

## Dreaming Synthesis Changes

Update the Dreaming subagent contract so the model can return:

- `summary`
- `highlights`
- `candidateCards`
- `journalMarkdown`
- `interestTopics`
- `goalDelta`

The model should use goals as a higher-signal target than profile facts when it sees:

- repeated obligations across personal sources
- a new recurring objective that is large enough to track
- a currently active goal that looks completed or stale
- a current goal that needs a title, priority, or summary refresh

### Model rules

The prompt should explicitly say:

- do not create a goal for one-off noise
- prefer updating an existing goal over creating a near-duplicate
- only propose `close` when evidence is reasonably strong
- if uncertain, leave `goalDelta.changes` empty

## Persistence

### Database

Extend `proactive_dream_runs` with:

- `goal_delta_json`
- `goals_applied_at`

This should remain separate from:

- `profile_delta_json`
- `applied_at`

So profile and goals can be applied independently.

### Artifacts

Add:

- `goal-delta.json`

to each run artifact directory.

## Apply Semantics

Add a new action:

- `POST /proactive-ai/api/dreaming/runs/:id/apply-goals`

Apply behavior:

1. load the run
2. reject if the run is not `completed`
3. reject if the run is superseded
4. reject if `goals_applied_at` is already set
5. apply all `goalDelta.changes` atomically for the run
6. write `goals_applied_at`

### Mapping to existing profile goal APIs

- `create` -> `upsertGoal(key, title, priority, summary)`
- `update` -> `upsertGoal(key, title, priority, summary)`
- `close` -> `closeGoal(key)`

For `update`, the apply logic should preserve any existing goal fields that are outside the Dreaming-owned patch set.

## UI Changes

In Dream Run Detail, add a new section:

- `Goal Changes`

Each change card should show:

- action badge
- title or key
- short reason
- compact before/after snapshot

Add a new button:

- `Apply Goal Changes`

Button states:

- disabled if run not completed
- disabled if superseded
- disabled if already applied

Display labels:

- `Goals applied`
- `Goal changes pending`

The UI should keep `Apply Profile Changes` separate from `Apply Goal Changes`.

## Error Handling

If a `goalDelta` apply fails:

- do not mark `goals_applied_at`
- return a clear API error
- preserve the Dreaming run and artifact data

If a specific `update` targets a missing goal:

- treat it as a failed apply for v1
- do not silently convert it into `create`

This keeps behavior predictable and auditable.

## Testing

Add tests for:

- Dreaming run persistence with `goalDelta`
- artifact writing of `goal-delta.json`
- `apply-goals` success path
- `apply-goals` idempotency
- superseded run cannot apply goals
- `create`, `update`, and `close` mappings
- UI rendering of `Goal Changes`
- disabled button states for running/superseded/applied runs

## Rollout

Ship in two steps:

1. Dreaming can generate and display `goalDelta`
2. apply endpoint and UI button are enabled

This makes it easy to inspect real Dreaming goal proposals before allowing mutation.

## Open Questions Resolved

- Should Dreaming update goals automatically? No. v1 uses explicit apply.
- Should goal changes live inside `profileDelta`? No. Use a separate `goalDelta`.
- Which fields may Dreaming change? `title`, `priority`, `summary`, and goal lifecycle via `status`-driven close.

## Implementation Outline

1. extend Dreaming synthesis schema with `goalDelta`
2. persist `goal_delta_json` and `goals_applied_at`
3. write `goal-delta.json` artifact
4. add `apply-goals` service method and API route
5. add Control UI section and button
6. add tests
