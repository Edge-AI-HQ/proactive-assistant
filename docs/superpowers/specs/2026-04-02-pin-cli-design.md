# Pin CLI Design

## Summary

We need a local-first CLI contract for proactive AI running inside the user's own OpenClaw container or local machine. The CLI must stay decoupled from OpenClaw internals and from `apis`. OpenClaw is only a host and caller. The CLI is the deterministic capability layer that agents and subagents can invoke for data access and state mutation.

Top-level command:

```bash
pin <domain> <command> [flags]
```

Initial domains:

- `profile`
- `ctx`
- `world`
- `feedback`
- `push`
- `agent`
- `sys`

## Goals

- Provide one stable local command surface for agents.
- Keep all CLI behavior deterministic and non-AI.
- Keep business data and tool contracts independent from OpenClaw runtime details.
- Support both the main agent loop and future subagents with the same command surface.
- Store user-specific state locally inside the container or machine.
- Make commands easy to test, replay, audit, and debug.

## Non-Goals

- No write-back dependency on `apis`.
- No hidden LLM calls inside CLI commands.
- No multi-tenant user model or `--user` flag.
- No OpenClaw-specific business abstractions in the CLI API.
- No attempt to solve agent planning inside the CLI itself.

## Context And Constraints

- The CLI will be installed into a single-user environment: a user's own container or local host.
- Because the environment is already single-user, commands should not require a user identifier.
- Agent reasoning remains in the agent. The CLI only provides deterministic operations.
- Subagents may call the same CLI for read and write operations.
- We expect some data to come from third-party systems such as composio-backed apps, RSS, or internal local state.

## Approaches Considered

### Option A: CLI with embedded AI features

The CLI would expose commands like natural-language search, summarize, infer, and brief, and internally call models.

Pros:

- Fewer steps for the caller.
- Looks convenient for agent prompts.

Cons:

- Hard to debug and replay.
- Results become non-deterministic.
- Cost and latency move into the tool layer.
- Testing becomes much weaker.
- Replacing the runtime or model provider becomes harder.

### Option B: Pure deterministic CLI with explicit agent-side reasoning

The CLI only exposes structured read/write/search/filter operations. Agents decide what to query, how to combine results, and when to write state back.

Pros:

- Stable and testable.
- Easy to audit.
- Keeps AI cost and behavior outside the CLI.
- Survives runtime changes cleanly.

Cons:

- Agents need a bit more prompt discipline.
- Some convenience must be built in the agent loop instead of the CLI.

### Option C: Thin HTTP wrapper around `apis`

The CLI would mostly proxy to remote endpoints.

Pros:

- Centralized data plane.
- Easier remote control.

Cons:

- Breaks the local-first requirement.
- Couples proactive AI too tightly to current backend topology.
- Creates availability and auth dependencies we explicitly want to avoid.

## Decision

Choose Option B.

`pin` is a deterministic local CLI. It performs structured reads, writes, filtering, normalization, provider access, and event logging. It does not do planning, summarization, inference, or LLM-backed search. Those remain in the agent or subagent logic.

## Architecture

The system is split into four layers.

### 1. CLI facade

- Stable shell entrypoint: `pin`
- Parses args and flags
- Validates command inputs
- Formats output
- Maps failures to standard exit codes

### 2. Domain layer

Each domain owns its own commands and data contracts.

- `profile`: structured profile, goals, constraints, routines, summary material, raw memories
- `ctx`: app context retrieval and search
- `world`: world context retrieval from feeds and sources
- `feedback`: explicit and implicit feedback events
- `push`: push history and delivery outcomes
- `agent`: orchestration helper domain for deterministic run artifacts only
- `sys`: health, migrations, reindex, export/import

### 3. Provider adapters

Adapters isolate external integrations from domain contracts.

- composio-backed apps
- rss readers
- future news providers
- future local importers

### 4. Local state layer

All persistent state remains local.

- SQLite for structured truth
- FTS and embedding index for retrieval support if needed
- JSONL append-only logs for events and audit
- file cache for raw snapshots or exports

## Command Principles

