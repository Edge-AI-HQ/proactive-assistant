# Proactive AI (v2)

OpenClaw plugin that generates Intent Cards — AI-powered "next best action" recommendations based on user profile, goals, personal context, and world events.

## Prerequisites

- [OpenClaw](https://docs.openclaw.ai) installed and running
- [pin-cli](../pin-cli/) dependencies installed:

```bash
cd ../pin-cli && npm install
```

## Install

```bash
# Register the plugin (from repo root)
openclaw plugins install -l ./proactive-ai

# Restart gateway to load
openclaw gateway restart
```

## Usage

### Web UI

Open in browser:

```
http://127.0.0.1:<gateway-port>/proactive-ai
```

Find your gateway port:

```bash
grep '"port"' ~/.openclaw/openclaw.json
```

Click **"Generate Intent Cards"** to trigger the pipeline. Results stream in via SSE.

### Chat Command

In any OpenClaw chat session:

```
/generate
```

### API

```bash
# Health check
curl http://127.0.0.1:<port>/proactive-ai/api/health

# Trigger pipeline (SSE stream)
curl http://127.0.0.1:<port>/proactive-ai/api/generate

# Custom iteration count
curl http://127.0.0.1:<port>/proactive-ai/api/generate?iterations=5
```

## How It Works

The pipeline runs a **Planner -> Generator -> Evaluator** loop (default 3 iterations):

```
Planner   reads user profile/goals/context via pin-cli
          outputs: which Intent Cards to generate and why
              |
Generator takes the plan, gathers detailed data via pin-cli
          outputs: fully-formed Intent Cards
              |
Evaluator scores each card on 5 dimensions (0-10):
          relevance, actionability, whyNowClarity, novelty, decisionCompression
          pass threshold: overall >= 7.0
          outputs: scores + improvement feedback
              |
          feedback loops back to Planner for next iteration
```

Best cards across all iterations are returned to the frontend.

## Configuration

In `~/.openclaw/openclaw.json`, under plugin config:

| Key | Default | Description |
|-----|---------|-------------|
| `max_iterations` | `1` | Planner/Generator/Evaluator loop count |
| `agent_timeout_ms` | `300000` | Timeout per agent (5 min) |

## Project Structure

```
proactive-ai/
  index.ts                    # Plugin entry (tool + command + HTTP routes)
  openclaw.plugin.json        # Plugin manifest
  src/
    agents/
      planner.ts              # Planner agent system prompt
      generator.ts            # Generator agent system prompt
      evaluator.ts            # Evaluator agent system prompt
    pipeline/
      orchestrator.ts         # Planner->Generator->Evaluator loop
      pin-cli.ts              # Shell exec wrapper for `pin` commands
    types/
      intent-card.ts          # IntentCard, PipelineResult, etc.
      openclaw.d.ts           # OpenClaw SDK type stubs
    ui/
      index.html              # Placeholder frontend
```

## Pin CLI Integration

Agents access user data through the `pin` tool (registered on OpenClaw). The tool shells out to [pin-cli](../pin-cli/), which is auto-discovered:

1. `PIN_CLI_BIN` env var (explicit override)
2. `../pin-cli/src/bin.ts` via tsx (dev mode, no build needed)
3. `pin` on `$PATH` (global install)

The pin-cli skill reference ([`../pin-cli/SKILL.md`](../pin-cli/SKILL.md)) is auto-injected into all subagents via the `skills` field in `openclaw.plugin.json`.

## Development

```bash
# Type-check
cd proactive-ai && npx tsc --noEmit

# After code changes, restart gateway to reload
openclaw gateway restart
```

No build step needed — OpenClaw uses jiti for runtime TypeScript compilation.