- Single binary: `pin`
- Domains are nouns, commands are verbs
- Default behavior is deterministic
- `--json` is supported everywhere for agent consumption
- Human-readable mode is allowed for manual debugging
- No `--user` flag
- Writes are explicit and separate from reads
- Commands should be composable and narrow

## Standard Output Contract

All `--json` responses should use the same envelope.

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "request_id": "req_123",
    "timestamp": "2026-04-02T12:00:00Z",
    "domain": "profile",
    "command": "get"
  },
  "error": null
}
```

Failure example:

```json
{
  "ok": false,
  "data": null,
  "meta": {
    "request_id": "req_124",
    "timestamp": "2026-04-02T12:00:01Z",
    "domain": "ctx",
    "command": "gmail search"
  },
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "missing --query"
  }
}
```

## Exit Codes

- `0`: success
- `2`: invalid arguments or usage
- `3`: missing configuration or unavailable provider
- `4`: not found
- `5`: conflict or invalid state transition
- `10`: transient provider failure
- `20`: unexpected internal failure

## Domain Design

### `pin profile`

Purpose:

- Maintain durable local user state that matters for proactive AI.

Structured entities:

- `identity`
- `preferences`
- `goals`
- `constraints`
- `routines`
- `summary`

Raw support entities:

- `memory`
- `observation`
- `profile_change_log`

Key commands:

```bash
pin profile get --json
pin profile summary get --json
pin profile preferences list --json
pin profile preferences set --key content_topics --value ai,startups,health --json
pin profile goals list --json
pin profile goals upsert --key career --title "find startup opportunities" --priority high --json
pin profile goals close --key career --json
pin profile constraints list --json
pin profile constraints add --kind quiet_hours --value 23:00-08:00 --json
pin profile routines list --json
pin profile memory add --kind observation --text "Frequently opens AI funding articles" --json
pin profile memory search --query "health routine" --json
```

Design notes:

- `profile` is a domain, not a separate binary.
- Structured state is the main read surface for agents.
- Raw memory exists for traceability and future consolidation logic, but consolidation is not a CLI AI feature.

### `pin ctx`

Purpose:

- Retrieve and search user app context through deterministic provider-specific operations.

Rules:

- App-first access pattern, not natural-language meta-search.
- The agent is responsible for deciding source, query, and time range.
- A thin aggregate search may exist later, but must remain rule-based and deterministic.

Key command groups:

```bash
pin ctx apps list --json
pin ctx apps status --json
pin ctx gmail search --query "flight OR hotel OR booking" --since 2026-04-01 --until 2026-04-30 --json
pin ctx gmail message get --id msg_123 --json
pin ctx calendar events list --from 2026-04-01 --to 2026-04-30 --json
pin ctx calendar event get --id evt_123 --json
pin ctx notion search --query "travel" --json
pin ctx contacts search --query "investor" --json
```

Design notes:

- No natural-language search like `pin ctx search "travel bookings this month"` in v1.
- The agent converts natural-language intent into deterministic queries.
- Provider-specific commands are easier to debug and more stable for prompts.

### `pin world`

Purpose:

- Retrieve and search world context with deterministic source access.

Key command groups:

```bash
pin world sources list --json
pin world rss feeds list --json
pin world rss fetch --feed techcrunch --limit 20 --json
pin world articles search --query "AI funding" --since 2026-04-01 --json
pin world article get --id art_123 --json
pin world cache status --json
```

Design notes:

- No `brief`, `digest`, or AI summary commands in CLI.
- The agent builds briefings from retrieved article sets.

### `pin feedback`

Purpose:

- Record user reactions and fetch historical feedback signals.

Key command groups:

```bash
pin feedback log --kind card_open --item-id card_123 --at 2026-04-02T10:00:00Z --json
pin feedback log --kind card_click --item-id card_123 --value open_article --json
pin feedback log --kind explicit_rating --item-id push_555 --value thumbs_up --json
pin feedback list --since 7d --json
pin feedback get --id fb_123 --json
```

Design notes:

- Separate explicit feedback from inferred feedback at the schema level.
- Events are append-only.

### `pin push`

Purpose:

- Record what was pushed, when, why, and what happened after delivery.

Key command groups:

```bash
pin push history --limit 50 --json
pin push get --id push_123 --json
pin push record --kind proactive_card --title "AI funding roundup" --ref article_set_77 --json
pin push outcome --id push_123 --status clicked --json
pin push find-similar --kind proactive_card --ref article_set_77 --since 14d --json
```

Design notes:

- This domain is essential for de-duplication and post-hoc evaluation.
- The CLI only stores and retrieves facts. The agent decides whether a candidate is too repetitive.

### `pin agent`

Purpose:

- Hold deterministic artifacts that support the agent loop without embedding agent intelligence into the CLI.

Allowed scope:

- store/retrieve run records
- persist planner inputs or outputs as files or records
- save evaluation artifacts

Possible commands:

```bash
pin agent runs list --json
pin agent runs get --id run_123 --json
pin agent artifacts put --kind intent_candidate --file ./intent.json --json
pin agent artifacts get --id art_123 --json
```

Design notes:

- `agent` is not the planner.
- `agent` is an artifact store and run ledger for deterministic support.

### `pin sys`

Purpose:

- Provide operational commands for local maintenance and debugging.

Key command groups:

```bash
pin sys doctor --json
pin sys schema version --json
pin sys migrate --json
pin sys reindex --domain profile --json
pin sys export --path ./pin-export --json
pin sys import --path ./pin-export --json
```

## Storage Model

Recommended local layout:

```text
~/.pin/
  data/
    profile.db
    events.db
    cache.db
  logs/
    feedback.jsonl
    push.jsonl
    agent-runs.jsonl
  cache/
    world/
    ctx/
  exports/
```

Inside containerized environments, the root may be remapped to an application data path, but the logical structure should remain the same.

Recommended truth split:

- `profile.db`: structured profile and profile-related raw memory
- `events.db`: feedback, push, agent run ledger
- `cache.db`: provider snapshots, article indexes, retrieval support tables

## Agent And Subagent Contract

The CLI is shared by:

- main proactive agent loop
- planner subagent
- intent generator subagent
- intent evaluator subagent

Expected usage pattern:

1. Agent reasons about what it needs.
2. Agent issues explicit deterministic `pin` commands.
3. Agent interprets results.
4. Agent decides whether to write state back through `pin`.

Examples:

- planner reads `pin profile get`, `pin push history`
- intent generator reads `pin ctx ...`, `pin world ...`
- evaluator reads `pin feedback list`, `pin push get`, `pin push find-similar`

This keeps all AI behavior in agent logic while preserving a single shared local tool contract.

## Security And Isolation

- Local state should contain only the minimum credentials required for enabled providers.
- Provider credentials should stay in local config or secret files, not in command output.
- `--json` output must never include raw secrets.
- Audit logs should record operation metadata, not sensitive token values.
- The CLI must remain usable even if OpenClaw is replaced with another host runtime.

## Testing Strategy

- Unit tests for arg parsing and output envelope
- Unit tests for each domain service
- Integration tests with SQLite temp directories
- Provider adapter contract tests with fixtures or mocks
- Golden JSON tests for agent-facing command output

## Rollout Plan

Phase 1:

- implement CLI skeleton
- implement output envelope and exit code policy
- implement `profile`, `feedback`, `push`, `sys`

Phase 2:

- implement `ctx` provider adapters for first app set
- implement `world` rss/article storage and retrieval

Phase 3:

- add `agent` artifact ledger
- add richer indexing and retrieval support

## Open Questions

- Which first-party app adapters ship in v1 after composio integration is wired
- Whether embeddings are needed in v1 or full-text search is enough initially
- How local credential bootstrap should work inside user-owned containers
- Whether `pin push find-similar` should remain simple metadata matching in v1

## Final Design Summary

`pin` is a single local deterministic CLI for proactive AI. It is hosted inside the user's own environment, decoupled from OpenClaw internals and from `apis`, and shared by all agents and subagents. The CLI exposes domain-oriented commands for local profile state, app context, world context, feedback, push history, agent artifacts, and system maintenance. All AI stays outside the CLI, in the calling agent logic.
